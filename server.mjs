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
import { createRequire } from 'module';

// Import the CommonJS api.cjs module
const require = createRequire(import.meta.url);
const { registerApiRoutes } = require('./api.cjs');

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

    // Trakt API Configuration
    const TRAKT_CONFIG = {
        CLIENT_ID: 'd1fd29900d9ed0b07de3529907bd290c0f5eb7e96c9a8c544ff1f919fd3c0d18',
        CLIENT_SECRET: '2a773d3d57be6662a51266ca40c95366cec011ad630a8601f8710484be20c04c',
        BASE_URL: 'https://api.trakt.tv',
        REDIRECT_URI: 'urn:ietf:wg:oauth:2.0:oob',
        API_VERSION: '2'
    };

    // Trakt API helper function
    async function traktFetch(endpoint, options = {}) {
        const url = `${TRAKT_CONFIG.BASE_URL}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': TRAKT_CONFIG.API_VERSION,
            'trakt-api-key': TRAKT_CONFIG.CLIENT_ID,
            ...options.headers
        };

        // Add access token if available
        const traktToken = readTraktToken();
        if (traktToken && traktToken.access_token) {
            headers['Authorization'] = `Bearer ${traktToken.access_token}`;
        }

        console.log(`[TRAKT] ${options.method || 'GET'} ${url}`);
        
        const response = await fetch(url, {
            ...options,
            headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[TRAKT] Error ${response.status}: ${errorText}`);
            throw new Error(`Trakt API Error: ${response.status} ${errorText}`);
        }

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return await response.json();
        }
        return null;
    }

    // Trakt token storage functions
    const TRAKT_TOKEN_PATH = path.join(userDataPath, 'trakt_token.json');
    
    function readTraktToken() {
        try {
            if (fs.existsSync(TRAKT_TOKEN_PATH)) {
                const tokenData = JSON.parse(fs.readFileSync(TRAKT_TOKEN_PATH, 'utf8'));
                // Check if token is expired
                if (tokenData.expires_at && Date.now() > tokenData.expires_at) {
                    console.log('[TRAKT] Token expired, needs refresh');
                    return null;
                }
                return tokenData;
            }
        } catch (error) {
            console.error('[TRAKT] Error reading token:', error);
        }
        return null;
    }

    function saveTraktToken(tokenData) {
        try {
            // Calculate expiration time
            if (tokenData.expires_in) {
                tokenData.expires_at = Date.now() + (tokenData.expires_in * 1000);
            }
            fs.writeFileSync(TRAKT_TOKEN_PATH, JSON.stringify(tokenData, null, 2));
            console.log('[TRAKT] Token saved successfully');
            return true;
        } catch (error) {
            console.error('[TRAKT] Error saving token:', error);
            return false;
        }
    }

    function deleteTraktToken() {
        try {
            if (fs.existsSync(TRAKT_TOKEN_PATH)) {
                fs.unlinkSync(TRAKT_TOKEN_PATH);
                console.log('[TRAKT] Token deleted');
            }
            return true;
        } catch (error) {
            console.error('[TRAKT] Error deleting token:', error);
            return false;
        }
    }

    app.use(cors());
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.json());
    
    // Register all API routes from api.js (anime, torrentio, torrentless, zlib, otherbook, 111477)
    console.log('📦 Registering API routes from api.js...');
    registerApiRoutes(app);
    console.log('✅ API routes registered successfully');
    
    // Simple playback resume storage in userData
    const RESUME_PATH = path.join(userDataPath, 'playback_positions.json');
    function readResumeMap() {
        try {
            if (fs.existsSync(RESUME_PATH)) {
                const j = JSON.parse(fs.readFileSync(RESUME_PATH, 'utf8'));
                if (j && typeof j === 'object') return j;
            }
        } catch {}
        return {};
    }
    function writeResumeMap(obj) {
        try {
            fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
            fs.writeFileSync(RESUME_PATH, JSON.stringify(obj, null, 2));
            return true;
        } catch {
            return false;
        }
    }
    // Simple settings storage in userData
    const SETTINGS_PATH = path.join(userDataPath, 'settings.json');
    function readSettings() {
        try {
            const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
            return {
                useTorrentless: false,
                torrentSource: 'torrentio',
                useDebrid: false,
                debridProvider: 'realdebrid',
                rdToken: null,
                rdRefresh: null,
                rdClientId: null,
                rdCredId: null,
                rdCredSecret: null,
                adApiKey: null,
                tbApiKey: null,
                pmApiKey: null,
                ...s,
            };
        } catch {
            return { useTorrentless: false, torrentSource: 'torrentio', useDebrid: false, debridProvider: 'realdebrid', rdToken: null, rdRefresh: null, rdClientId: null, rdCredId: null, rdCredSecret: null, adApiKey: null, tbApiKey: null, pmApiKey: null };
        }
    }
    function writeSettings(obj) {
        try { fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
    }

    // Diagnostics helpers for logging
    function mask(value, visible = 4) {
        if (!value) return null;
        const s = String(value);
        if (s.length <= visible) return '*'.repeat(Math.max(2, s.length));
        return s.slice(0, visible) + '***';
    }
    function truncate(s, n = 300) {
        try { const v = String(s || ''); return v.length > n ? v.slice(0, n) + '…' : v; } catch { return ''; }
    }

    app.get('/api/settings', (req, res) => {
        const s = readSettings();
        // Also load Jackett URL and cache location from user settings
        const userSettings = loadUserSettings();
        // Determine auth state for the selected provider
        const provider = s.debridProvider || 'realdebrid';
        const debridAuth = provider === 'alldebrid' ? !!s.adApiKey 
            : provider === 'torbox' ? !!s.tbApiKey 
            : provider === 'premiumize' ? !!s.pmApiKey 
            : !!s.rdToken;
        res.json({
            useTorrentless: !!s.useTorrentless,
            torrentSource: s.torrentSource || 'torrentio',
            useDebrid: !!s.useDebrid,
            debridProvider: provider,
            debridAuth,
            rdClientId: s.rdClientId || null,
            jackettUrl: userSettings.jackettUrl || JACKETT_URL,
            cacheLocation: userSettings.cacheLocation || CACHE_LOCATION
        });
    });
    app.post('/api/settings', (req, res) => {
        const s = readSettings();
        const next = {
            ...s,
            useTorrentless: req.body.useTorrentless != null ? !!req.body.useTorrentless : !!s.useTorrentless,
            torrentSource: req.body.torrentSource !== undefined ? req.body.torrentSource : (s.torrentSource || 'torrentio'),
            useDebrid: req.body.useDebrid != null ? !!req.body.useDebrid : !!s.useDebrid,
            debridProvider: req.body.debridProvider || s.debridProvider || 'realdebrid',
            rdClientId: typeof req.body.rdClientId === 'string' ? req.body.rdClientId.trim() || null : (s.rdClientId || null),
        };
        const ok = writeSettings(next);
        
        // Also handle Jackett URL and cache location
        const userSettings = loadUserSettings();
        let settingsUpdated = false;
        
        if (req.body.jackettUrl !== undefined) {
            userSettings.jackettUrl = req.body.jackettUrl;
            JACKETT_URL = req.body.jackettUrl;
            settingsUpdated = true;
        }
        if (req.body.cacheLocation !== undefined) {
            userSettings.cacheLocation = req.body.cacheLocation;
            CACHE_LOCATION = req.body.cacheLocation;
            settingsUpdated = true;
        }
        
        if (settingsUpdated) {
            saveUserSettings(userSettings);
        }
        
        if (ok) return res.json({ success: true, settings: { ...next, ...userSettings, rdToken: next.rdToken ? '***' : null } });
        return res.status(500).json({ success: false, error: 'Failed to save settings' });
    });

    // Debrid: token storage for Real-Debrid (server-side only)
    app.post('/api/debrid/token', (req, res) => {
        const { token } = req.body || {};
        const s = readSettings();
        const next = { ...s, rdToken: typeof token === 'string' && token.trim() ? token.trim() : null };
        const ok = writeSettings(next);
        if (ok) return res.json({ success: true });
        return res.status(500).json({ success: false, error: 'Failed to save token' });
    });

    // --- Playback resume endpoints ---
    // Get a saved resume position by key
    app.get('/api/resume', (req, res) => {
        try {
            const key = (req.query?.key || '').toString();
            if (!key) return res.status(400).json({ error: 'Missing key' });
            const map = readResumeMap();
            const rec = map[key];
            if (!rec) return res.status(404).json({});
            return res.json(rec);
        } catch (e) {
            return res.status(500).json({ error: e?.message || 'Failed to read resume' });
        }
    });
    // Save/update a resume position
    app.post('/api/resume', (req, res) => {
        try {
            const { key, position, duration, title } = req.body || {};
            const k = (key || '').toString();
            const pos = Number(position || 0);
            const dur = Number(duration || 0);
            if (!k) return res.status(400).json({ error: 'Missing key' });
            if (pos < 0) return res.status(400).json({ error: 'Bad position' });
            const map = readResumeMap();
            // If watched almost to end, clear entry instead of saving
            if (dur > 0 && pos / dur >= 0.95) {
                delete map[k];
                writeResumeMap(map);
                return res.json({ success: true, cleared: true });
            }
            const rec = { position: pos, duration: dur, updatedAt: new Date().toISOString() };
            if (title) rec.title = String(title);
            map[k] = rec;
            // Cap entries to avoid unbounded growth (keep latest 500)
            const entries = Object.entries(map).sort((a, b) => new Date(b[1]?.updatedAt || 0) - new Date(a[1]?.updatedAt || 0));
            if (entries.length > 500) {
                const trimmed = Object.fromEntries(entries.slice(0, 500));
                writeResumeMap(trimmed);
                return res.json({ success: true });
            }
            writeResumeMap(map);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e?.message || 'Failed to save resume' });
        }
    });
    // Delete a resume record
    app.delete('/api/resume', (req, res) => {
        try {
            const key = (req.query?.key || req.body?.key || '').toString();
            if (!key) return res.status(400).json({ error: 'Missing key' });
            const map = readResumeMap();
            if (map[key]) delete map[key];
            writeResumeMap(map);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e?.message || 'Failed to delete resume' });
        }
    });

    // --- AllDebrid minimal adapter & auth (PIN flow) ---
    const AD_BASE = 'https://api.alldebrid.com/v4';
    async function adFetch(endpoint, opts = {}) {
        const s = readSettings();
        if (!s.adApiKey) throw new Error('Not authenticated with AllDebrid');
        const url = `${AD_BASE}${endpoint}`;
        console.log('[AD][call]', { endpoint, method: (opts.method || 'GET').toUpperCase() });
        const resp = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${s.adApiKey}`, ...(opts.headers || {}) } });
        let bodyText = '';
        try { bodyText = await resp.text(); } catch {}
        // AllDebrid returns 200 with status success/error in JSON
        try {
            const j = bodyText ? JSON.parse(bodyText) : {};
            if (j && j.status === 'success') return j.data || j; // prefer data
            // map common errors
            const rawCode = j?.error?.code;
            const code = rawCode || `${resp.status}`;
            const msg = j?.error?.message || resp.statusText || 'AD error';
            const err = new Error(`AD ${endpoint} failed: ${code} ${msg}`);
            // normalize auth errors
            if (rawCode === 'AUTH_BAD_APIKEY' || rawCode === 'AUTH_MISSING') {
                err.code = 'AD_AUTH_INVALID';
                err.rawCode = rawCode;
            } else if (rawCode === 'AUTH_BLOCKED') {
                err.code = 'AD_AUTH_BLOCKED';
                err.rawCode = rawCode;
            } else {
                err.code = code;
            }
            throw err;
        } catch (e) {
            if (e instanceof SyntaxError) {
                if (!resp.ok) throw new Error(`AD ${endpoint} http ${resp.status}`);
                return bodyText;
            }
            throw e;
        }
    }

    // --- TorBox minimal adapter ---
    const TB_BASE = 'https://api.torbox.app/v1';
    async function tbFetch(endpoint, opts = {}) {
        const s = readSettings();
        if (!s.tbApiKey) throw new Error('Not authenticated with TorBox');
        const url = `${TB_BASE}${endpoint}`;
        console.log('[TB][call]', { endpoint, method: (opts.method || 'GET').toUpperCase() });
        const resp = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${s.tbApiKey}`, Accept: 'application/json', ...(opts.headers || {}) } });
        const ct = resp.headers.get('content-type') || '';
        let bodyText = '';
        try { bodyText = await resp.text(); } catch {}
        let data = null;
        if (/json/i.test(ct)) {
            try { data = bodyText ? JSON.parse(bodyText) : null; } catch {}
        }
        if (!resp.ok) {
            const lower = (bodyText || '').toLowerCase();
            // Clear token on auth errors
            if (resp.status === 401 || lower.includes('unauthorized') || lower.includes('invalid token')) {
                try { const cur = readSettings(); writeSettings({ ...cur, tbApiKey: null }); } catch {}
                const err = new Error('TorBox authentication invalid'); err.code = 'TB_AUTH_INVALID'; throw err;
            }
            if (resp.status === 429 || lower.includes('rate')) { const err = new Error('TorBox rate limited'); err.code = 'TB_RATE_LIMIT'; throw err; }
            if (resp.status === 402 || lower.includes('premium')) { const err = new Error('TorBox premium required'); err.code = 'RD_PREMIUM_REQUIRED'; throw err; }
            const err = new Error(`TB ${endpoint} failed: ${resp.status} ${truncate(bodyText, 300)}`);
            throw err;
        }
        return data != null ? data : bodyText;
    }

    // Robust TorBox: try multiple payloads/endpoints for creating a torrent from a magnet
    async function tbCreateTorrentFromMagnet(magnet) {
        const attempts = [
            { ep: '/api/torrents/createtorrent', type: 'form', body: { link: magnet } },
            { ep: '/api/torrents/createtorrent', type: 'form', body: { magnet: magnet } },
            { ep: '/api/torrents/createtorrent', type: 'json', body: { link: magnet } },
            { ep: '/api/torrents/createtorrent', type: 'json', body: { magnet_link: magnet } },
            { ep: '/api/torrents/addmagnet',     type: 'form', body: { link: magnet } },
            { ep: '/api/torrents/addmagnet',     type: 'form', body: { magnet: magnet } },
        ];
        let lastErr = null;
        for (const a of attempts) {
            try {
                const headers = a.type === 'json'
                    ? { 'Content-Type': 'application/json' }
                    : { 'Content-Type': 'application/x-www-form-urlencoded' };
                const body = a.type === 'json'
                    ? JSON.stringify(a.body)
                    : new URLSearchParams(a.body);
                const r = await tbFetch(a.ep, { method: 'POST', headers, body });
                // Normalize id from different shapes
                const id = r?.id || r?.torrent_id || r?.data?.id || r?.data?.torrent_id;
                if (id) return { ok: true, id: String(id), raw: r };
                // Some APIs wrap under data.torrent
                const did = r?.data?.torrent?.id || r?.data?.torrent_id;
                if (did) return { ok: true, id: String(did), raw: r };
                lastErr = new Error('TorBox create returned no id');
            } catch (e) {
                lastErr = e;
                // If missing required option, try next shape
                const msg = (e?.message || '').toLowerCase();
                if (/missing_required_option|missing|required/.test(msg)) continue;
                // Auth/rate handled by caller via codes thrown in tbFetch
            }
        }
        if (lastErr) throw lastErr;
        throw new Error('Failed to create TorBox torrent');
    }

    // Get a TorBox direct link for streaming for a specific torrent/file id
    async function tbRequestDirectLink(torrentId, fileId) {
        const s = readSettings();
        const authHeader = { Authorization: `Bearer ${s.tbApiKey}` };
        const candidates = [
            // Preferred: POST form, stream=true, redirect=false -> JSON
            { method: 'POST', type: 'form', ep: '/api/torrents/requestdl', qs: {}, body: { torrent_id: String(torrentId), file_id: String(fileId), stream: 'true', redirect: 'false' } },
            // Alt: POST form, no stream flag
            { method: 'POST', type: 'form', ep: '/api/torrents/requestdl', qs: {}, body: { torrent_id: String(torrentId), file_id: String(fileId), redirect: 'false' } },
            // Alt keys: id instead of torrent_id
            { method: 'POST', type: 'form', ep: '/api/torrents/requestdl', qs: {}, body: { id: String(torrentId), file_id: String(fileId), stream: 'true', redirect: 'false' } },
            // GET with query params
            { method: 'GET', type: 'query', ep: '/api/torrents/requestdl', qs: { torrent_id: String(torrentId), file_id: String(fileId), stream: 'true', redirect: 'false' } },
            { method: 'GET', type: 'query', ep: '/api/torrents/requestdl', qs: { id: String(torrentId), file_id: String(fileId), redirect: 'false' } },
            // Redirect flow: let server 302, capture Location
            { method: 'POST', type: 'form-redirect', ep: '/api/torrents/requestdl', qs: {}, body: { torrent_id: String(torrentId), file_id: String(fileId), stream: 'true', redirect: 'true' } },
            { method: 'GET', type: 'redirect', ep: '/api/torrents/requestdl', qs: { torrent_id: String(torrentId), file_id: String(fileId), stream: 'true', redirect: 'true' } },
        ];
        let lastErr;
        for (const c of candidates) {
            try {
                if (c.type === 'form' || c.type === 'query') {
                    const headers = c.type === 'form' ? { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } : { ...authHeader, Accept: 'application/json' };
                    const qs = new URLSearchParams(c.qs || {});
                    const url = `${TB_BASE}${c.ep}${qs.toString() ? `?${qs}` : ''}`;
                    const body = c.type === 'form' ? new URLSearchParams(c.body || {}) : undefined;
                    const r = await fetch(url, { method: c.method, headers, body });
                    const ct = r.headers.get('content-type') || '';
                    let data = null;
                    if (/json/i.test(ct)) { try { data = await r.json(); } catch {} }
                    else { try { const t = await r.text(); if (t && /^https?:\/\//i.test(t.trim())) return t.trim(); } catch {} }
                    const urlField = data?.url || data?.link || data?.data?.url || data?.data?.link;
                    if (urlField && /^https?:\/\//i.test(urlField)) return urlField;
                    lastErr = new Error('No direct URL in response');
                } else if (c.type === 'form-redirect' || c.type === 'redirect') {
                    const headers = c.type.startsWith('form') ? { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' } : { ...authHeader };
                    const qs = new URLSearchParams(c.qs || {});
                    const url = `${TB_BASE}${c.ep}${qs.toString() ? `?${qs}` : ''}`;
                    const body = c.type.startsWith('form') ? new URLSearchParams(c.body || {}) : undefined;
                    const r = await fetch(url, { method: c.method, headers, body, redirect: 'manual' });
                    const loc = r.headers.get('location');
                    if (loc && /^https?:\/\//i.test(loc)) return loc;
                    lastErr = new Error(`Unexpected status ${r.status}`);
                }
            } catch (e) {
                lastErr = e;
                // Try next variant on parameter mismatch or unsupported option
                continue;
            }
        }
        if (lastErr) throw lastErr;
        throw new Error('Failed to resolve TorBox direct link');
    }

    // TorBox Stream API per docs: /api/stream/createstream then /api/stream/getstreamdata
    async function tbCreateStream({ id, file_id, type = 'torrent', chosen_subtitle_index = null, chosen_audio_index = 0 }) {
        const s = readSettings();
        const makeQs = (subIdx) => {
            const qs = new URLSearchParams();
            qs.set('id', String(id));
            qs.set('file_id', String(file_id));
            qs.set('type', String(type));
            qs.set('chosen_audio_index', String(chosen_audio_index || 0));
            // Handle subtitle index - null means no subtitle
            if (subIdx === null || subIdx === undefined) {
                // Don't set the parameter at all for null
            } else {
                qs.set('chosen_subtitle_index', String(subIdx));
            }
            return qs;
        };
        
        // Call TorBox API directly, not through tbFetch to see raw response
        const url = `${TB_BASE}/api/stream/createstream?${makeQs(chosen_subtitle_index).toString()}`;
        console.log('[TB][createstream] calling:', url);
        const resp = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${s.tbApiKey}`,
                'Accept': 'application/json'
            }
        });
        
        if (!resp.ok) {
            const text = await resp.text();
            console.error('[TB][createstream] HTTP error:', resp.status, text);
            throw new Error(`TorBox createstream failed: ${resp.status} ${text}`);
        }
        
        const data = await resp.json();
        console.log('[TB][createstream] raw response:', JSON.stringify(data, null, 2));
        return data;
    }
    
    async function tbGetStreamData({ presigned_token, token, chosen_subtitle_index = null, chosen_audio_index = 0 }) {
        const s = readSettings();
        const qs = new URLSearchParams();
        if (presigned_token) qs.set('presigned_token', presigned_token);
        if (token) qs.set('token', token);
        else if (s.tbApiKey) qs.set('token', s.tbApiKey);
        if (chosen_subtitle_index === null || chosen_subtitle_index === undefined) {
            // Don't set parameter for null
        } else {
            qs.set('chosen_subtitle_index', String(chosen_subtitle_index));
        }
        qs.set('chosen_audio_index', String(chosen_audio_index || 0));
        
        const url = `${TB_BASE}/api/stream/getstreamdata?${qs.toString()}`;
        console.log('[TB][getstreamdata] calling:', url);
        const resp = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${s.tbApiKey}`,
                'Accept': 'application/json'
            }
        });
        
        if (!resp.ok) {
            const text = await resp.text();
            console.error('[TB][getstreamdata] HTTP error:', resp.status, text);
            throw new Error(`TorBox getstreamdata failed: ${resp.status} ${text}`);
        }
        
        const data = await resp.json();
        console.log('[TB][getstreamdata] raw response:', JSON.stringify(data, null, 2));
        return data;
    }

    function extractHttpUrls(obj, out = []) {
        if (!obj) return out;
        if (typeof obj === 'string') {
            if (/^https?:\/\//i.test(obj)) out.push(obj);
            return out;
        }
        if (Array.isArray(obj)) {
            for (const v of obj) extractHttpUrls(v, out);
            return out;
        }
        if (typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'string') {
                    if (/^https?:\/\//i.test(v)) out.push(v);
                } else if (v && (typeof v === 'object' || Array.isArray(v))) {
                    extractHttpUrls(v, out);
                }
            }
        }
        return out;
    }

    function extractNamedStringDeep(obj, names = []) {
        if (!obj) return null;
        const seen = new Set();
        const stack = [obj];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur || typeof cur !== 'object') continue;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const [k, v] of Object.entries(cur)) {
                if (v && typeof v === 'object') stack.push(v);
                if (typeof v === 'string') {
                    const lowerK = k.toLowerCase();
                    if (names.some(n => lowerK === n.toLowerCase())) return v;
                }
            }
        }
        return null;
    }

    // Premiumize.me API helper
    const PM_BASE = 'https://www.premiumize.me/api';
    async function pmFetch(endpoint, opts = {}) {
        const s = readSettings();
        if (!s.pmApiKey) {
            const err = new Error('Not authenticated with Premiumize');
            err.code = 'PM_AUTH_INVALID';
            throw err;
        }
        
        // Build URL with apikey parameter
        const url = new URL(`${PM_BASE}${endpoint}`);
        url.searchParams.set('apikey', s.pmApiKey);
        
        console.log('[PM][call]', { endpoint, method: (opts.method || 'GET').toUpperCase() });
        
        const resp = await fetch(url.toString(), {
            ...opts,
            headers: {
                'Accept': 'application/json',
                ...(opts.headers || {})
            }
        });
        
        const ct = resp.headers.get('content-type') || '';
        let bodyText = '';
        try { bodyText = await resp.text(); } catch {}
        
        let data = null;
        if (/json/i.test(ct)) {
            try { data = bodyText ? JSON.parse(bodyText) : null; } catch {}
        }
        
        if (!resp.ok) {
            const lower = (bodyText || '').toLowerCase();
            // Clear API key on auth errors
            if (resp.status === 401 || resp.status === 403 || lower.includes('unauthorized') || lower.includes('invalid') || lower.includes('auth')) {
                try { 
                    const cur = readSettings(); 
                    writeSettings({ ...cur, pmApiKey: null }); 
                } catch {}
                const err = new Error('Premiumize authentication invalid');
                err.code = 'PM_AUTH_INVALID';
                throw err;
            }
            if (resp.status === 429 || lower.includes('rate')) {
                const err = new Error('Premiumize rate limited');
                err.code = 'PM_RATE_LIMIT';
                throw err;
            }
            if (resp.status === 402 || lower.includes('premium')) {
                const err = new Error('Premiumize premium required');
                err.code = 'PM_PREMIUM_REQUIRED';
                throw err;
            }
            const err = new Error(`PM ${endpoint} failed: ${resp.status} ${truncate(bodyText, 300)}`);
            throw err;
        }
        
        // Check for API-level error in response
        if (data && data.status === 'error') {
            const errMsg = data.message || 'Premiumize API error';
            if (/auth|unauthorized|invalid/i.test(errMsg)) {
                try { 
                    const cur = readSettings(); 
                    writeSettings({ ...cur, pmApiKey: null }); 
                } catch {}
                const err = new Error(errMsg);
                err.code = 'PM_AUTH_INVALID';
                throw err;
            }
            throw new Error(errMsg);
        }
        
        return data != null ? data : bodyText;
    }

    // Save/clear AllDebrid API key manually (optional)
    app.post('/api/debrid/ad/apikey', (req, res) => {
        try {
            const s = readSettings();
            const key = (req.body?.apikey || '').toString().trim();
            const next = { ...s, adApiKey: key || null };
            const ok = writeSettings(next);
            if (!ok) return res.status(500).json({ success: false, error: 'Failed to save apikey' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'Failed' });
        }
    });

    // TorBox token save/clear (placeholder auth storage)
    app.post('/api/debrid/tb/token', (req, res) => {
        try {
            const s = readSettings();
            const token = (req.body?.token || '').toString().trim();
            const next = { ...s, tbApiKey: token || null };
            const ok = writeSettings(next);
            if (!ok) return res.status(500).json({ success: false, error: 'Failed to save TorBox token' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'Failed' });
        }
    });

    // Premiumize API key save/clear
    app.post('/api/debrid/pm/apikey', (req, res) => {
        try {
            const s = readSettings();
            const apikey = (req.body?.apikey || '').toString().trim();
            const next = { ...s, pmApiKey: apikey || null };
            const ok = writeSettings(next);
            if (!ok) return res.status(500).json({ success: false, error: 'Failed to save Premiumize API key' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'Failed' });
        }
    });

    // AllDebrid PIN start
    app.get('/api/debrid/ad/pin', async (req, res) => {
        try {
            const r = await fetch('https://api.alldebrid.com/v4.1/pin/get');
            const j = await r.json();
            if (j?.status !== 'success') return res.status(502).json({ error: j?.error?.message || 'Failed to start PIN' });
            res.json(j.data || {});
        } catch (e) {
            res.status(502).json({ error: e?.message || 'Failed to start AD pin' });
        }
    });

    // AllDebrid PIN check (poll until apikey)
    app.post('/api/debrid/ad/check', async (req, res) => {
        try {
            const { pin, check } = req.body || {};
            if (!pin || !check) return res.status(400).json({ error: 'Missing pin/check' });
            const r = await fetch('https://api.alldebrid.com/v4/pin/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: new URLSearchParams({ pin, check })
            });
            const j = await r.json();
            if (j?.status !== 'success') return res.status(400).json({ error: j?.error?.message || 'PIN invalid or expired' });
            const data = j.data || {};
            if (data.activated && data.apikey) {
                const s = readSettings();
                writeSettings({ ...s, adApiKey: data.apikey });
                return res.json({ success: true });
            }
            res.json({ success: false, activated: !!data.activated, expires_in: data.expires_in || 0 });
        } catch (e) {
            res.status(502).json({ error: e?.message || 'AD check failed' });
        }
    });

    // RD device-code: start flow (requires rdClientId provided in settings or param)
    app.get('/api/debrid/rd/device-code', async (req, res) => {
        try {
            const s = readSettings();
            const clientId = (req.query.client_id || s.rdClientId || '').toString().trim();
            if (!clientId) return res.status(400).json({ error: 'Missing Real-Debrid client_id' });
            console.log('[RD][device-code] start', { clientId: mask(clientId) });
            
            // Real-Debrid device code endpoint requires GET with query parameters
            const url = new URL('https://api.real-debrid.com/oauth/v2/device/code');
            url.searchParams.append('client_id', clientId);
            url.searchParams.append('new_credentials', 'yes');
            
            const r = await fetch(url.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            
            if (!r.ok) {
                const errorText = await r.text();
                console.error('[RD][device-code] error response:', errorText);
                return res.status(r.status).json({ error: errorText });
            }
            
            const j = await r.json();
            console.log('[RD][device-code] response', { verification_url: j?.verification_url, interval: j?.interval, expires_in: j?.expires_in });
            res.json(j); // { device_code, user_code, interval, expires_in, verification_url }
        } catch (e) {
            console.error('[RD][device-code] error', e?.message);
            res.status(502).json({ error: e?.message || 'Device code start failed' });
        }
    });

    // RD device-code: poll for token
    app.post('/api/debrid/rd/poll', async (req, res) => {
        try {
            const s = readSettings();
            const clientId = (req.body?.client_id || s.rdClientId || '').toString().trim();
            const deviceCode = (req.body?.device_code || '').toString().trim();
            if (!clientId || !deviceCode) return res.status(400).json({ error: 'Missing client_id or device_code' });
            console.log('[RD][poll] begin', { clientId: mask(clientId), deviceCode: mask(deviceCode) });

            // Step 1: obtain client credentials
            const credsUrl = new URL('https://api.real-debrid.com/oauth/v2/device/credentials');
            credsUrl.searchParams.append('client_id', clientId);
            credsUrl.searchParams.append('code', deviceCode);
            
            const credsRes = await fetch(credsUrl.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            
            if (!credsRes.ok) {
                const errorText = await credsRes.text();
                console.error('[RD][poll] credentials error:', errorText);
                return res.status(credsRes.status).json({ error: errorText });
            }
            
            const creds = await credsRes.json(); // { client_id, client_secret }
            if (!creds.client_id || !creds.client_secret) {
                console.error('[RD][poll] invalid credentials response:', creds);
                return res.status(500).json({ error: 'Invalid credentials response' });
            }
            console.log('[RD][poll] creds ok');

            // Step 2: exchange for access token
            const tokenBody = new URLSearchParams({
                client_id: creds.client_id,
                client_secret: creds.client_secret,
                code: deviceCode,
                grant_type: 'http://oauth.net/grant_type/device/1.0'
            });
            const tokenRes = await fetch('https://api.real-debrid.com/oauth/v2/token', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenBody
            });
            
            if (!tokenRes.ok) {
                const errorText = await tokenRes.text();
                console.error('[RD][poll] token error:', errorText);
                return res.status(tokenRes.status).json({ error: errorText });
            }
            
            const token = await tokenRes.json();
            if (!token.access_token) {
                console.error('[RD][poll] no access_token in response:', token);
                return res.status(500).json({ error: 'No access_token returned' });
            }
            
            const next = { ...s, rdToken: token.access_token, rdRefresh: token.refresh_token || null, rdCredId: creds.client_id, rdCredSecret: creds.client_secret };
            writeSettings(next);
            console.log('[RD][poll] token saved', { hasRefresh: !!token.refresh_token });
            res.json({ success: true });
        } catch (e) {
            console.error('[RD][poll] error', e?.message, e?.stack);
            res.status(502).json({ error: e?.message || 'Device code poll failed' });
        }
    });

    // Download any subtitle by direct URL and serve as .vtt (when possible)
    app.post('/api/subtitles/download-direct', async (req, res) => {
        try {
            ensureSubsDir();
            const { url, preferredName } = req.body || {};
            if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
                return res.status(400).json({ error: 'Invalid url' });
            }
            const r = await fetch(url);
            if (!r.ok) return res.status(500).json({ error: `Failed to fetch subtitle (${r.status})` });
            const buf = Buffer.from(await r.arrayBuffer());
            const ct = r.headers.get('content-type') || '';
            const cd = r.headers.get('content-disposition') || '';
            let base = preferredName || 'subtitle';
            let ext = '.srt';
            const m = cd.match(/filename="?([^";]+)"?/i);
            if (m) {
                base = m[1].replace(/\.[^.]+$/,'');
            }
            if (/vtt/i.test(ct)) ext = '.vtt';
            else if (/srt/i.test(ct)) ext = '.srt';
            else if (/ass|ssa/i.test(ct)) ext = '.ass';
            // Convert to VTT when SRT detected
            let text = buf.toString('utf8');
            let finalPath = '';
            if (ext === '.vtt' || /^\s*WEBVTT/i.test(text)) {
                finalPath = path.join(SUB_TMP_DIR, `${base}.vtt`);
                fs.writeFileSync(finalPath, /^\s*WEBVTT/i.test(text) ? text : `WEBVTT\n\n${text}`);
            } else if (ext === '.srt' || /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->/m.test(text)) {
                const vtt = srtToVtt(text);
                finalPath = path.join(SUB_TMP_DIR, `${base}.vtt`);
                fs.writeFileSync(finalPath, vtt);
            } else if (ext === '.ass' || /\[Script Info\]/i.test(text)) {
                const vtt = assToVtt(text);
                finalPath = path.join(SUB_TMP_DIR, `${base}.vtt`);
                fs.writeFileSync(finalPath, vtt);
            } else {
                finalPath = path.join(SUB_TMP_DIR, `${base}.vtt`);
                fs.writeFileSync(finalPath, `WEBVTT\n\n${text}`);
            }
            const servedName = path.basename(finalPath);
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            res.json({ url: `${baseUrl}/subtitles/${encodeURIComponent(servedName)}`, filename: servedName });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to download direct subtitle' });
        }
    });

    // --- Real-Debrid minimal adapter ---
    const RD_BASE = 'https://api.real-debrid.com/rest/1.0';
    let rdRefreshing = false;
    async function rdFetch(endpoint, opts = {}) {
        const started = Date.now();
        const attempt = async (token) => {
            const url = `${RD_BASE}${endpoint}`;
            console.log('[RD][call]', { endpoint, method: (opts.method || 'GET').toUpperCase() });
            const response = await fetch(url, {
                ...opts,
                headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
            });
            return response;
        };
        let s = readSettings();
        if (!s.rdToken) throw new Error('Not authenticated with Real-Debrid');
        let resp = await attempt(s.rdToken);
        if (resp.status === 401 || resp.status === 403) {
            // Try token refresh if possible
            if (!rdRefreshing && s.rdRefresh && s.rdCredId && s.rdCredSecret) {
                try {
                    rdRefreshing = true;
                    console.warn('[RD][refresh] attempting refresh_token flow');
                    const tb = new URLSearchParams({
                        client_id: s.rdCredId,
                        client_secret: s.rdCredSecret,
                        code: s.rdRefresh,
                        grant_type: 'refresh_token'
                    });
                    const tr = await fetch('https://api.real-debrid.com/oauth/v2/token', {
                        method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: tb
                    });
                    if (tr.ok) {
                        const tj = await tr.json();
                        const next = { ...s, rdToken: tj.access_token || s.rdToken, rdRefresh: tj.refresh_token || s.rdRefresh };
                        writeSettings(next);
                        s = next;
                        console.log('[RD][refresh] success, token rotated');
                    }
                } catch {}
                finally { rdRefreshing = false; }
                // Retry once
                resp = await attempt(s.rdToken);
            }
        }
        if (!resp.ok) {
            let msg = resp.statusText;
            try { msg = await resp.text(); } catch {}
            // Decide whether this is an auth issue that requires clearing tokens
            const lowerMsg = (msg || '').toLowerCase();
            const isAuthInvalid = resp.status === 401 || (resp.status === 403 && (lowerMsg.includes('bad_token') || lowerMsg.includes('invalid_token')));
            if (isAuthInvalid) {
                try {
                    const cleared = { ...s, rdToken: null, rdRefresh: null };
                    writeSettings(cleared);
                    console.warn('[RD] cleared invalid token (logged out)');
                } catch {}
            }
            console.error('[RD][call] error', { endpoint, status: resp.status, msg: truncate(msg) });
            throw new Error(`RD ${endpoint} failed: ${resp.status} ${msg}`);
        }
        const ct = resp.headers.get('content-type') || '';
        const elapsed = Date.now() - started;
        console.log('[RD][call] ok', { endpoint, status: resp.status, ms: elapsed });
        return /json/i.test(ct) ? resp.json() : resp.text();
    }

    // Debrid availability by info hash (RD instant availability; TorBox cached availability)
    app.get('/api/debrid/availability', async (req, res) => {
        try {
            const s = readSettings();
            if (!s.useDebrid) return res.status(400).json({ error: 'Debrid disabled' });
            const btih = String(req.query.btih || '').trim().toUpperCase();
            if (!btih || btih.length < 32) return res.status(400).json({ error: 'Invalid btih' });
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            if (provider === 'realdebrid') {
                console.log('[RD][availability]', { btih });
                const data = await rdFetch(`/torrents/instantAvailability/${btih}`);
                const available = !!(data && (data[btih] || data[btih.toLowerCase()]));
                return res.json({ provider: 'realdebrid', available, raw: data });
            }
            if (provider === 'torbox') {
                console.log('[TB][availability]', { btih });
                try {
                    const data = await tbFetch(`/api/torrents/checkcached?hash=${encodeURIComponent(btih)}&format=object`);
                    // Heuristic: available if object contains the hash key or indicates truthy cached/list
                    const lower = btih.toLowerCase();
                    const available = !!(data && (data[btih] || data[lower] || data?.cached || (Array.isArray(data?.list) && data.list.length)));
                    return res.json({ provider: 'torbox', available, raw: data });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'TB_AUTH_INVALID') return res.status(401).json({ error: 'TorBox authentication invalid.', code: 'DEBRID_UNAUTH' });
                    if (e?.code === 'TB_RATE_LIMIT' || /429/.test(msg)) return res.status(429).json({ error: 'TorBox rate limit. Try again shortly.', code: 'TB_RATE_LIMIT' });
                    return res.status(502).json({ error: 'TorBox availability failed' });
                }
            }
            if (provider === 'premiumize') {
                console.log('[PM][availability]', { btih });
                try {
                    const data = await pmFetch(`/cache/check?items[]=${encodeURIComponent(btih)}`);
                    // Premiumize returns { status: 'success', response: [true/false], transcoded: [...] }
                    const available = !!(data && data.status === 'success' && Array.isArray(data.response) && data.response[0] === true);
                    return res.json({ provider: 'premiumize', available, raw: data });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'PM_AUTH_INVALID') return res.status(401).json({ error: 'Premiumize authentication invalid.', code: 'DEBRID_UNAUTH' });
                    if (e?.code === 'PM_RATE_LIMIT' || /429/.test(msg)) return res.status(429).json({ error: 'Premiumize rate limit. Try again shortly.', code: 'PM_RATE_LIMIT' });
                    return res.status(502).json({ error: 'Premiumize availability failed' });
                }
            }
            return res.status(400).json({ error: 'Availability not supported for this provider' });
        } catch (e) {
            const msg = e?.message || '';
            console.error('[RD][availability] error', msg);
            if (/\s429\s/i.test(msg) || /too_many_requests/i.test(msg)) {
                return res.status(429).json({ error: 'Real‑Debrid rate limit. Try again shortly.', code: 'RD_RATE_LIMIT' });
            }
            if (/disabled_endpoint/i.test(msg)) {
                return res.status(403).json({ error: 'Real‑Debrid availability endpoint disabled for this account.', code: 'RD_FEATURE_UNAVAILABLE' });
            }
            res.status(502).json({ error: msg || 'Debrid availability failed' });
        }
    });

    // Add magnet to Debrid provider. Returns torrent id and current info.
    app.post('/api/debrid/prepare', async (req, res) => {
        try {
            const s = readSettings();
            if (!s.useDebrid) return res.status(400).json({ error: 'Debrid disabled' });
            const magnet = (req.body?.magnet || '').toString();
            if (!magnet.startsWith('magnet:')) return res.status(400).json({ error: 'Missing magnet' });
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            if (provider === 'realdebrid') {
                console.log('[RD][prepare] addMagnet');
                const addRes = await rdFetch('/torrents/addMagnet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ magnet })
                });
                const id = addRes?.id;
                if (!id) return res.status(500).json({ error: 'Failed to add magnet' });
                console.log('[RD][prepare] added', { id });
                const info = await rdFetch(`/torrents/info/${id}`);
                return res.json({ id, info });
            } else if (provider === 'alldebrid') {
                console.log('[AD][prepare] magnet/upload');
                // Upload magnet
                let data;
                try {
                    data = await adFetch('/magnet/upload', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams([['magnets[]', magnet]])
                    });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'AD_AUTH_INVALID' || /AUTH_BAD_APIKEY|Not authenticated with AllDebrid/i.test(msg)) {
                        // Clear invalid key so UI reflects logged-out state
                        const cur = readSettings();
                        writeSettings({ ...cur, adApiKey: null });
                        return res.status(401).json({ error: 'AllDebrid authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    }
                    if (e?.code === 'AD_AUTH_BLOCKED' || /AUTH_BLOCKED/i.test(msg)) {
                        return res.status(403).json({ error: 'AllDebrid security check: verify the authorization email, then retry.', code: 'AD_AUTH_BLOCKED' });
                    }
                    if (e?.code === 'MAGNET_MUST_BE_PREMIUM' || /MUST_BE_PREMIUM/i.test(msg)) {
                        return res.status(403).json({ error: 'AllDebrid premium is required to add torrents.', code: 'RD_PREMIUM_REQUIRED' });
                    }
                    throw e;
                }
                const first = Array.isArray(data?.magnets) ? data.magnets.find(m => m?.id) : null;
                const id = first?.id?.toString();
                if (!id) return res.status(500).json({ error: 'Failed to add magnet' });
                // Gather status and files
                let filename = null;
                try {
                    const st2 = await fetch('https://api.alldebrid.com/v4.1/magnet/status', { method: 'POST', headers: { 'Authorization': `Bearer ${readSettings().adApiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id }) });
                    if (st2.ok) {
                        const j = await st2.json();
                        if (j?.status === 'success' && Array.isArray(j?.data?.magnets) && j.data.magnets[0]?.filename) filename = j.data.magnets[0].filename;
                    }
                } catch {}
                // Get files tree
                const filesData = await adFetch('/magnet/files', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams([['id[]', id]])
                });
                const record = Array.isArray(filesData?.magnets) ? filesData.magnets.find(m => String(m?.id) === String(id)) : null;
                const outFiles = [];
                let counter = 1;
                const walk = (nodes, base = '') => {
                    if (!Array.isArray(nodes)) return;
                    for (const n of nodes) {
                        if (n.e) {
                            walk(n.e, base ? `${base}/${n.n}` : n.n);
                        } else {
                            const full = base ? `${base}/${n.n}` : n.n;
                            outFiles.push({ id: counter++, path: full, filename: full, bytes: Number(n.s || 0), size: Number(n.s || 0), links: n.l ? [n.l] : [] });
                        }
                    }
                };
                if (record?.files) walk(record.files, '');
                const info = { id, filename: filename || (first?.name || 'Magnet'), files: outFiles };
                return res.json({ id, info });
            } else if (provider === 'torbox') {
                console.log('[TB][prepare] createtorrent');
                let createdId;
                try {
                    const out = await tbCreateTorrentFromMagnet(magnet);
                    createdId = out?.id;
                } catch (e) {
                    const code = e?.code || '';
                    const msg = e?.message || '';
                    if (code === 'TB_AUTH_INVALID') return res.status(401).json({ error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    if (code === 'TB_RATE_LIMIT') return res.status(429).json({ error: 'TorBox rate limit. Try again shortly.', code: 'TB_RATE_LIMIT' });
                    if (code === 'RD_PREMIUM_REQUIRED') return res.status(403).json({ error: 'TorBox premium is required to add torrents.', code: 'RD_PREMIUM_REQUIRED' });
                    if (/missing_required_option/i.test(msg)) return res.status(400).json({ error: 'TorBox rejected the magnet payload.', code: 'TB_BAD_PAYLOAD' });
                    throw e;
                }
                const id = createdId;
                if (!id) return res.status(500).json({ error: 'Failed to add magnet (TorBox)' });
                // Fetch files info; may need a short wait for metadata
                let infoObj = null;
                for (let i = 0; i < 10; i++) {
                    try {
                        const details = await tbFetch(`/api/torrents/mylist?id=${encodeURIComponent(String(id))}&bypassCache=true`);
                        console.log('[TB][mylist] response:', JSON.stringify(details, null, 2));
                        // Normalize into our shape
                        const tor = Array.isArray(details?.data) ? details.data[0] : (details?.data || details || null);
                        if (tor) {
                            const files = [];
                            const rawFiles = tor.files || tor.file_list || [];
                            const stateRaw = (tor.download_state || tor.downloadState || tor.state || tor.status || '').toString().toLowerCase();
                            const isCached = stateRaw.includes('cached');
                            console.log('[TB][files] found', rawFiles.length, 'files, state:', stateRaw, 'cached:', isCached);
                            let counter = 1;
                            for (const f of rawFiles) {
                                // Use the actual file ID from TorBox - they use f.id starting from 0
                                const fid = f.id !== undefined ? f.id : (f.file_id !== undefined ? f.file_id : (f.index !== undefined ? f.index : counter));
                                const fname = f.name || f.filename || f.path || `file_${fid}`;
                                const fsize = Number(f.size || f.bytes || f.length || 0);
                                console.log('[TB][file]', { originalId: f.id, fileId: f.file_id, index: f.index, mappedId: fid, name: fname });
                                // Provide a virtual torbox link only when cached; else keep links empty to trigger polling UX
                                const vlink = `torbox://${id}/${fid}`;
                                const links = isCached ? [vlink] : [];
                                files.push({ id: fid, path: fname, filename: fname, bytes: fsize, size: fsize, links });
                                counter++;
                            }
                            infoObj = { id: String(tor.id || id), filename: tor.name || tor.filename || 'TorBox Torrent', files };
                        }
                        if (infoObj && infoObj.files && infoObj.files.length) break;
                    } catch {}
                    await new Promise(r => setTimeout(r, 800));
                }
                if (!infoObj) infoObj = { id: String(id), filename: 'TorBox Torrent', files: [] };
                return res.json({ id: String(id), info: infoObj });
            } else if (provider === 'premiumize') {
                console.log('[PM][prepare] transfer/directdl');
                let data;
                try {
                    // Use /transfer/directdl to get instant cached links or create transfer
                    data = await pmFetch('/transfer/directdl', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ src: magnet })
                    });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'PM_AUTH_INVALID' || /auth|unauthorized/i.test(msg)) {
                        const cur = readSettings();
                        writeSettings({ ...cur, pmApiKey: null });
                        return res.status(401).json({ error: 'Premiumize authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    }
                    if (e?.code === 'PM_PREMIUM_REQUIRED' || /premium/i.test(msg)) {
                        return res.status(403).json({ error: 'Premiumize premium is required to add torrents.', code: 'RD_PREMIUM_REQUIRED' });
                    }
                    throw e;
                }
                
                console.log('[PM][prepare] directdl response:', JSON.stringify(data, null, 2));
                
                // directdl returns: { status: 'success', content: [...files with links...] }
                if (data?.status === 'success' && Array.isArray(data.content)) {
                    const files = [];
                    for (let idx = 0; idx < data.content.length; idx++) {
                        const f = data.content[idx];
                        // Each file has: path, size, link, stream_link, transcode_status
                        const fname = f.path || f.name || `file_${idx}`;
                        const fsize = Number(f.size || 0);
                        // Prefer stream_link for videos, fallback to link
                        const flink = f.stream_link || f.link || '';
                        
                        files.push({
                            id: idx,
                            path: fname,
                            filename: fname,
                            bytes: fsize,
                            size: fsize,
                            links: flink ? [flink] : []
                        });
                    }
                    
                    const infoObj = {
                        id: 'directdl', // No transfer ID for directdl
                        filename: 'Premiumize Direct Download',
                        files
                    };
                    
                    return res.json({ id: 'directdl', info: infoObj });
                }
                
                // Fallback: if directdl didn't work, try transfer/create
                console.log('[PM][prepare] directdl failed, trying transfer/create');
                let transferData;
                try {
                    transferData = await pmFetch('/transfer/create', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ src: magnet })
                    });
                } catch (e) {
                    throw e;
                }
                
                const transferId = transferData?.id || transferData?.transfer?.id;
                if (!transferId) return res.status(500).json({ error: 'Failed to create Premiumize transfer' });
                
                console.log('[PM][prepare] transfer created:', transferId);
                
                // Wait for transfer to be ready and fetch file list
                let infoObj = null;
                for (let i = 0; i < 15; i++) {
                    try {
                        const listData = await pmFetch('/transfer/list');
                        if (listData && listData.status === 'success' && Array.isArray(listData.transfers)) {
                            const transfer = listData.transfers.find(t => String(t.id) === String(transferId));
                            if (transfer && transfer.status === 'finished') {
                                const files = [];
                                const fileList = Array.isArray(transfer.file_list) ? transfer.file_list : [];
                                
                                for (let idx = 0; idx < fileList.length; idx++) {
                                    const f = fileList[idx];
                                    const fname = f.path || f.name || `file_${idx}`;
                                    const fsize = Number(f.size || 0);
                                    const flink = f.stream_link || f.link || '';
                                    
                                    files.push({
                                        id: idx,
                                        path: fname,
                                        filename: fname,
                                        bytes: fsize,
                                        size: fsize,
                                        links: flink ? [flink] : []
                                    });
                                }
                                
                                infoObj = {
                                    id: String(transferId),
                                    filename: transfer.name || 'Premiumize Transfer',
                                    files
                                };
                                
                                if (files.length > 0) break;
                            }
                        }
                    } catch (e) {
                        console.log('[PM][prepare] waiting for files:', e.message);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                if (!infoObj) {
                    infoObj = { id: String(transferId), filename: 'Premiumize Transfer', files: [] };
                }
                
                return res.json({ id: String(transferId), info: infoObj });
            } else {
                return res.status(400).json({ error: 'Debrid provider not supported' });
            }
        } catch (e) {
            const msg = e?.message || '';
            console.error('[DEBRID][prepare] error', msg);
            // Map premium-required case to a clearer response
            if (/403\s+\{[^}]*permission_denied/i.test(msg)) {
                return res.status(403).json({
                    error: 'Real-Debrid premium is required to add torrents.',
                    code: 'RD_PREMIUM_REQUIRED'
                });
            }
            if (/MAGNET_MUST_BE_PREMIUM|MUST_BE_PREMIUM/i.test(msg)) {
                return res.status(403).json({ error: 'Debrid premium is required to add torrents.', code: 'RD_PREMIUM_REQUIRED' });
            }
            res.status(502).json({ error: msg || 'Debrid prepare failed' });
        }
    });

    // Debrid select files by id list or 'all' (RD supports, AD no-op)
    app.post('/api/debrid/select-files', async (req, res) => {
        try {
            const s = readSettings();
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            if (provider === 'alldebrid') {
                // No-op for AllDebrid
                return res.json({ success: true });
            }
            if (provider === 'torbox') {
                // No-op for TorBox (files unlocked per-file when requested)
                return res.json({ success: true });
            }
            if (provider === 'premiumize') {
                // No-op for Premiumize (files are already available)
                return res.json({ success: true });
            }
            const id = (req.body?.id || '').toString();
            const files = Array.isArray(req.body?.files) ? req.body.files.join(',') : (req.body?.files || 'all').toString();
            if (!id) return res.status(400).json({ error: 'Missing id' });
            console.log('[RD][select-files]', { id, files: files.split(',').slice(0,5) });
            const out = await rdFetch(`/torrents/selectFiles/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ files })
            });
            res.json({ success: true, out });
        } catch (e) {
            const msg = e?.message || '';
            console.error('[RD][select-files] error', msg);
            if (/403\s+\{[^}]*permission_denied/i.test(msg)) {
                return res.status(403).json({ success: false, error: 'Real-Debrid premium is required to select files.', code: 'RD_PREMIUM_REQUIRED' });
            }
            res.status(502).json({ success: false, error: msg || 'Debrid select files failed' });
        }
    });

    // List Debrid torrent info/files
    app.get('/api/debrid/files', async (req, res) => {
        try {
            const s = readSettings();
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            const id = (req.query?.id || '').toString();
            if (!id) return res.status(400).json({ error: 'Missing id' });
            if (provider === 'realdebrid') {
                console.log('[RD][files]', { id });
                const info = await rdFetch(`/torrents/info/${id}`);
                return res.json(info);
            }
            if (provider === 'alldebrid') {
                console.log('[AD][files]', { id });
                let filesData;
                try {
                    filesData = await adFetch('/magnet/files', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['id[]', id]]) });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'AD_AUTH_INVALID' || /AUTH_BAD_APIKEY|Not authenticated with AllDebrid/i.test(msg)) {
                        const cur = readSettings();
                        writeSettings({ ...cur, adApiKey: null });
                        return res.status(401).json({ error: 'AllDebrid authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    }
                    if (e?.code === 'AD_AUTH_BLOCKED' || /AUTH_BLOCKED/i.test(msg)) {
                        return res.status(403).json({ error: 'AllDebrid security check: verify the authorization email, then retry.', code: 'AD_AUTH_BLOCKED' });
                    }
                    throw e;
                }
                const record = Array.isArray(filesData?.magnets) ? filesData.magnets.find(m => String(m?.id) === String(id)) : null;
                const outFiles = [];
                let counter = 1;
                const walk = (nodes, base = '') => {
                    if (!Array.isArray(nodes)) return;
                    for (const n of nodes) {
                        if (n.e) walk(n.e, base ? `${base}/${n.n}` : n.n);
                        else outFiles.push({ id: counter++, path: base ? `${base}/${n.n}` : n.n, filename: n.n, bytes: Number(n.s || 0), size: Number(n.s || 0), links: n.l ? [n.l] : [] });
                    }
                };
                if (record?.files) walk(record.files, '');
                // Try to fetch filename via status (best-effort)
                let filename = null;
                try {
                    const r = await fetch('https://api.alldebrid.com/v4.1/magnet/status', { method: 'POST', headers: { 'Authorization': `Bearer ${readSettings().adApiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id }) });
                    if (r.ok) {
                        const j = await r.json();
                        if (j?.status === 'success' && Array.isArray(j?.data?.magnets) && j.data.magnets[0]?.filename) filename = j.data.magnets[0].filename;
                    }
                } catch {}
                return res.json({ id, filename: filename || null, files: outFiles });
            }
            if (provider === 'torbox') {
                console.log('[TB][files]', { id });
                try {
                    const details = await tbFetch(`/api/torrents/mylist?id=${encodeURIComponent(String(id))}&bypassCache=true`);
                    const tor = Array.isArray(details?.data) ? details.data[0] : (details?.data || details || null);
                    const outFiles = [];
                    if (tor) {
                        const rawFiles = tor.files || tor.file_list || [];
                        const stateRaw = (tor.download_state || tor.downloadState || tor.state || tor.status || '').toString().toLowerCase();
                        const isCached = stateRaw.includes('cached');
                        let counter = 1;
                        for (const f of rawFiles) {
                            const fid = f.id || f.file_id || counter;
                            const fname = f.name || f.filename || f.path || `file_${fid}`;
                            const fsize = Number(f.size || f.bytes || f.length || 0);
                            const vlink = `torbox://${id}/${fid}`;
                            const links = isCached ? [vlink] : [];
                            outFiles.push({ id: fid, path: fname, filename: fname, bytes: fsize, size: fsize, links });
                            counter++;
                        }
                    }
                    return res.json({ id: String(id), filename: tor?.name || tor?.filename || null, files: outFiles });
                } catch (e) {
                    const code = e?.code || '';
                    if (code === 'TB_AUTH_INVALID') return res.status(401).json({ error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    if (code === 'TB_RATE_LIMIT') return res.status(429).json({ error: 'TorBox rate limit. Try again shortly.', code: 'TB_RATE_LIMIT' });
                    throw e;
                }
            }
            if (provider === 'premiumize') {
                console.log('[PM][files]', { id });
                
                // Special case: if id is 'directdl', files were already provided in prepare response
                if (id === 'directdl') {
                    return res.status(400).json({ error: 'Use files from prepare response for directdl' });
                }
                
                try {
                    const listData = await pmFetch('/transfer/list');
                    if (listData && listData.status === 'success' && Array.isArray(listData.transfers)) {
                        const transfer = listData.transfers.find(t => String(t.id) === String(id));
                        if (!transfer) {
                            return res.status(404).json({ error: 'Transfer not found' });
                        }
                        
                        const outFiles = [];
                        const fileList = Array.isArray(transfer.file_list) ? transfer.file_list : [];
                        
                        for (let idx = 0; idx < fileList.length; idx++) {
                            const f = fileList[idx];
                            const fname = f.path || f.name || `file_${idx}`;
                            const fsize = Number(f.size || 0);
                            const flink = f.stream_link || f.link || '';
                            
                            outFiles.push({
                                id: idx,
                                path: fname,
                                filename: fname,
                                bytes: fsize,
                                size: fsize,
                                links: flink ? [flink] : []
                            });
                        }
                        
                        return res.json({
                            id: String(id),
                            filename: transfer.name || 'Premiumize Transfer',
                            files: outFiles
                        });
                    }
                    return res.status(404).json({ error: 'Transfer not found' });
                } catch (e) {
                    const code = e?.code || '';
                    if (code === 'PM_AUTH_INVALID') return res.status(401).json({ error: 'Premiumize authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    if (code === 'PM_RATE_LIMIT') return res.status(429).json({ error: 'Premiumize rate limit. Try again shortly.', code: 'PM_RATE_LIMIT' });
                    throw e;
                }
            }
            return res.status(400).json({ error: 'Debrid provider not supported' });
        } catch (e) {
            const msg = e?.message || '';
            console.error('[RD][files] error', msg);
            if (/403\s+\{[^}]*permission_denied/i.test(msg)) {
                return res.status(403).json({ error: 'Real-Debrid premium is required to view torrent info.', code: 'RD_PREMIUM_REQUIRED' });
            }
            res.status(502).json({ error: msg || 'Debrid files failed' });
        }
    });

    // Unrestrict a Debrid link into direct CDN URL
    app.post('/api/debrid/link', async (req, res) => {
        try {
            const s = readSettings();
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            const link = (req.body?.link || '').toString();
            if (!link) return res.status(400).json({ error: 'Missing link' });
            if (provider === 'realdebrid') {
                // RD torrent file links are already direct CDN links; check if streaming is available
                if (/^https?:\/\//i.test(link)) {
                    console.log('[RD][link] direct link:', link);
                    
                    // Try to get transcoding/streaming URL if available
                    try {
                        // Extract file ID from RD download link (format: https://domain/dl/ID/filename)
                        const match = link.match(/\/dl\/([^\/]+)\//);
                        if (match && match[1]) {
                            const fileId = match[1];
                            console.log('[RD][streaming] checking transcode for ID:', fileId);
                            try {
                                const transcodeInfo = await rdFetch(`/streaming/transcode/${fileId}`);
                                if (transcodeInfo && Array.isArray(transcodeInfo) && transcodeInfo.length > 0) {
                                    // Use the highest quality transcoded stream if available
                                    const bestStream = transcodeInfo.sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
                                    if (bestStream?.download) {
                                        console.log('[RD][streaming] using transcoded stream:', bestStream.download);
                                        return res.json({ url: bestStream.download, raw: transcodeInfo });
                                    }
                                }
                            } catch (transcodeError) {
                                console.log('[RD][streaming] transcode not available:', transcodeError.message);
                                // Fall back to direct link
                            }
                        }
                    } catch (e) {
                        console.log('[RD][streaming] streaming check failed:', e.message);
                    }
                    
                    return res.json({ url: link });
                }
                // Fallback: if some non-http value slipped through, try unrestrict
                try {
                    const out = await rdFetch('/unrestrict/link', {
                        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ link })
                    });
                    return res.json({ url: out?.download || null, raw: out });
                } catch (e) {
                    return res.status(502).json({ error: 'Failed to unrestrict RD link' });
                }
            }
            if (provider === 'alldebrid') {
                // AD magnet/file links need to be unlocked through /link/unlock API
                console.log('[AD][unlock] link:', link);
                console.log('[AD][unlock] start');
                let data;
                try {
                    data = await adFetch('/link/unlock', {
                        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ link })
                    });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'AD_AUTH_INVALID' || /AUTH_BAD_APIKEY|Not authenticated with AllDebrid/i.test(msg)) {
                        const cur = readSettings();
                        writeSettings({ ...cur, adApiKey: null });
                        return res.status(401).json({ error: 'AllDebrid authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    }
                    if (e?.code === 'AD_AUTH_BLOCKED' || /AUTH_BLOCKED/i.test(msg)) {
                        return res.status(403).json({ error: 'AllDebrid security check: verify the authorization email, then retry.', code: 'AD_AUTH_BLOCKED' });
                    }
                    if (e?.code === 'MUST_BE_PREMIUM' || /MUST_BE_PREMIUM/i.test(msg)) {
                        return res.status(403).json({ error: 'AllDebrid premium is required for this link.', code: 'RD_PREMIUM_REQUIRED' });
                    }
                    throw e;
                }
                let direct = data?.link || '';
                // Handle delayed links
                if (!direct && data?.delayed) {
                    const delayedId = data.delayed;
                    for (let i = 0; i < 15; i++) {
                        try {
                            const dd = await adFetch('/link/delayed', {
                                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: String(delayedId) })
                            });
                            if (dd?.status === 2 && dd?.link) { direct = dd.link; break; }
                            await new Promise(r => setTimeout(r, 1000));
                        } catch { await new Promise(r => setTimeout(r, 1000)); }
                    }
                }
                if (!direct) return res.status(502).json({ error: 'Failed to unlock link' });
                return res.json({ url: direct, raw: data });
            }
            if (provider === 'torbox') {
                // Expect a virtual torbox link: torbox://{torrentId}/{fileId}
                try {
                    const m = /^torbox:\/\/([^\/]+)\/(.+)$/i.exec(link || '');
                    if (!m) return res.status(400).json({ error: 'Invalid TorBox link' });
                    const torrentId = m[1];
                    const fileId = m[2];
                    // Preferred: use official stream creation to get a streamable URL
                    try {
                        const created = await tbCreateStream({ id: torrentId, file_id: fileId, type: 'torrent', chosen_subtitle_index: null, chosen_audio_index: 0 });
                        
                        // Check if createstream already provided the HLS URL (most common case)
                        const directUrl = created?.data?.hls_url || created?.hls_url;
                        if (directUrl && /^https?:\/\//i.test(directUrl)) {
                            console.log('[TB][stream] using direct HLS URL from createstream:', directUrl);
                            return res.json({ url: directUrl });
                        }
                        
                        // Fallback: try getstreamdata flow if no direct URL
                        let presigned = null;
                        let userToken = null;
                        
                        // Check common response structures for tokens
                        if (created?.success && created?.data) {
                            presigned = created.data.presigned_token || created.data.presignedToken;
                            userToken = created.data.token || created.data.user_token;
                        } else if (created?.presigned_token || created?.token) {
                            presigned = created.presigned_token || created.presignedToken;
                            userToken = created.token;
                        }
                        
                        // Fallback to deep search if not found
                        if (!presigned) presigned = extractNamedStringDeep(created, ['presigned_token','presignedToken']);
                        if (!userToken) userToken = extractNamedStringDeep(created, ['token', 'user_token']) || readSettings().tbApiKey;
                        
                        if (presigned && userToken) {
                            console.log('[TB][stream] trying getstreamdata fallback');
                            const sd = await tbGetStreamData({ presigned_token: presigned, token: userToken, chosen_subtitle_index: null, chosen_audio_index: 0 });
                            // Try all possible URL fields from TorBox response
                            const candidates = [
                                sd?.playlist_url, sd?.hls_url, sd?.m3u8_url, sd?.stream_url, sd?.url,
                                sd?.data?.playlist_url, sd?.data?.hls_url, sd?.data?.m3u8_url, sd?.data?.stream_url, sd?.data?.url,
                                ...extractHttpUrls(sd)
                            ].filter(u => u && /^https?:\/\//i.test(u));
                            if (candidates.length) {
                                console.log('[TB][stream] using URL from getstreamdata:', candidates[0]);
                                return res.json({ url: candidates[0] });
                            }
                        }
                        console.log('[TB][stream] no URL found in either response');
                    } catch (e) {
                        const msg = e?.message || '';
                        if (/auth|unauthorized|token/i.test(msg)) return res.status(401).json({ error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                        // Fall through to requestdl fallback
                    }
                    // Fallback: request a direct link if stream API path didn’t yield a URL
                    try {
                        const direct = await tbRequestDirectLink(torrentId, fileId);
                        if (direct) return res.json({ url: direct });
                    } catch {}
                    return res.status(502).json({ error: 'Failed to request TorBox link' });
                } catch (e) {
                    const msg = e?.message || '';
                    if (/authentication invalid/i.test(msg)) return res.status(401).json({ error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    return res.status(502).json({ error: 'TorBox link request failed' });
                }
            }
            if (provider === 'premiumize') {
                // For Premiumize, the links from file_list are already direct CDN URLs
                // They come as either 'link' or 'stream_link' from /transfer/directdl or /transfer/list
                console.log('[PM][link]', { link });
                
                // The link should already be a direct HTTPS URL ready for streaming
                if (/^https?:\/\//i.test(link)) {
                    console.log('[PM][link] using direct link:', link);
                    return res.json({ url: link });
                }
                
                // If not HTTP, something went wrong - Premiumize always returns HTTP URLs
                console.error('[PM][link] unexpected non-HTTP link:', link);
                return res.status(400).json({ error: 'Invalid Premiumize link format' });
            }
            return res.status(400).json({ error: 'Debrid provider not supported' });
        } catch (e) {
            console.error('[RD][unrestrict] error', e?.message);
            res.status(502).json({ error: e?.message || 'Debrid unrestrict failed' });
        }
    });

    // Delete a Debrid torrent by id (optional cleanup)
    app.delete('/api/debrid/torrent', async (req, res) => {
        try {
            const s = readSettings();
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            const id = (req.query?.id || req.body?.id || '').toString();
            if (!id) return res.status(400).json({ error: 'Missing id' });
            if (provider === 'realdebrid') {
                console.log('[RD][delete]', { id });
                await rdFetch(`/torrents/delete/${id}`, { method: 'DELETE' });
                return res.json({ success: true });
            }
            if (provider === 'alldebrid') {
                console.log('[AD][delete]', { id });
                try {
                    await adFetch('/magnet/delete', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id }) });
                } catch (e) {
                    const msg = e?.message || '';
                    if (e?.code === 'AD_AUTH_INVALID' || /AUTH_BAD_APIKEY|Not authenticated with AllDebrid/i.test(msg)) {
                        const cur = readSettings();
                        writeSettings({ ...cur, adApiKey: null });
                        return res.status(401).json({ success: false, error: 'AllDebrid authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    }
                    if (e?.code === 'AD_AUTH_BLOCKED' || /AUTH_BLOCKED/i.test(msg)) {
                        return res.status(403).json({ success: false, error: 'AllDebrid security check: verify the authorization email, then retry.', code: 'AD_AUTH_BLOCKED' });
                    }
                    throw e;
                }
                return res.json({ success: true });
            }
            if (provider === 'torbox') {
                console.log('[TB][delete]', { id });
                try {
                    await tbFetch('/api/torrents/controltorrent', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ torrent_id: String(id), operation: 'delete' })
                    });
                    return res.json({ success: true });
                } catch (e) {
                    const code = e?.code || '';
                    if (code === 'TB_AUTH_INVALID') return res.status(401).json({ success: false, error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    throw e;
                }
            }
            if (provider === 'premiumize') {
                console.log('[PM][delete]', { id });
                
                // Special case: directdl doesn't create a transfer, so nothing to delete
                if (id === 'directdl') {
                    return res.json({ success: true });
                }
                
                try {
                    await pmFetch('/transfer/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ id: String(id) })
                    });
                    return res.json({ success: true });
                } catch (e) {
                    const code = e?.code || '';
                    if (code === 'PM_AUTH_INVALID') return res.status(401).json({ success: false, error: 'Premiumize authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                    throw e;
                }
            }
            return res.status(400).json({ success: false, error: 'Debrid provider not supported' });
        } catch (e) {
            console.error('[RD][delete] error', e?.message);
            res.status(502).json({ success: false, error: e?.message || 'Failed to delete RD torrent' });
        }
    });

    // ===== TRAKT API ENDPOINTS =====

    // Trakt device authentication - step 1: get device code
    app.post('/api/trakt/device/code', async (req, res) => {
        try {
            const response = await traktFetch('/oauth/device/code', {
                method: 'POST',
                body: JSON.stringify({
                    client_id: TRAKT_CONFIG.CLIENT_ID
                })
            });

            // Store device code for verification
            saveTraktToken({ device_code: response.device_code });

            res.json({
                success: true,
                device_code: response.device_code,
                user_code: response.user_code,
                verification_url: response.verification_url,
                expires_in: response.expires_in,
                interval: response.interval
            });
        } catch (error) {
            console.error('[TRAKT] Device code error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Legacy endpoint for backwards compatibility
    app.get('/api/trakt/device-code', async (req, res) => {
        try {
            const response = await traktFetch('/oauth/device/code', {
                method: 'POST',
                body: JSON.stringify({
                    client_id: TRAKT_CONFIG.CLIENT_ID
                })
            });

            res.json({
                success: true,
                device_code: response.device_code,
                user_code: response.user_code,
                verification_url: response.verification_url,
                expires_in: response.expires_in,
                interval: response.interval
            });
        } catch (error) {
            console.error('[TRAKT] Device code error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Trakt device authentication - step 2: verify device code
    app.post('/api/trakt/device/verify', async (req, res) => {
        try {
            const traktToken = readTraktToken();
            if (!traktToken || !traktToken.device_code) {
                return res.json({ success: false, error: 'No device code found' });
            }

            const response = await traktFetch('/oauth/device/token', {
                method: 'POST',
                body: JSON.stringify({
                    code: traktToken.device_code,
                    client_id: TRAKT_CONFIG.CLIENT_ID,
                    client_secret: TRAKT_CONFIG.CLIENT_SECRET
                })
            });

            if (response.access_token) {
                saveTraktToken({
                    access_token: response.access_token,
                    refresh_token: response.refresh_token,
                    expires_in: response.expires_in,
                    created_at: response.created_at
                });
                res.json({ success: true });
            } else {
                res.json({ success: false, error: 'pending' });
            }
        } catch (error) {
            if (error.message.includes('pending')) {
                res.json({ success: false, error: 'pending' });
            } else {
                console.error('[TRAKT] Device verify error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        }
    });

    // Trakt device authentication - step 2: poll for token
    app.post('/api/trakt/device-token', async (req, res) => {
        try {
            const { device_code } = req.body;
            
            const response = await traktFetch('/oauth/device/token', {
                method: 'POST',
                body: JSON.stringify({
                    code: device_code,
                    client_id: TRAKT_CONFIG.CLIENT_ID,
                    client_secret: TRAKT_CONFIG.CLIENT_SECRET
                })
            });

            // Save the token
            if (saveTraktToken(response)) {
                res.json({ success: true, token: response });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save token' });
            }
        } catch (error) {
            console.error('[TRAKT] Token exchange error:', error);
            // Handle specific Trakt errors
            if (error.message.includes('400')) {
                res.status(400).json({ success: false, error: 'Pending - user hasn\'t authorized yet' });
            } else if (error.message.includes('404')) {
                res.status(404).json({ success: false, error: 'Not found - invalid device code' });
            } else if (error.message.includes('409')) {
                res.status(409).json({ success: false, error: 'Already used - device code already approved' });
            } else if (error.message.includes('410')) {
                res.status(410).json({ success: false, error: 'Expired - device code expired' });
            } else if (error.message.includes('418')) {
                res.status(418).json({ success: false, error: 'Denied - user denied authorization' });
            } else if (error.message.includes('429')) {
                res.status(429).json({ success: false, error: 'Slow down - polling too quickly' });
            } else {
                res.status(500).json({ success: false, error: error.message });
            }
        }
    });

    // Get Trakt authentication status
    app.get('/api/trakt/status', async (req, res) => {
        try {
            const token = readTraktToken();
            if (!token) {
                return res.json({ authenticated: false });
            }

            // Test the token by getting user info
            const userInfo = await traktFetch('/users/me');
            res.json({ 
                authenticated: true, 
                user: userInfo,
                token_expires: token.expires_at 
            });
        } catch (error) {
            console.error('[TRAKT] Status check error:', error);
            // Token might be invalid, delete it
            deleteTraktToken();
            res.json({ authenticated: false, error: error.message });
        }
    });

    // Logout from Trakt
    app.post('/api/trakt/logout', (req, res) => {
        try {
            deleteTraktToken();
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Refresh Trakt token
    app.post('/api/trakt/refresh', async (req, res) => {
        try {
            const currentToken = readTraktToken();
            if (!currentToken || !currentToken.refresh_token) {
                return res.status(400).json({ success: false, error: 'No refresh token available' });
            }

            const response = await traktFetch('/oauth/token', {
                method: 'POST',
                body: JSON.stringify({
                    refresh_token: currentToken.refresh_token,
                    client_id: TRAKT_CONFIG.CLIENT_ID,
                    client_secret: TRAKT_CONFIG.CLIENT_SECRET,
                    redirect_uri: TRAKT_CONFIG.REDIRECT_URI,
                    grant_type: 'refresh_token'
                })
            });

            if (saveTraktToken(response)) {
                res.json({ success: true, token: response });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save refreshed token' });
            }
        } catch (error) {
            console.error('[TRAKT] Token refresh error:', error);
            deleteTraktToken(); // Delete invalid token
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Scrobble start watching
    app.post('/api/trakt/scrobble/start', async (req, res) => {
        try {
            const { title, type, year, season, episode, progress = 0 } = req.body;
            
            let scrobbleData = {
                progress: Math.min(Math.max(progress, 0), 100)
            };

            if (type === 'movie') {
                scrobbleData.movie = {
                    title: title,
                    year: year
                };
            } else if (type === 'show') {
                scrobbleData.show = {
                    title: title,
                    year: year
                };
                scrobbleData.episode = {
                    season: season,
                    number: episode
                };
            }

            const response = await traktFetch('/scrobble/start', {
                method: 'POST',
                body: JSON.stringify(scrobbleData)
            });

            res.json({ success: true, data: response });
        } catch (error) {
            console.error('[TRAKT] Scrobble start error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Scrobble pause
    app.post('/api/trakt/scrobble/pause', async (req, res) => {
        try {
            const { title, type, year, season, episode, progress } = req.body;
            
            let scrobbleData = {
                progress: Math.min(Math.max(progress, 0), 100)
            };

            if (type === 'movie') {
                scrobbleData.movie = {
                    title: title,
                    year: year
                };
            } else if (type === 'show') {
                scrobbleData.show = {
                    title: title,
                    year: year
                };
                scrobbleData.episode = {
                    season: season,
                    number: episode
                };
            }

            const response = await traktFetch('/scrobble/pause', {
                method: 'POST',
                body: JSON.stringify(scrobbleData)
            });

            res.json({ success: true, data: response });
        } catch (error) {
            console.error('[TRAKT] Scrobble pause error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Scrobble stop/finish watching
    app.post('/api/trakt/scrobble/stop', async (req, res) => {
        try {
            const { title, type, year, season, episode, progress } = req.body;
            
            let scrobbleData = {
                progress: Math.min(Math.max(progress, 0), 100)
            };

            if (type === 'movie') {
                scrobbleData.movie = {
                    title: title,
                    year: year
                };
            } else if (type === 'show') {
                scrobbleData.show = {
                    title: title,
                    year: year
                };
                scrobbleData.episode = {
                    season: season,
                    number: episode
                };
            }

            const response = await traktFetch('/scrobble/stop', {
                method: 'POST',
                body: JSON.stringify(scrobbleData)
            });

            res.json({ success: true, data: response });
        } catch (error) {
            console.error('[TRAKT] Scrobble stop error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get user's watchlist
    app.get('/api/trakt/watchlist', async (req, res) => {
        try {
            const type = req.query.type || 'mixed'; // movies, shows, mixed
            const response = await traktFetch(`/users/me/watchlist/${type}`);
            res.json({ success: true, watchlist: response });
        } catch (error) {
            console.error('[TRAKT] Watchlist error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Add to watchlist
    app.post('/api/trakt/watchlist/add', async (req, res) => {
        try {
            const { title, type, year, season } = req.body;
            
            let requestData = {};
            if (type === 'movie') {
                requestData.movies = [{
                    title: title,
                    year: year
                }];
            } else if (type === 'show') {
                requestData.shows = [{
                    title: title,
                    year: year
                }];
            }

            const response = await traktFetch('/sync/watchlist', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            res.json({ success: true, data: response });
        } catch (error) {
            console.error('[TRAKT] Add to watchlist error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Remove from watchlist
    app.post('/api/trakt/watchlist/remove', async (req, res) => {
        try {
            const { title, type, year } = req.body;
            
            let requestData = {};
            if (type === 'movie') {
                requestData.movies = [{
                    title: title,
                    year: year
                }];
            } else if (type === 'show') {
                requestData.shows = [{
                    title: title,
                    year: year
                }];
            }

            const response = await traktFetch('/sync/watchlist/remove', {
                method: 'POST',
                body: JSON.stringify(requestData)
            });

            res.json({ success: true, data: response });
        } catch (error) {
            console.error('[TRAKT] Remove from watchlist error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get viewing history
    app.get('/api/trakt/history', async (req, res) => {
        try {
            const type = req.query.type || 'mixed'; // movies, shows, mixed
            const page = req.query.page || 1;
            const limit = req.query.limit || 10;
            
            const response = await traktFetch(`/users/me/history/${type}?page=${page}&limit=${limit}`);
            res.json({ success: true, history: response });
        } catch (error) {
            console.error('[TRAKT] History error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get user stats
    app.get('/api/trakt/stats', async (req, res) => {
        try {
            const response = await traktFetch('/users/me/stats');
            res.json({ success: true, stats: response });
        } catch (error) {
            console.error('[TRAKT] Stats error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Search for content on Trakt
    app.get('/api/trakt/search', async (req, res) => {
        try {
            const { query, type = 'movie,show' } = req.query;
            if (!query) {
                return res.status(400).json({ success: false, error: 'Query parameter required' });
            }

            const response = await traktFetch(`/search/${type}?query=${encodeURIComponent(query)}`);
            res.json({ success: true, results: response });
        } catch (error) {
            console.error('[TRAKT] Search error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get comprehensive user stats including watchlist, collection, etc.
    app.get('/api/trakt/user/stats', async (req, res) => {
        try {
            const [stats, watchlist, collection, ratings] = await Promise.all([
                traktFetch('/users/me/stats'),
                traktFetch('/users/me/watchlist').catch(() => []),
                traktFetch('/users/me/collection/movies').catch(() => []),
                traktFetch('/users/me/ratings').catch(() => [])
            ]);

            res.json({
                success: true,
                stats: {
                    movies: stats.movies || { watched: 0, collected: 0, ratings: 0 },
                    shows: stats.shows || { watched: 0, collected: 0, ratings: 0 },
                    episodes: stats.episodes || { watched: 0, collected: 0, ratings: 0 },
                    network: stats.network || { friends: 0, followers: 0, following: 0 },
                    watchlist: Array.isArray(watchlist) ? watchlist : [],
                    collection: Array.isArray(collection) ? collection : [],
                    ratings: Array.isArray(ratings) ? ratings : []
                }
            });
        } catch (error) {
            console.error('[TRAKT] Comprehensive stats error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get user profile info
    app.get('/api/trakt/user/profile', async (req, res) => {
        try {
            const profile = await traktFetch('/users/me');
            res.json({ success: true, profile });
        } catch (error) {
            console.error('[TRAKT] Profile error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get user collection
    app.get('/api/trakt/collection', async (req, res) => {
        try {
            const [movies, shows] = await Promise.all([
                traktFetch('/users/me/collection/movies').catch(() => []),
                traktFetch('/users/me/collection/shows').catch(() => [])
            ]);
            res.json({ 
                success: true, 
                collection: { 
                    movies: Array.isArray(movies) ? movies : [],
                    shows: Array.isArray(shows) ? shows : []
                }
            });
        } catch (error) {
            console.error('[TRAKT] Collection error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get user ratings
    app.get('/api/trakt/ratings', async (req, res) => {
        try {
            const ratings = await traktFetch('/users/me/ratings');
            res.json({ success: true, ratings: Array.isArray(ratings) ? ratings : [] });
        } catch (error) {
            console.error('[TRAKT] Ratings error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Rate content
    app.post('/api/trakt/rate', async (req, res) => {
        try {
            const { title, type, year, rating } = req.body;
            if (!title || !type || !rating) {
                return res.status(400).json({ success: false, error: 'Missing required parameters' });
            }

            const items = [{
                [type]: {
                    title,
                    year: parseInt(year)
                },
                rating: parseInt(rating)
            }];

            const response = await traktFetch('/sync/ratings', {
                method: 'POST',
                body: JSON.stringify({ [type + 's']: items })
            });

            res.json({ success: true, response });
        } catch (error) {
            console.error('[TRAKT] Rate error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Add to collection
    app.post('/api/trakt/collection/add', async (req, res) => {
        try {
            const { title, type, year } = req.body;
            if (!title || !type) {
                return res.status(400).json({ success: false, error: 'Missing required parameters' });
            }

            const items = [{
                [type]: {
                    title,
                    year: parseInt(year)
                }
            }];

            const response = await traktFetch('/sync/collection', {
                method: 'POST',
                body: JSON.stringify({ [type + 's']: items })
            });

            res.json({ success: true, response });
        } catch (error) {
            console.error('[TRAKT] Add to collection error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Remove from collection
    app.post('/api/trakt/collection/remove', async (req, res) => {
        try {
            const { title, type, year } = req.body;
            if (!title || !type) {
                return res.status(400).json({ success: false, error: 'Missing required parameters' });
            }

            const items = [{
                [type]: {
                    title,
                    year: parseInt(year)
                }
            }];

            const response = await traktFetch('/sync/collection/remove', {
                method: 'POST',
                body: JSON.stringify({ [type + 's']: items })
            });

            res.json({ success: true, response });
        } catch (error) {
            console.error('[TRAKT] Remove from collection error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get trending content
    app.get('/api/trakt/trending', async (req, res) => {
        try {
            const { type = 'movies' } = req.query;
            const response = await traktFetch(`/${type}/trending?limit=20`);
            res.json({ success: true, trending: Array.isArray(response) ? response : [] });
        } catch (error) {
            console.error('[TRAKT] Trending error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get popular content
    app.get('/api/trakt/popular', async (req, res) => {
        try {
            const { type = 'movies' } = req.query;
            const response = await traktFetch(`/${type}/popular?limit=20`);
            res.json({ success: true, popular: Array.isArray(response) ? response : [] });
        } catch (error) {
            console.error('[TRAKT] Popular error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get recommendations
    app.get('/api/trakt/recommendations', async (req, res) => {
        try {
            const { type = 'movies' } = req.query;
            const response = await traktFetch(`/recommendations/${type}?limit=20`);
            res.json({ success: true, recommendations: Array.isArray(response) ? response : [] });
        } catch (error) {
            console.error('[TRAKT] Recommendations error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== END TRAKT API ENDPOINTS =====

    // Range-capable proxy for debrid direct URLs with HLS support
    app.get('/stream/debrid', async (req, res) => {
        try {
            const directUrl = (req.query?.url || '').toString();
            if (!directUrl.startsWith('http')) return res.status(400).end('Bad URL');
            
            // Check if this is an HLS playlist
            const isHLS = directUrl.includes('.m3u8');
            
            let range = req.headers.range;
            const startSec = Number(req.query?.start || 0);
            let headers = {};
            if (range && !isHLS) headers.Range = range;
            else if (!isNaN(startSec) && startSec > 0 && !isHLS) {
                headers = {};
            }
            
            // Add proper headers for AllDebrid links
            if (directUrl.includes('alldebrid.com')) {
                headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
                headers['Referer'] = 'https://alldebrid.com/';
                headers['Accept'] = '*/*';
                headers['Accept-Encoding'] = 'identity';
                headers['Connection'] = 'keep-alive';
            }
            
            console.log('[STREAM] requesting:', directUrl, 'headers:', headers);
            const upstream = await fetch(directUrl, { headers });
            const status = upstream.status;
            console.log('[STREAM] response status:', status);
            console.log('[STREAM] response headers:', Object.fromEntries([...upstream.headers.entries()]));
            
            if (!upstream.ok) {
                console.error('[STREAM] upstream error:', status, await upstream.text());
                return res.status(status).end('upstream error');
            }
            
            res.status(status);
            
            if (isHLS) {
                // For HLS streams, set proper content type and handle as text
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache');
                const body = await upstream.text();
                
                // Rewrite relative URLs in the playlist to go through our proxy
                const baseUrl = directUrl.substring(0, directUrl.lastIndexOf('/') + 1);
                const rewrittenBody = body.replace(/^([^#\n\r]+\.ts)/gm, (match, segment) => {
                    const segmentUrl = segment.startsWith('http') ? segment : baseUrl + segment;
                    return `${req.protocol}://${req.get('host')}/stream/debrid?url=${encodeURIComponent(segmentUrl)}`;
                });
                
                res.send(rewrittenBody);
            } else {
                // Regular file streaming with range support
                const passthrough = ['content-length','content-range','accept-ranges','content-type'];
                passthrough.forEach((h) => {
                    const v = upstream.headers.get(h);
                    if (v) res.setHeader(h, v);
                });
                
                // Fallback content-type by extension
                if (!res.getHeader('content-type')) {
                    try {
                        const u = new URL(directUrl);
                        const ct = mime.lookup(u.pathname) || 'application/octet-stream';
                        res.setHeader('Content-Type', ct);
                    } catch {}
                }
                
                const body = upstream.body;
                body.on('error', () => { try { res.end(); } catch {} });
                req.on('close', () => { try { body.destroy(); } catch {} });
                body.pipe(res);
            }
        } catch (e) {
            console.error('[STREAM] proxy error:', e.message);
            res.status(502).end('debrid proxy error');
        }
    });

    // Alias with /api prefix for clients that use API_BASE_URL for streaming
    app.get('/api/stream/debrid', async (req, res) => {
        try {
            const directUrl = (req.query?.url || '').toString();
            if (!directUrl.startsWith('http')) return res.status(400).end('Bad URL');
            
            // Check if this is an HLS playlist
            const isHLS = directUrl.includes('.m3u8');
            
            const range = req.headers.range;
            let headers = {};
            if (range && !isHLS) headers.Range = range;
            
            // Add proper headers for AllDebrid links
            if (directUrl.includes('alldebrid.com')) {
                headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
                headers['Referer'] = 'https://alldebrid.com/';
                headers['Accept'] = '*/*';
                headers['Accept-Encoding'] = 'identity';
                headers['Connection'] = 'keep-alive';
            }
            
            console.log('[STREAM] API requesting:', directUrl, 'headers:', headers);
            const upstream = await fetch(directUrl, { headers });
            const status = upstream.status;
            console.log('[STREAM] API response status:', status);
            console.log('[STREAM] API response headers:', Object.fromEntries([...upstream.headers.entries()]));
            
            if (!upstream.ok) {
                console.error('[STREAM] API upstream error:', status, await upstream.text());
                return res.status(status).end('upstream error');
            }
            
            res.status(status);
            
            if (isHLS) {
                // For HLS streams, set proper content type and handle as text
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'no-cache');
                const body = await upstream.text();
                
                // Rewrite relative URLs in the playlist to go through our proxy
                const baseUrl = directUrl.substring(0, directUrl.lastIndexOf('/') + 1);
                const rewrittenBody = body.replace(/^([^#\n\r]+\.ts)/gm, (match, segment) => {
                    const segmentUrl = segment.startsWith('http') ? segment : baseUrl + segment;
                    return `${req.protocol}://${req.get('host')}/api/stream/debrid?url=${encodeURIComponent(segmentUrl)}`;
                });
                
                res.send(rewrittenBody);
            } else {
                // Regular file streaming
                const passthrough = ['content-length','content-range','accept-ranges','content-type'];
                passthrough.forEach((h) => {
                    const v = upstream.headers.get(h);
                    if (v) res.setHeader(h, v);
                });
                
                if (!res.getHeader('content-type')) {
                    try {
                        const u = new URL(directUrl);
                        const ct = mime.lookup(u.pathname) || 'application/octet-stream';
                        res.setHeader('Content-Type', ct);
                    } catch {}
                }
                
                const body = upstream.body;
                body.on('error', () => { try { res.end(); } catch {} });
                req.on('close', () => { try { body.destroy(); } catch {} });
                body.pipe(res);
            }
        } catch (e) {
            console.error('[STREAM] proxy error:', e.message);
            res.status(502).end('debrid proxy error');
        }
    });

    // Note: SUB_TMP_DIR, ensureSubsDir, and /subtitles middleware are initialized after settings are loaded (see below)
    
    // ----------------------
    // Configuration and API Key Management
    // ----------------------

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

    // Configuration defaults
    let JACKETT_URL = 'http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab';
    let CACHE_LOCATION = os.tmpdir(); // Default to system temp

    // Load user settings for Jackett URL and cache location
    function loadUserSettings() {
        const settingsPath = path.join(userDataPath, 'user_settings.json');
        try {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.jackettUrl) {
                    JACKETT_URL = settings.jackettUrl;
                    console.log(`Loaded custom Jackett URL: ${JACKETT_URL}`);
                }
                if (settings.cacheLocation) {
                    CACHE_LOCATION = settings.cacheLocation;
                    console.log(`Loaded custom cache location: ${CACHE_LOCATION}`);
                }
                return settings;
            }
        } catch (error) {
            console.error('Error loading user settings:', error);
        }
        return { jackettUrl: JACKETT_URL, cacheLocation: CACHE_LOCATION };
    }

    function saveUserSettings(settings) {
        const settingsPath = path.join(userDataPath, 'user_settings.json');
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
            console.log('User settings saved:', settings);
            return true;
        } catch (error) {
            console.error('Error saving user settings:', error);
            return false;
        }
    }

    // Load settings on startup
    loadUserSettings();

    // Temporary subtitles storage (must be after loadUserSettings)
    const SUB_TMP_DIR = path.join(CACHE_LOCATION, 'playtorrio_subs');
    const ensureSubsDir = () => { try { fs.mkdirSync(SUB_TMP_DIR, { recursive: true }); } catch {} };
    ensureSubsDir();

    // Register subtitle middleware now that SUB_TMP_DIR is defined
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

    const client = new WebTorrent({
        maxConns: 100,        // Increase max connections for faster downloads
        dht: true,            // Enable DHT for more peers
        tracker: true,        // Enable trackers
        webSeeds: true,       // Enable web seeds if available
        uploadLimit: -1,      // No upload limit
        downloadLimit: -1     // No download limit
    });
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
    // Helper: Convert basic ASS/SSA into WebVTT (best-effort)
    // Parses the [Events] section using its Format line to extract Start, End, Text.
    // Strips styling tags and converts \N to line breaks. Timing is converted from h:mm:ss.cs to hh:mm:ss.mmm
    const assToVtt = (assText) => {
        try {
            const text = String(assText || '');
            const lines = text.replace(/\r+/g, '').split(/\n/);
            let inEvents = false;
            let format = [];
            const cues = [];
            const cleanAssText = (t) => {
                let s = String(t || '');
                // Remove styling override blocks {\...}
                s = s.replace(/\{[^}]*\}/g, '');
                // Replace \N with newlines and \h with space
                s = s.replace(/\\N/g, '\n').replace(/\\h/g, ' ');
                // Collapse multiple spaces
                s = s.replace(/\s{2,}/g, ' ').trim();
                return s;
            };
            const toVttTime = (assTime) => {
                // ASS: H:MM:SS.CS (centiseconds)
                const m = String(assTime || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{2})$/);
                if (!m) return null;
                const h = String(m[1]).padStart(2, '0');
                const mm = m[2];
                const ss = m[3];
                const cs = m[4];
                const ms = String(parseInt(cs, 10) * 10).padStart(3, '0');
                return `${h}:${mm}:${ss}.${ms}`;
            };
            for (let raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                if (/^\[events\]/i.test(line)) { inEvents = true; continue; }
                if (/^\[.*\]/.test(line)) { inEvents = false; continue; }
                if (!inEvents) {
                    if (/^format\s*:/i.test(line)) {
                        // Build field order
                        const parts = line.split(':')[1] || '';
                        format = parts.split(',').map(s => s.trim().toLowerCase());
                    }
                    continue;
                }
                if (!/^dialogue\s*:/i.test(line)) continue;
                // Parse Dialogue using the known number of fields from Format
                const after = line.replace(/^dialogue\s*:\s*/i, '');
                const fieldsCount = format.length || 10; // common default is 10
                const parts = [];
                let remaining = after;
                for (let i = 0; i < Math.max(1, fieldsCount - 1); i++) {
                    const idx = remaining.indexOf(',');
                    if (idx === -1) { parts.push(remaining); remaining = ''; break; }
                    parts.push(remaining.slice(0, idx));
                    remaining = remaining.slice(idx + 1);
                }
                parts.push(remaining);
                // Map to a record
                const rec = {};
                for (let i = 0; i < format.length && i < parts.length; i++) {
                    rec[format[i]] = parts[i];
                }
                const start = toVttTime(rec.start);
                const end = toVttTime(rec.end);
                let body = rec.text || parts[parts.length - 1] || '';
                body = cleanAssText(body);
                if (start && end && body) {
                    cues.push(`${start} --> ${end}\n${body}`);
                }
            }
            return `WEBVTT\n\n${cues.join('\n\n')}\n`;
        } catch {
            // Fallback: wrap raw text into VTT
            return `WEBVTT\n\n${String(assText || '')}`;
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

        const torrentDownloadPath = path.join(CACHE_LOCATION, 'webtorrent', infoHash);
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
            // Build list preserving original torrent.files index
            const all = t.files.map((file, idx) => ({ index: idx, name: file.name, size: file.length }));
            const filtered = all.filter(f => /\.(mp4|mkv|avi|mov|srt|vtt|ass)$/i.test(f.name));
            res.json({
                infoHash,
                name: t.name,
                videoFiles: filtered.filter(f => f.name.match(/\.(mp4|mkv|avi|mov)$/i)).sort((a, b) => b.size - a.size),
                subtitleFiles: filtered.filter(f => f.name.match(/\.(srt|vtt|ass)$/i)),
            });
            
            // NOW deselect everything after sending the response - prevent downloading until user selects
            setTimeout(() => {
                try { 
                    t.files.forEach(f => f.deselect()); 
                    console.log(`[Protection] Deselected all files for ${infoHash} after sending file list`);
                } catch {}
                try { t.deselect(0, Math.max(0, t.pieces.length - 1), false); } catch {}
            }, 100);
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
                
                // OPTIMIZATION: Prioritize first pieces for faster playback start
                const pieceLength = torrent.pieceLength;
                const fileStart = Math.max(0, Math.floor(file.offset / pieceLength));
                const fileEnd = Math.max(fileStart, Math.floor((file.offset + file.length - 1) / pieceLength));
                
                // Select the entire file range
                try {
                    torrent.select(fileStart, fileEnd, 1);
                } catch {}
                
                // CRITICAL: Prioritize first 5MB for immediate playback
                const priorityBytes = 5 * 1024 * 1024; // 5MB
                const priorityPieces = Math.ceil(priorityBytes / pieceLength);
                const priorityEnd = Math.min(fileStart + priorityPieces, fileEnd);
                
                // Download first pieces with highest priority
                for (let i = fileStart; i <= priorityEnd; i++) {
                    try {
                        torrent.critical(i, i);
                    } catch {}
                }
                
                console.log(`[Streaming] Prioritizing pieces ${fileStart}-${priorityEnd} of ${fileStart}-${fileEnd} for ${file.name}`);
                
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
                
                // OPTIMIZATION: Prioritize first pieces for faster playback start
                const pieceLength = torrent.pieceLength;
                const fileStart = Math.max(0, Math.floor(file.offset / pieceLength));
                const fileEnd = Math.max(fileStart, Math.floor((file.offset + file.length - 1) / pieceLength));
                
                // Select the entire file range
                try {
                    torrent.select(fileStart, fileEnd, 1);
                } catch {}
                
                // CRITICAL: Prioritize first 10MB for pre-buffering
                const priorityBytes = 10 * 1024 * 1024; // 10MB for prepare (more buffer than stream)
                const priorityPieces = Math.ceil(priorityBytes / pieceLength);
                const priorityEnd = Math.min(fileStart + priorityPieces, fileEnd);
                
                // Download first pieces with highest priority
                for (let i = fileStart; i <= priorityEnd; i++) {
                    try {
                        torrent.critical(i, i);
                    } catch {}
                }
                
                console.log(`[Prepare] Pre-buffering pieces ${fileStart}-${priorityEnd} of ${fileStart}-${fileEnd} for ${file.name}`);
                
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
            const torrentDownloadPath = path.join(CACHE_LOCATION, 'webtorrent', hash);
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
            // Exclude adult/XXX categories (category IDs: 6000-6999 are adult categories in Jackett/Newznab)
            // Also exclude specific category codes: XXX (6000), Other XXX (6010-6090)
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
                    
                    // Check for adult categories
                    const attrs = Array.isArray(item['torznab:attr']) ? item['torznab:attr'] : [item['torznab:attr']];
                    const categoryAttr = attrs.find(attr => attr?.name === 'category');
                    if (categoryAttr) {
                        const catValue = String(categoryAttr.value || '');
                        // Exclude adult categories (6000-6999) and check title for adult keywords
                        if (catValue.startsWith('6') && parseInt(catValue) >= 6000 && parseInt(catValue) < 7000) {
                            return null; // Skip adult content
                        }
                    }
                    
                    // Additional title-based filtering for common adult keywords
                    const title = String(item.title || '').toLowerCase();
                    const adultKeywords = ['xxx', 'porn', 'adult', '18+', 'hentai', 'erotic', 'nsfw'];
                    if (adultKeywords.some(kw => title.includes(kw))) {
                        return null; // Skip if title contains adult keywords
                    }
                    
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
            const looksLikeAss = /\[Script Info\]/i.test(text);

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
            } else if (looksLikeAss || /\.(ass|ssa)$/i.test(ext)) {
                const vtt = assToVtt(text);
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
            const looksLikeAss = /\[Script Info\]/i.test(text) || /\.(ass|ssa)$/i.test(original);
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
            } else if (looksLikeAss) {
                const vtt = assToVtt(text);
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
        console.log(`\n${'='.repeat(70)}`);
        console.log(`🚀 UNIFIED SERVER RUNNING ON http://localhost:${PORT}`);
        console.log(`${'='.repeat(70)}`);
        console.log(`\n📚 Available API Services:\n`);
        console.log(`  🎬 ANIME        → http://localhost:${PORT}/anime/api/{query}`);
        console.log(`  🎥 TORRENTIO    → http://localhost:${PORT}/torrentio/api/{imdbid}`);
        console.log(`  🔍 TORRENTLESS  → http://localhost:${PORT}/torrentless/api/search?q={query}`);
        console.log(`  📖 ZLIB         → http://localhost:${PORT}/zlib/search/{query}`);
        console.log(`  📚 OTHERBOOK    → http://localhost:${PORT}/otherbook/api/search/{query}`);
        console.log(`  🎞️  111477       → http://localhost:${PORT}/111477/api/tmdb/movie/{tmdbId}`);
        console.log(`\n🎯 Main Services:\n`);
        console.log(`  🔧 Settings     → http://localhost:${PORT}/api/settings`);
        console.log(`  🎬 Trakt        → http://localhost:${PORT}/api/trakt/*`);
        console.log(`  📺 Torrents     → http://localhost:${PORT}/api/torrents`);
        console.log(`  🎮 WebTorrent   → http://localhost:${PORT}/api/webtorrent/*`);
        if (!hasAPIKey) console.log('\n⚠️  Jackett API key not configured.');
        console.log(`\n${'='.repeat(70)}\n`);
    });

    return { server, client };
}
