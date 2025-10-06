import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import xml2js from 'xml2js';
import path from 'path';
import { fileURLToPath } from 'url';
import WebTorrent from 'webtorrent';
import multer from 'multer';
import fs from 'fs';
import os from 'os';

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

    // API Key Management
    let API_KEY = '';

    // Determine where to read/write the root-level key file
    const installDir = path.dirname(process.execPath); // In packaged builds, next to the app exe
    const devRoot = __dirname; // In dev, server.mjs resides at project root

    const resolveReadCandidates = () => [
        path.join(installDir, 'jackett_api_key.json'), // packaged app folder
        path.join(devRoot, 'jackett_api_key.json'),    // project root (dev)
        path.join(process.cwd(), 'jackett_api_key.json'), // current working dir (fallback)
        // userData fallback (ensures app keeps working when root is not writable)
        path.join(userDataPath, 'jackett_api_key.json')
    ];

    const rootKeyExists = () => {
        const rootCandidates = [
            path.join(installDir, 'jackett_api_key.json'),
            path.join(devRoot, 'jackett_api_key.json'),
            path.join(process.cwd(), 'jackett_api_key.json')
        ];
        return rootCandidates.some(p => {
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
        return isPackagedByExe
            ? path.join(installDir, 'jackett_api_key.json')
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
        // 1) Try to save to root-level preferred location
        try {
            const target = resolveWritePath();
            fs.writeFileSync(target, payload);
            API_KEY = apiKey;
            console.log(`✅ API Key saved to ${target}`);
            return true;
        } catch (err) {
            console.warn('⚠️ Failed to write API key to root location, falling back to userData:', err?.message || err);
        }

        // 2) Fallback to userData to keep the app working even if root is not writable
        try {
            const userDataFile = path.join(userDataPath, 'jackett_api_key.json');
            fs.mkdirSync(userDataPath, { recursive: true });
            fs.writeFileSync(userDataFile, payload);
            API_KEY = apiKey;
            console.log(`✅ API Key saved to userData fallback at ${userDataFile}`);
            return true;
        } catch (error) {
            console.error('Error saving API key to any location:', error);
            return false;
        }
    }

    // Load any existing key at startup
    const hasAPIKey = loadAPIKey();

    // Use 127.0.0.1 to force IPv4 connection
    const JACKETT_URL = 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab';
    const client = new WebTorrent();
    const activeTorrents = new Map();

    // --- API Routes ---

    app.get('/api/check-api-key', (req, res) => {
        // Re-read on demand so external edits to any file are reflected
        loadAPIKey();
        // For UI: report whether a root-level file exists (user wants modal if not present)
        res.json({ hasApiKey: rootKeyExists() });
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

        const handleReady = (t) => {
            const files = t.files.map((file, index) => ({ index, name: file.name, size: file.length }));
            res.json({
                infoHash,
                name: t.name,
                videoFiles: files.filter(f => f.name.match(/\.(mp4|mkv|avi|mov)$/i)).sort((a, b) => b.size - a.size),
                subtitleFiles: files.filter(f => f.name.match(/\.(srt|vtt|ass)$/i)),
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

            res.setHeader('Accept-Ranges', 'bytes');
            const range = req.headers.range;
            const fileSize = file.length;

            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Length': chunkSize,
                    'Content-Type': 'video/mp4',
                });

                const fileStream = file.createReadStream({ start, end });
                fileStream.on('error', (err) => {
                    console.error('Stream error during seek:', err.message);
                    res.end();
                });
                res.on('close', () => fileStream.destroy());
                fileStream.pipe(res);

            } else {
                res.writeHead(200, { 
                    'Content-Length': fileSize, 
                    'Content-Type': 'video/mp4' 
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
        const { q: query } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query' });
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

    const server = app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        if (!hasAPIKey) console.log('⚠️ Jackett API key not configured.');
    });

    return { server, client };
}