import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import xml2js from 'xml2js';
import path from 'path';
import { fileURLToPath } from 'url';
import WebTorrent from 'webtorrent';
import mime from 'mime-types';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import zlib from 'zlib';
import crypto from 'crypto';

// This function will be imported and called by main.js
export function startServer(userDataPath) {
    // Recursive directory deletion function
    const deleteFolderRecursive = async (directoryPath) => {
        if (fs.existsSync(directoryPath)) {
            for (const file of fs.readdirSync(directoryPath)) {
                const curPath = path.join(directoryPath, file);
                if (fs.lstatSync(curPath).isDirectory()) { // recurse
                    await deleteFolderRecursive(curPath);
                } else { // delete file
                    fs.unlinkSync(curPath);
                }
            }
            fs.rmdirSync(directoryPath);
            console.log(`Successfully deleted directory: ${directoryPath}`);
        }
    };

    const app = express();
    const PORT = 3000;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    app.use(cors());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.json());
    // Simple settings storage in userData
    const SETTINGS_PATH = path.join(userDataPath, 'settings.json');
    function readSettings() {
        try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return { useTorrentless: false }; }
    }
    function writeSettings(obj) {
        try { fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
    }

    app.get('/api/settings', (req, res) => {
        const s = readSettings();
        res.json({ useTorrentless: !!s.useTorrentless });
    });
    app.post('/api/settings', (req, res) => {
        const s = readSettings();
        const next = { ...s, useTorrentless: !!req.body.useTorrentless };
        const ok = writeSettings(next);
        if (ok) return res.json({ success: true, settings: next });
        return res.status(500).json({ success: false, error: 'Failed to save settings' });
    });

    // Temporary subtitles storage
    const SUB_TMP_DIR = path.join(os.tmpdir(), 'playtorrio_subs');
    const ensureSubsDir = () => { try { fs.mkdirSync(SUB_TMP_DIR, { recursive: true }); } catch {} };
    ensureSubsDir();
    // Guard: recreate folder if it was cleared just before a request
    app.use('/subtitles', (req, res, next) => { ensureSubsDir(); next(); });
    // Serve temp subtitles under /subtitles/*.ext with explicit content types
    app.use('/subtitles', express.static(SUB_TMP_DIR, {
        fallthrough: true,
        setHeaders: (res, filePath) => {
            const lower = filePath.toLowerCase();
            if (lower.endsWith('.vtt')) {
                res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            } else if (lower.endsWith('.srt')) {
                // Most browsers expect WebVTT, but we convert to .vtt; keep for completeness
                res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
            }
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        }
    }));

    // API Key Management
    let API_KEY = '';
    let lastKeyPath = '';

    // Determine where to read/write the root-level key file
    const installDir = path.dirname(process.execPath); // In packaged builds, next to the app exe
    const devRoot = __dirname; // In dev, server.mjs resides at project root

    // Prefer userData in installed builds to avoid permission issues; keep other locations for backward-compat
    const resolveReadCandidates = () => [
        path.join(userDataPath, 'jackett_api_key.json'), // primary location for installed app
        path.join(installDir, 'jackett_api_key.json'),    // legacy next to exe (when per-user installs were writable)
        path.join(devRoot, 'jackett_api_key.json'),       // project root (dev)
        path.join(process.cwd(), 'jackett_api_key.json')  // current working dir (fallback)
    ];

    const rootKeyExists = () => {
        const candidates = [
            path.join(userDataPath, 'jackett_api_key.json'),
            path.join(installDir, 'jackett_api_key.json'),
            path.join(devRoot, 'jackett_api_key.json'),
            path.join(process.cwd(), 'jackett_api_key.json')
        ];
        return candidates.some(p => {
            try { return fs.existsSync(p); } catch { return false; }
        });
    };

    const isPackagedByExe = (() => {
        try {
            const exe = path.basename(process.execPath).toLowerCase();
            return !(exe === 'electron.exe' || exe === 'node.exe' || exe === 'node');
        } catch {
            return false;
        }
    })();

    const resolveWritePath = () => {
        // In installed app, always write to userData to ensure we have permissions and resilience across updates
        return isPackagedByExe
            ? path.join(userDataPath, 'jackett_api_key.json')
            : path.join(devRoot, 'jackett_api_key.json');
    };

    function loadAPIKey() {
        try {
            // Always try to read from a root-level file if present
            for (const candidate of resolveReadCandidates()) {
                try {
                    if (fs.existsSync(candidate)) {
                        const raw = fs.readFileSync(candidate, 'utf8');
                        const key = JSON.parse(raw).apiKey || '';
                        if (key) {
                            API_KEY = key;
                            lastKeyPath = candidate;
                            // Log only the source path (not the key)
                            console.log(`✅ API Key loaded from ${candidate}`);
                            return true;
                        }
                    }
                } catch (e) {
                    // keep trying other candidates
                }
            }

            // No root-level file found; clear cached key
            API_KEY = '';
        } catch (error) {
            console.error('Error loading API key:', error);
        }
        return false;
    }

    function saveAPIKey(apiKey) {
        const payload = JSON.stringify({ apiKey }, null, 2);
        // Primary: write to userData in installed builds, dev root in dev
        try {
            const primary = resolveWritePath();
            const primaryDir = path.dirname(primary);
            fs.mkdirSync(primaryDir, { recursive: true });
            fs.writeFileSync(primary, payload);
            API_KEY = apiKey;
            lastKeyPath = primary;
            console.log(`✅ API Key saved to ${primary}`);
            return true;
        } catch (err) {
            console.warn('⚠️ Failed to write API key to primary location:', err?.message || err);
        }

        // Secondary: attempt next to the exe for legacy compatibility when writable
        try {
            const legacy = path.join(installDir, 'jackett_api_key.json');
            fs.writeFileSync(legacy, payload);
            API_KEY = apiKey;
            lastKeyPath = legacy;
            console.log(`✅ API Key saved to legacy location at ${legacy}`);
            return true;
        } catch (error) {
            console.error('❌ Error saving API key to any location:', error);
            return false;
        }
    }

    // Diagnostics: where is the API key stored/loaded from?
    app.get('/api/key-location', (req, res) => {
        // Refresh view
        loadAPIKey();
        res.json({
            hasApiKey: !!API_KEY,
            path: lastKeyPath || null,
            userDataPath,
        });
    });

    // Load any existing key at startup
    const hasAPIKey = loadAPIKey();

    // Use 127.0.0.1 to force IPv4 connection
    const JACKETT_URL = 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab';
    const client = new WebTorrent();
    const activeTorrents = new Map();
    // OpenSubtitles API key (provided by user for this app)
    const OPEN_SUBTITLES_API_KEY = 'bAYQ53sQ01tx14QcOrPjGkdnTOUMjMC0';

    // Multer for handling subtitle uploads (memory storage so we can convert before saving)
    const upload = multer({ storage: multer.memoryStorage() });

    // Helper: Convert basic SRT text into WebVTT
    const srtToVtt = (srtText) => {
        try {
            const body = String(srtText)
                .replace(/\r+/g, '')
                // Remove numeric indices on their own line
                .replace(/^\d+\s*$/gm, '')
                // Replace comma with dot in timestamps
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
                .trim();
            return `WEBVTT\n\n${body}\n`;
        } catch {
            return `WEBVTT\n\n` + String(srtText || '');
        }
    };

    // --- API Routes ---

    app.get('/api/check-api-key', (req, res) => {
        // Re-read on demand so external edits to any file are reflected
        loadAPIKey();
        // For UI: report whether a root-level file exists (user wants modal if not present)
        const s = readSettings();
        res.json({ hasApiKey: rootKeyExists(), useTorrentless: !!s.useTorrentless });
    });

    app.post('/api/set-api-key', (req, res) => {
        if (!req.body.apiKey) return res.status(400).json({ error: 'Invalid API key' });
        const key = req.body.apiKey.trim();
        if (saveAPIKey(key)) res.json({ success: true });
        else res.status(500).json({ error: 'Failed to save API key' });
    });

    app.get('/api/get-api-key', (req, res) => {
        // Ensure we have the latest view of the key file
        loadAPIKey();
        if (API_KEY) {
            const masked = API_KEY.substring(0, 4) + '*'.repeat(Math.max(0, API_KEY.length - 8)) + API_KEY.substring(Math.max(4, API_KEY.length - 4));
            res.json({ apiKey: masked, hasApiKey: true });
        } else {
            res.json({ apiKey: '', hasApiKey: false });
        }
    });

    app.get('/api/torrent-files', (req, res) => {
        const { magnet } = req.query;
        if (!magnet) return res.status(400).send('Missing magnet');
        const hashMatch = magnet.match(/btih:([a-fA-F0-9]{40})/i);
        if (!hashMatch) return res.status(400).send('Invalid magnet');
        const infoHash = hashMatch[1].toLowerCase();

        if (activeTorrents.has(infoHash)) {
            const torrent = activeTorrents.get(infoHash);
            if (torrent.ready) return handleReady(torrent);
            else return torrent.once('ready', () => handleReady(torrent));
        }

        const torrentDownloadPath = path.join(os.tmpdir(), 'webtorrent', infoHash);
        fs.mkdirSync(torrentDownloadPath, { recursive: true });
        const torrentOptions = { path: torrentDownloadPath, destroyStoreOnDestroy: true };
        const torrent = client.add(magnet, torrentOptions);
        activeTorrents.set(infoHash, torrent);

        // As soon as metadata is available, deselect everything to prevent auto-download
        torrent.on('metadata', () => {
            try { torrent.files.forEach(f => f.deselect()); } catch {}
            try { torrent.deselect(0, Math.max(0, torrent.pieces.length - 1), false); } catch {}
        });

        const handleReady = (t) => {
            // By default, prevent downloading everything; wait for explicit selection
            try { t.files.forEach(f => f.deselect()); } catch {}
            try { t.deselect(0, Math.max(0, t.pieces.length - 1), false); } catch {}
            // Build list preserving original torrent.files index
            const all = t.files.map((file, idx) => ({ index: idx, name: file.name, size: file.length }));
            const filtered = all.filter(f => /\.(mp4|mkv|avi|mov|srt|vtt|ass)$/i.test(f.name));
            res.json({
                infoHash,
                name: t.name,
                videoFiles: filtered.filter(f => f.name.match(/\.(mp4|mkv|avi|mov)$/i)).sort((a, b) => b.size - a.size),
                subtitleFiles: filtered.filter(f => f.name.match(/\.(srt|vtt|ass)$/i)),
            });
        };

    torrent.once('ready', () => handleReady(torrent));

        torrent.once('error', (err) => {
            console.error(`Torrent error for ${infoHash}:`, err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to load torrent metadata.' });
            }
            client.remove(magnet, () => console.log(`Cleaned up failed torrent: ${infoHash}`));
            activeTorrents.delete(infoHash);
        });
    });

    app.get('/api/stream-file', (req, res) => {
        const { hash, file: fileIndex } = req.query;
        if (!hash || isNaN(fileIndex)) return res.status(400).send('Missing hash or file index');
        const torrent = activeTorrents.get(hash);
        if (!torrent) return res.status(404).send('Torrent not found');

        const stream = () => {
            const file = torrent.files[fileIndex];
            if (!file) return res.status(404).send('File not found');

            // Ensure only the selected video file and all subtitle files are downloaded
            try {
                // Deselect everything first
                torrent.files.forEach(f => f.deselect());
                try { torrent.deselect(0, Math.max(0, torrent.pieces.length - 1), false); } catch {}
                // Select the chosen video file
                file.select();
                // Also select its piece range explicitly to kick off download
                try {
                    const start = Math.max(0, Math.floor(file.offset / torrent.pieceLength));
                    const end = Math.max(start, Math.floor((file.offset + file.length - 1) / torrent.pieceLength));
                    torrent.select(start, end, 1);
                } catch {}
                // Select all subtitle files so they download alongside
                torrent.files.forEach(f => {
                    if (/\.(srt|vtt|ass)$/i.test(f.name)) {
                        try { f.select(); } catch {}
                    }
                });
            } catch {}

            res.setHeader('Accept-Ranges', 'bytes');
            const range = req.headers.range;
            const fileSize = file.length;

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = (end - start) + 1;

                const contentType = mime.lookup(file.name) || 'application/octet-stream';
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Length': chunkSize,
                    'Content-Type': contentType,
                });

                const fileStream = file.createReadStream({ start, end });
                fileStream.on('error', (err) => {
                    console.error('Stream error during seek:', err.message);
                    res.end();
                });
                res.on('close', () => fileStream.destroy());
                fileStream.pipe(res);

            } else {
                const contentType = mime.lookup(file.name) || 'application/octet-stream';
                res.writeHead(200, { 
                    'Content-Length': fileSize, 
                    'Content-Type': contentType 
                });
                const fileStream = file.createReadStream();
                fileStream.on('error', (err) => {
                    console.error('Stream error initial:', err.message);
                    res.end();
                });
                res.on('close', () => fileStream.destroy());
                fileStream.pipe(res);
            }
        };

        if (torrent.ready) stream();
        else torrent.once('ready', stream);
    });

    // Prepare a specific file for streaming: select the file and start downloading its pieces (and all subtitles), but do not stream yet
    app.get('/api/prepare-file', (req, res) => {
        const { hash, file: fileIndex } = req.query;
        if (!hash || isNaN(fileIndex)) return res.status(400).json({ success: false, error: 'Missing hash or file index' });
        const torrent = activeTorrents.get(hash);
        if (!torrent) return res.status(404).json({ success: false, error: 'Torrent not found' });

        const prepare = () => {
            const idx = Number(fileIndex);
            const file = torrent.files[idx];
            if (!file) return res.status(404).json({ success: false, error: 'File not found' });
            try {
                // Deselect everything then select this file
                torrent.files.forEach(f => f.deselect());
                try { torrent.deselect(0, Math.max(0, torrent.pieces.length - 1), false); } catch {}
                file.select();
                // Explicitly select its piece range to kick off download immediately
                try {
                    const start = Math.max(0, Math.floor(file.offset / torrent.pieceLength));
                    const end = Math.max(start, Math.floor((file.offset + file.length - 1) / torrent.pieceLength));
                    torrent.select(start, end, 1);
                } catch {}
                // Also preselect all subtitle files
                torrent.files.forEach(f => {
                    if (/\.(srt|vtt|ass)$/i.test(f.name)) {
                        try { f.select(); } catch {}
                    }
                });
            } catch {}

            return res.json({
                success: true,
                file: { index: idx, name: file.name, size: file.length },
                infoHash: hash
            });
        };

        if (torrent.ready) return prepare();
        torrent.once('ready', prepare);
    });

    app.get('/api/stop-stream', (req, res) => {
        const { hash } = req.query;
        if (!hash) return res.status(400).send('Missing hash');
        const torrent = activeTorrents.get(hash);
        if (torrent) {
            console.log(`⏹️ Stopping torrent: ${hash}`);
            const torrentDownloadPath = path.join(os.tmpdir(), 'webtorrent', hash);
            client.remove(torrent.magnetURI, { destroyStore: true }, async (err) => {
                if (err) console.error('Error removing torrent from client:', err);
                else console.log(`Torrent ${hash} removed successfully from client.`);
                
                activeTorrents.delete(hash);
                console.log(`Torrent ${hash} removed from activeTorrents map.`);

                try {
                    await deleteFolderRecursive(torrentDownloadPath);
                } catch (cleanupErr) {
                    console.error(`Error cleaning up torrent directory ${torrentDownloadPath}:`, cleanupErr);
                }
                res.json({ success: true, message: 'Stream stopped and cleaned up' });
            });
        } else {
            res.status(404).json({ success: false, message: 'Stream not found' });
        }
    });

    app.get('/api/torrents', async (req, res) => {
        const { q: query, page } = req.query;
        if (!query) return res.status(400).json({ error: 'Missing query' });
        const s = readSettings();
        const useTorrentless = !!s.useTorrentless;
        // If Torrentless is enabled, prefer it
        if (useTorrentless) {
            try {
                const p = Math.max(1, parseInt(page, 10) || 1);
                const url = `http://127.0.0.1:3002/api/search?q=${encodeURIComponent(query)}&page=${p}`;
                const response = await fetch(url);
                // If Torrentless rate-limits or errors, proxy the JSON body to the client instead of throwing
                let data;
                try { data = await response.json(); } catch { data = null; }
                if (!response.ok) {
                    // Ensure a friendly structured error instead of ECONNREFUSED noise
                    const fallback = data && typeof data === 'object' ? data : { error: `Torrentless error: ${response.status} ${response.statusText}` };
                    return res.status(response.status).json(fallback);
                }
                const items = Array.isArray(data.items) ? data.items : [];
                const torrents = items.map(it => ({
                    title: it.title,
                    magnet: it.magnet,
                    seeders: Number(it.seeds || it.seeders || 0),
                    size: (() => {
                        // Try to convert "2.54 GB" style strings to bytes; else 0
                        const m = String(it.size || '').match(/([0-9.]+)\s*(KB|MB|GB|TB)/i);
                        if (!m) return 0;
                        const n = parseFloat(m[1]);
                        const unit = m[2].toUpperCase();
                        const mult = unit === 'KB' ? 1024 : unit === 'MB' ? 1024**2 : unit === 'GB' ? 1024**3 : 1024**4;
                        return Math.round(n * mult);
                    })(),
                }));
                return res.json(torrents);
            } catch (error) {
                // If Torrentless is unreachable or throws, return a friendly JSON error and do NOT fall back to Jackett
                const msg = (error && error.message || '').toLowerCase();
                if (msg.includes('ecconnrefused') || msg.includes('connect')) {
                    return res.status(503).json({ error: 'Torrentless service is unavailable. Try again shortly.' });
                }
                return res.status(500).json({ error: 'Failed to fetch from Torrentless.' });
            }
        }

        // Jackett fallback/default
        // Ensure key is loaded from disk whenever we need Jackett
        if (!API_KEY) loadAPIKey();
    if (!API_KEY) return res.status(400).json({ error: 'API key not configured' });
        try {
            const url = `${JACKETT_URL}?apikey=${API_KEY}&t=search&q=${encodeURIComponent(query)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Jackett error: ${response.statusText}`);
            const xml = await response.text();
            const result = await xml2js.parseStringPromise(xml, { mergeAttrs: true, explicitArray: false });
            const items = result.rss.channel.item || [];
            const torrents = (Array.isArray(items) ? items : [items])
                .map(item => {
                    if (!item || (!item.link && !item.guid)) return null;
                    const magnet = item.link?.startsWith('magnet:') ? item.link : item.guid;
                    if (!magnet || !magnet.startsWith('magnet:')) return null;
                    const attrs = Array.isArray(item['torznab:attr']) ? item['torznab:attr'] : [item['torznab:attr']];
                    const seeders = attrs.find(attr => attr?.name === 'seeders')?.value || 0;
                    return { title: item.title, magnet, seeders: +seeders, size: +(item.enclosure?.length || 0) };
                })
                .filter(Boolean);
            res.json(torrents);
        } catch (error) {
            console.error('Error fetching torrents:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // App UA for OpenSubtitles (must include app name and version)
    const APP_USER_AGENT = 'PlayTorrio v1.0.0';

    // Map an ISO 639-1 language code to English name (basic set, extend as needed)
    const isoToName = (code) => {
        const map = {
            af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek',
            en: 'English', es: 'Spanish', et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian',
            hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ka: 'Georgian', kk: 'Kazakh', ko: 'Korean', lt: 'Lithuanian',
            lv: 'Latvian', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak',
            sl: 'Slovenian', sr: 'Serbian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', vi: 'Vietnamese', zh: 'Chinese',
            pb: 'Portuguese (BR)'
        };
        if (!code) return 'Unknown';
        const key = String(code).toLowerCase();
        return map[key] || code.toUpperCase();
    };

    // Parse torrent filename to infer title/season/episode for TV shows
    function parseReleaseFromFilename(filename = '') {
        try {
            // Strip path and extension
            const base = path.basename(String(filename));
            const noExt = base.replace(/\.[^.]+$/i, '');
            // Normalize separators and remove common tags (brackets)
            const cleaned = noExt
                .replace(/[\[\(].*?[\)\]]/g, ' ') // remove bracketed groups
                .replace(/[_]+/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();

            // Patterns to detect season/episode in many forms
            const patterns = [
                // S01E10 / s01.e10 / S01.E10
                { re: /(s)(\d{1,2})[ ._-]*e(\d{1,3})/i, season: 2, episode: 3 },
                // 01x10 / 1x10
                { re: /\b(\d{1,2})[xX](\d{1,3})\b/, season: 1, episode: 2 },
                // 01.10 or 01-10 (avoid matching 1080, 2160 etc.)
                { re: /\b(\d{1,2})[ ._-]+(\d{1,2})\b/, season: 1, episode: 2 },
            ];

            let season = null, episode = null, title = cleaned;
            let matchIdx = -1, m = null;
            for (let i = 0; i < patterns.length; i++) {
                const p = patterns[i];
                const mm = cleaned.match(p.re);
                if (mm) {
                    // Filter out false positives like 1080 2160 by simple heuristic
                    const sVal = parseInt(mm[p.season], 10);
                    const eVal = parseInt(mm[p.episode], 10);
                    if (!isNaN(sVal) && !isNaN(eVal) && sVal <= 99 && eVal <= 999) {
                        season = sVal;
                        episode = eVal;
                        m = mm;
                        matchIdx = mm.index;
                        break;
                    }
                }
            }
            if (m && matchIdx >= 0) {
                title = cleaned.slice(0, matchIdx).replace(/[-_.]+$/,'').trim();
            }
            // Further cleanup title: drop trailing separators and common quality strings
            title = title
                .replace(/\b(\d{3,4}p|4k|bluray|web[- ]?dl|webrip|bdrip|hdr|dv|x264|x265|hevc|h264)\b/ig, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

            const type = season && episode ? 'tv' : 'movie';
            return { title, season, episode, type };
        } catch {
            return { title: '', season: null, episode: null, type: 'movie' };
        }
    }

    // Fetch subtitles list from OpenSubtitles and Wyzie
    app.get('/api/subtitles', async (req, res) => {
        try {
            const tmdbId = req.query.tmdbId; // optional when filename is provided
            let type = (req.query.type || 'movie').toLowerCase(); // 'movie' or 'tv'
            let season = req.query.season ? parseInt(req.query.season, 10) : undefined;
            let episode = req.query.episode ? parseInt(req.query.episode, 10) : undefined;
            const filename = (req.query.filename || '').toString();

            // If a torrent filename is provided, parse season/episode for TV only and extract a fallback title
            let parsed = { title: '', season: null, episode: null, type: null };
            if (filename) {
                parsed = parseReleaseFromFilename(filename);
                // Only allow filename parsing to switch to TV when current request isn't explicitly for a movie
                if (type !== 'movie' && parsed.type === 'tv') type = 'tv';
                // Only apply season/episode when we are dealing with TV
                if (type === 'tv') {
                    if (parsed.season != null) season = parsed.season;
                    if (parsed.episode != null) episode = parsed.episode;
                }
            }

            // Allow operation if either tmdbId exists OR filename provided for query-based search
            if (!tmdbId && !filename) {
                return res.status(400).json({ error: 'Missing tmdbId or filename' });
            }

            const wyzieUrl = (tmdbId ? (type === 'tv' && season && episode
                ? `https://sub.wyzie.ru/search?id=${encodeURIComponent(tmdbId)}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`
                : `https://sub.wyzie.ru/search?id=${encodeURIComponent(tmdbId)}`) : null);

            // Build OpenSubtitles search URL
            const qs = new URLSearchParams();
            if (tmdbId) {
                qs.set('tmdb_id', tmdbId);
            }
            if (type === 'tv') {
                qs.set('type', 'episode');
                if (season) qs.set('season_number', String(season));
                if (episode) qs.set('episode_number', String(episode));
            } else {
                qs.set('type', 'movie');
            }
            // If we don't have tmdbId, start with a query-based search using parsed title
            const parsedTitle = parsed.title || '';
            if (!tmdbId && parsedTitle) {
                qs.set('query', parsedTitle);
            }
            qs.set('order_by', 'download_count');
            qs.set('order_direction', 'desc');
            qs.set('per_page', '50');
            const osUrl = `https://api.opensubtitles.com/api/v1/subtitles?${qs.toString()}`;

            // Optional title/year for fallback search
            const fallbackTitle = (req.query.title || '').toString();
            const fallbackYear = (req.query.year || '').toString();

            const headers = { 'Accept': 'application/json', 'User-Agent': APP_USER_AGENT };
            const osHeaders = { ...headers, 'Api-Key': OPEN_SUBTITLES_API_KEY };

            const promises = [];
            if (wyzieUrl) promises.push(fetch(wyzieUrl, { headers }));
            promises.push(fetch(osUrl, { headers: osHeaders }));
            const settled = await Promise.allSettled(promises);
            // Map back results
            const wyzieRes = wyzieUrl ? settled[0] : { status: 'rejected' };
            const osRes = wyzieUrl ? settled[1] : settled[0];

            const wyzieList = [];
            if (wyzieRes.status === 'fulfilled' && wyzieRes.value.ok) {
                try {
                    const json = await wyzieRes.value.json();
                    // Expecting array of items with at least url and lang or language
                    if (Array.isArray(json)) {
                        json.forEach((item, idx) => {
                            const url = item.url || item.link || item.download || null;
                            const langCode = (item.language || item.lang || item.languageCode || '').toString().toLowerCase();
                            const langName = (item.display && String(item.display).trim()) || item.languageName || isoToName(langCode);
                            // Determine extension (supported: srt, vtt)
                            let ext = (item.format || '').toString().toLowerCase();
                            if (!ext && url) {
                                const mext = url.match(/\.([a-z0-9]+)(?:\.[a-z0-9]+)?$/i);
                                if (mext) {
                                    const raw = mext[1].toLowerCase();
                                    ext = raw === 'vtt' ? 'vtt' : (raw === 'srt' ? 'srt' : ext);
                                }
                            }
                            if (url) {
                                wyzieList.push({
                                    id: `wyzie-${idx}`,
                                    source: 'wyzie',
                                    lang: langCode || 'unknown',
                                    langName,
                                    url,
                                    name: item.filename || item.name || `${langName}`,
                                    flagUrl: item.flagUrl || null,
                                    encoding: item.encoding || null,
                                    format: item.format || null,
                                    ext: ext || null
                                });
                            }
                        });
                    }
                } catch (e) {
                    // ignore
                }
            }

            const osList = [];
            const collectOsResults = (json) => {
                const arr = Array.isArray(json?.data) ? json.data : [];
                arr.forEach((entry) => {
                    const at = entry && entry.attributes ? entry.attributes : {};
                    const langCode = (at.language || at.language_code || '').toLowerCase();
                    const files = Array.isArray(at.files) ? at.files : [];
                    files.forEach((f) => {
                        const fileId = f && f.file_id;
                        let ext = null;
                        const fname = (f && f.file_name) || '';
                        const m = fname.match(/\.(srt|vtt)(?:\.[a-z0-9]+)?$/i);
                        if (m) ext = m[1].toLowerCase();
                        if (fileId) {
                            osList.push({
                                id: `os-${fileId}`,
                                source: 'opensubtitles',
                                lang: langCode || 'unknown',
                                langName: isoToName(langCode),
                                file_id: fileId,
                                name: at.release && at.release.length ? at.release : `${isoToName(langCode)}`,
                                ext
                            });
                        }
                    });
                });
            };

            if (osRes.status === 'fulfilled' && osRes.value.ok) {
                try {
                    const json = await osRes.value.json();
                    collectOsResults(json);
                    // Fallback: if nothing returned, try by title/year query (when provided)
                    const useTitle = parsedTitle || fallbackTitle;
                    if (!osList.length && (useTitle || fallbackYear)) {
                        const qs2 = new URLSearchParams();
                        if (useTitle) qs2.set('query', useTitle);
                        if (fallbackYear) qs2.set('year', fallbackYear);
                        if (type === 'tv') {
                            qs2.set('type', 'episode');
                            if (season) qs2.set('season_number', String(season));
                            if (episode) qs2.set('episode_number', String(episode));
                        } else {
                            qs2.set('type', 'movie');
                        }
                        qs2.set('order_by', 'download_count');
                        qs2.set('order_direction', 'desc');
                        qs2.set('per_page', '50');
                        const osUrl2 = `https://api.opensubtitles.com/api/v1/subtitles?${qs2.toString()}`;
                        try {
                            const osRes2 = await fetch(osUrl2, { headers: osHeaders });
                            if (osRes2.ok) {
                                const json2 = await osRes2.json();
                                collectOsResults(json2);
                            }
                        } catch {}
                    }
                } catch (e) {
                    // If OS listing throws/quota, ignore and proceed with Wyzie results
                }
            }

            // Combine and filter supported formats (we convert srt -> vtt; skip ass/ssa/others)
            // Prefer Wyzie entries first so users are less likely to hit OS quota
            const combined = [...wyzieList, ...osList];
            const supported = combined.filter(it => {
                if (it.ext) return ['srt','vtt'].includes(String(it.ext).toLowerCase());
                if (it.format) return ['srt','vtt'].includes(String(it.format).toLowerCase());
                if (it.url) {
                    const u = String(it.url).toLowerCase();
                    return u.includes('.srt') || u.includes('.vtt') || u.includes('.srt.gz');
                }
                return true; // default keep
            });
            // Return grouped by language with stable ordering
            res.json({ subtitles: supported });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to fetch subtitles' });
        }
    });

    // Download subtitle to temp dir (supports OpenSubtitles and Wyzie direct URL)
    app.post('/api/subtitles/download', async (req, res) => {
        try {
            // Ensure temp subtitles directory exists before writing
            ensureSubsDir();
            const { source, fileId, url, preferredName } = req.body || {};
            if (!source) return res.status(400).json({ error: 'Missing source' });

            let downloadUrl = url || null;
            let filenameBase = preferredName || 'subtitle';

            if (source === 'opensubtitles') {
                if (!fileId) return res.status(400).json({ error: 'Missing fileId for OpenSubtitles' });
                const osResp = await fetch('https://api.opensubtitles.com/api/v1/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Api-Key': OPEN_SUBTITLES_API_KEY, 'User-Agent': APP_USER_AGENT },
                    body: JSON.stringify({ file_id: fileId, sub_format: 'vtt' })
                });
                if (!osResp.ok) {
                    const txt = await osResp.text();
                    // Detect OS quota/limit errors and return a structured message
                    const lower = (txt || '').toLowerCase();
                    if (osResp.status === 429 || lower.includes('allowed 5 subtitles') || lower.includes('quota')) {
                        return res.status(429).json({
                            error: 'OpenSubtitles quota reached. Using Wyzie subtitles is recommended until reset.',
                            provider: 'opensubtitles',
                            code: 'OS_QUOTA',
                            details: txt
                        });
                    }
                    return res.status(500).json({ error: `OpenSubtitles download failed: ${txt}` });
                }
                const j = await osResp.json();
                downloadUrl = j?.link || j?.url || null;
                if (j?.file_name) filenameBase = j.file_name.replace(/\.[^.]+$/, '');
                if (!downloadUrl) return res.status(500).json({ error: 'No download URL from OpenSubtitles' });
            }

            if (!downloadUrl) return res.status(400).json({ error: 'No download URL' });

            // Fetch the subtitle content
            const resp = await fetch(downloadUrl);
            if (!resp.ok) return res.status(500).json({ error: `Failed to fetch subtitle file (${resp.status})` });

            // Infer extension
            let ext = '.srt';
            const ct = resp.headers.get('content-type') || '';
            if (/webvtt|vtt/i.test(ct)) ext = '.vtt';
            else if (/ass|ssa/i.test(ct)) ext = '.ass';
            else if (/gzip/i.test(resp.headers.get('content-encoding') || '')) ext = '.srt.gz';
            const cd = resp.headers.get('content-disposition') || '';
            const m = cd.match(/filename="?([^";]+)"?/i);
            if (m && m[1]) {
                const name = m[1];
                const found = (name.match(/\.(srt|vtt|ass|ssa|gz)$/i) || [])[0];
                if (found) ext = found.startsWith('.') ? found : '.' + found;
            }

            const rand = crypto.randomBytes(8).toString('hex');
            const baseOut = path.join(SUB_TMP_DIR, `${filenameBase}-${rand}`);
            const buf = Buffer.from(await resp.arrayBuffer());

            // If gzipped, gunzip into memory first
            let contentBuf = buf;
            if (/\.gz$/i.test(ext)) {
                try { contentBuf = zlib.gunzipSync(buf); ext = ext.replace(/\.gz$/i, ''); } catch {}
            }

            // Determine if we should convert to VTT
            const text = contentBuf.toString('utf8');
            const looksLikeVtt = /^\s*WEBVTT/i.test(text);
            const looksLikeSrt = /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/m.test(text);

            let finalPath = '';
            if (looksLikeVtt || /\.vtt$/i.test(ext)) {
                finalPath = `${baseOut}.vtt`;
                try { fs.writeFileSync(finalPath, looksLikeVtt ? text : `WEBVTT\n\n${text}`); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, looksLikeVtt ? text : `WEBVTT\n\n${text}`); }
            } else if (looksLikeSrt || /\.srt$/i.test(ext)) {
                const vtt = srtToVtt(text);
                finalPath = `${baseOut}.vtt`;
                try { fs.writeFileSync(finalPath, vtt); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, vtt); }
            } else {
                // Unknown/ASS format: save as-is with original ext
                finalPath = `${baseOut}${ext.startsWith('.') ? ext : ('.' + ext)}`;
                try { fs.writeFileSync(finalPath, contentBuf); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, contentBuf); }
            }

            const servedName = path.basename(finalPath);
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            res.json({ url: `${baseUrl}/subtitles/${encodeURIComponent(servedName)}`, filename: servedName });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to download subtitle' });
        }
    });

    // Upload a user-provided subtitle file and return a served URL (converts SRT to VTT)
    app.post('/api/upload-subtitle', upload.single('subtitle'), async (req, res) => {
        try {
            // Ensure temp subtitles directory exists before writing
            ensureSubsDir();
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            const original = req.file.originalname || 'subtitle.srt';
            const contentBuf = req.file.buffer;
            const text = contentBuf.toString('utf8');
            const looksLikeVtt = /^\s*WEBVTT/i.test(text);
            const looksLikeSrt = /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/m.test(text);
            const filenameBase = original.replace(/\.[^.]+$/, '') + '-' + crypto.randomBytes(6).toString('hex');

            let finalPath = '';
            if (looksLikeVtt || /\.vtt$/i.test(original)) {
                finalPath = path.join(SUB_TMP_DIR, `${filenameBase}.vtt`);
                try { fs.writeFileSync(finalPath, looksLikeVtt ? text : `WEBVTT\n\n${text}`); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, looksLikeVtt ? text : `WEBVTT\n\n${text}`); }
            } else if (looksLikeSrt || /\.srt$/i.test(original)) {
                const vtt = srtToVtt(text);
                finalPath = path.join(SUB_TMP_DIR, `${filenameBase}.vtt`);
                try { fs.writeFileSync(finalPath, vtt); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, vtt); }
            } else {
                // Keep as-is for other formats
                const ext = path.extname(original) || '.txt';
                finalPath = path.join(SUB_TMP_DIR, `${filenameBase}${ext}`);
                try { fs.writeFileSync(finalPath, contentBuf); }
                catch { ensureSubsDir(); fs.writeFileSync(finalPath, contentBuf); }
            }

            const servedName = path.basename(finalPath);
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            res.json({ url: `${baseUrl}/subtitles/${encodeURIComponent(servedName)}`, filename: servedName });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to upload subtitle' });
        }
    });

    // Cleanup all temporary subtitles
    app.post('/api/subtitles/cleanup', async (req, res) => {
        try {
            if (fs.existsSync(SUB_TMP_DIR)) {
                for (const f of fs.readdirSync(SUB_TMP_DIR)) {
                    try { fs.unlinkSync(path.join(SUB_TMP_DIR, f)); } catch {}
                }
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'Failed to cleanup subtitles' });
        }
    });

    // Delete a specific subtitle file
    app.post('/api/subtitles/delete', (req, res) => {
        try {
            const { filename } = req.body || {};
            if (!filename) return res.status(400).json({ success: false, error: 'Missing filename' });
            const target = path.join(SUB_TMP_DIR, filename);
            // Ensure within temp dir
            if (!target.startsWith(SUB_TMP_DIR)) return res.status(400).json({ success: false, error: 'Invalid path' });
            if (fs.existsSync(target)) fs.unlinkSync(target);
            return res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'Failed to delete subtitle' });
        }
    });

    const server = app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        if (!hasAPIKey) console.log('⚠️ Jackett API key not configured.');
    });

    return { server, client };
}
