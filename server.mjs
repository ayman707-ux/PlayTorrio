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
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

// Import the CommonJS api.cjs module
const require = createRequire(import.meta.url);
const { registerApiRoutes } = require('./api.cjs');

// This function will be imported and called by main.js
export function startServer(userDataPath) {
    // Ensure userDataPath directory exists with proper permissions
    try {
        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true, mode: 0o755 });
            console.log(`✅ Created userDataPath directory: ${userDataPath}`);
        }
        // Verify directory is writable
        fs.accessSync(userDataPath, fs.constants.W_OK);
        console.log(`✅ userDataPath is writable: ${userDataPath}`);
    } catch (err) {
        console.error(`❌ CRITICAL: userDataPath not writable: ${userDataPath}`, err?.message);
        console.error('❌ Application may not be able to save settings or API keys!');
    }
    
    // ============================================================================
    // API CACHE MANAGER - 1 hour cache for all API requests
    // ============================================================================
    const apiCache = new Map();
    const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

    // Cache helper functions
    function getCacheKey(url, params = {}) {
        const sortedParams = JSON.stringify(params, Object.keys(params).sort());
        return `${url}::${sortedParams}`;
    }

    function getFromCache(key) {
        const cached = apiCache.get(key);
        if (!cached) return null;
        
        const now = Date.now();
        if (now - cached.timestamp > CACHE_DURATION) {
            apiCache.delete(key);
            return null;
        }
        
        console.log(`[Cache HIT] ${key.substring(0, 80)}...`);
        return cached.data;
    }

    function setToCache(key, data) {
        apiCache.set(key, {
            data: data,
            timestamp: Date.now()
        });
        console.log(`[Cache SET] ${key.substring(0, 80)}... (Total cached: ${apiCache.size})`);
    }

    function clearCache() {
        const size = apiCache.size;
        apiCache.clear();
        console.log(`[Cache CLEARED] Removed ${size} cached entries`);
    }

    // Periodic cache cleanup (remove expired entries every 15 minutes)
    setInterval(() => {
        const now = Date.now();
        let removed = 0;
        for (const [key, value] of apiCache.entries()) {
            if (now - value.timestamp > CACHE_DURATION) {
                apiCache.delete(key);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[Cache Cleanup] Removed ${removed} expired entries`);
        }
    }, 15 * 60 * 1000);

    // Middleware to cache GET requests automatically
    function cacheMiddleware(req, res, next) {
        if (req.method !== 'GET') return next();
        
        const cacheKey = getCacheKey(req.originalUrl || req.url, req.query);
        const cached = getFromCache(cacheKey);
        
        if (cached) {
            return res.json(cached);
        }
        
        // Override res.json to cache the response
        const originalJson = res.json.bind(res);
        res.json = function(data) {
            if (res.statusCode === 200 && data) {
                setToCache(cacheKey, data);
            }
            return originalJson(data);
        };
        
        next();
    }

    // ============================================================================
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
    
    // Apply cache middleware to all API routes
    app.use('/anime/api', cacheMiddleware);
    app.use('/torrentio/api', cacheMiddleware);
    app.use('/torrentless/api', cacheMiddleware);
    app.use('/zlib', cacheMiddleware);
    app.use('/otherbook/api', cacheMiddleware);
    app.use('/111477/api', cacheMiddleware);
    app.use('/moviebox', cacheMiddleware);
    app.use('/api/torrents', cacheMiddleware);
    app.use('/api/trakt', cacheMiddleware);
    
    // Health check endpoint
    app.get('/', (req, res) => {
        res.json({ 
            status: 'running', 
            message: 'PlayTorrio Server is running',
            version: '1.3.9',
            cacheSize: apiCache.size,
            endpoints: {
                anime: '/anime/api/*',
                torrentio: '/torrentio/api/*',
                torrentless: '/torrentless/api/*',
                webtorrent: '/api/webtorrent/*',
                trakt: '/api/trakt/*'
            }
        });
    });
    
    // Cache management endpoint
    app.post('/api/clear-cache', (req, res) => {
        clearCache();
        res.json({ success: true, message: 'Cache cleared successfully' });
    });

    app.get('/api/cache-stats', (req, res) => {
        res.json({ 
            size: apiCache.size,
            duration: CACHE_DURATION / 1000 / 60 + ' minutes'
        });
    });

    // ============================================================================
    // NUVIO PROXY - Cache Nuvio streaming API requests
    // ============================================================================
    app.get('/api/nuvio/stream/:type/:id', cacheMiddleware, async (req, res) => {
        try {
            const { type, id } = req.params;
            const { cookie, region = 'US' } = req.query;

            if (!['movie', 'series'].includes(type)) {
                return res.status(400).json({ error: 'Invalid type. Must be movie or series.' });
            }

            const providers = 'showbox,vidzee,vidsrc,vixsrc,mp4hydra,uhdmovies,moviesmod,4khdhub,topmovies';
            const nuvioUrl = `https://nuviostreams.hayd.uk/providers=${providers}/stream/${type}/${id}.json?cookie=${cookie || ''}&region=${region}`;

            console.log('[Nuvio Proxy] Fetching:', nuvioUrl);

            const response = await fetch(nuvioUrl);
            if (!response.ok) {
                throw new Error(`Nuvio API error: ${response.statusText}`);
            }

            const data = await response.json();
            res.json(data);
        } catch (error) {
            console.error('[Nuvio Proxy Error]:', error);
            res.status(500).json({ error: error.message || 'Failed to fetch Nuvio streams' });
        }
    });

    // ============================================================================
    // COMET PROXY - Cache Comet debrid API requests
    // ============================================================================
    app.get('/api/comet/stream/:type/:id', cacheMiddleware, async (req, res) => {
        try {
            const { type, id } = req.params;
            const { config } = req.query;

            if (!['movie', 'series'].includes(type)) {
                return res.status(400).json({ error: 'Invalid type. Must be movie or series.' });
            }

            // Default Comet config if none provided
            const cometConfig = config || 'eyJtYXhSZXN1bHRzUGVyUmVzb2x1dGlvbiI6MCwibWF4U2l6ZSI6MCwiY2FjaGVkT25seSI6dHJ1ZSwicmVtb3ZlVHJhc2giOnRydWUsInJlc3VsdEZvcm1hdCI6WyJhbGwiXSwiZGVicmlkU2VydmljZSI6InRvcnJlbnQiLCJkZWJyaWRBcGlLZXkiOiIiLCJkZWJyaWRTdHJlYW1Qcm94eVBhc3N3b3JkIjoiIiwibGFuZ3VhZ2VzIjp7ImV4Y2x1ZGUiOltdLCJwcmVmZXJyZWQiOlsiZW4iXX0sInJlc29sdXRpb25zIjp7fSwib3B0aW9ucyI6eyJyZW1vdmVfcmFua3NfdW5kZXIiOi0xMDAwMDAwMDAwMCwiYWxsb3dfZW5nbGlzaF9pbl9sYW5ndWFnZXMiOmZhbHNlLCJyZW1vdmVfdW5rbm93bl9sYW5ndWFnZXMiOmZhbHNlfX0=';
            
            const cometUrl = `https://comet.elfhosted.com/${cometConfig}/stream/${type}/${id}.json`;

            console.log('[Comet Proxy] Fetching:', cometUrl);

            const response = await fetch(cometUrl);
            if (!response.ok) {
                throw new Error(`Comet API error: ${response.statusText}`);
            }

            const data = await response.json();
            res.json(data);
        } catch (error) {
            console.error('[Comet Proxy Error]:', error);
            res.status(500).json({ error: error.message || 'Failed to fetch Comet streams' });
        }
    });
    
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
                autoUpdate: true,
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
            return { autoUpdate: true, useTorrentless: false, torrentSource: 'torrentio', useDebrid: false, debridProvider: 'realdebrid', rdToken: null, rdRefresh: null, rdClientId: null, rdCredId: null, rdCredSecret: null, adApiKey: null, tbApiKey: null, pmApiKey: null };
        }
    }
    function writeSettings(obj) {
        try { fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
    }

    // ===== IPTV settings endpoints =====
    function defaultIptvSettings() {
        return {
            lastMode: 'iframe', // 'iframe' | 'xtream' | 'm3u' | 'direct' | 'none'
            rememberCreds: false,
            xtream: { base: '', username: '', password: '' },
            m3u: { url: '' }
        };
    }

    app.get('/api/iptv/settings', (req, res) => {
        try {
            const s = readSettings();
            const iptv = { ...defaultIptvSettings(), ...(s.iptv || {}) };
            res.json({ success: true, iptv });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'failed to load settings' });
        }
    });

    app.post('/api/iptv/settings', (req, res) => {
        try {
            const patch = req.body || {};
            const s = readSettings();
            const current = { ...defaultIptvSettings(), ...(s.iptv || {}) };
            const nextIptv = {
                ...current,
                ...patch,
                xtream: { ...(current.xtream || {}), ...(patch.xtream || {}) },
                m3u: { ...(current.m3u || {}), ...(patch.m3u || {}) }
            };
            const nextAll = { ...s, iptv: nextIptv };
            const ok = writeSettings(nextAll);
            if (!ok) return res.status(500).json({ success: false, error: 'failed to save settings' });
            res.json({ success: true, iptv: nextIptv });
        } catch (e) {
            res.status(500).json({ success: false, error: e?.message || 'failed to save settings' });
        }
    });

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
            autoUpdate: s.autoUpdate !== false,
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
            autoUpdate: req.body.autoUpdate !== undefined ? !!req.body.autoUpdate : (s.autoUpdate !== false),
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
    app.post('/api/debrid/token', async (req, res) => {
        const { token } = req.body || {};
        const s = readSettings();
        
        // Validate token if provided
        if (token && typeof token === 'string' && token.trim()) {
            const tokenToTest = token.trim();
            try {
                // Test the token by making a simple API call
                console.log('[RD][token] Testing API token validity...');
                const testUrl = 'https://api.real-debrid.com/rest/1.0/user';
                const testResp = await safeFetch(testUrl, {
                    headers: { Authorization: `Bearer ${tokenToTest}` }
                });
                
                if (!testResp.ok) {
                    const errorText = await testResp.text();
                    console.error('[RD][token] Invalid token:', errorText);
                    return res.status(401).json({ 
                        success: false, 
                        error: 'Invalid Real-Debrid API token. Please check your token and try again.',
                        code: 'INVALID_TOKEN'
                    });
                }
                
                const userData = await testResp.json();
                console.log('[RD][token] Valid API token for user:', userData?.username || 'unknown');
                
                // Save token (clear OAuth credentials since this is direct API token)
                const next = { 
                    ...s, 
                    rdToken: tokenToTest,
                    rdRefresh: null,  // API tokens don't have refresh tokens
                    rdCredId: null,   // Clear OAuth credentials
                    rdCredSecret: null
                };
                const ok = writeSettings(next);
                if (ok) return res.json({ success: true, username: userData?.username });
                return res.status(500).json({ success: false, error: 'Failed to save token' });
            } catch (e) {
                console.error('[RD][token] Error testing token:', e?.message);
                return res.status(502).json({ 
                    success: false, 
                    error: 'Failed to validate token with Real-Debrid',
                    code: 'VALIDATION_FAILED'
                });
            }
        } else {
            // Clear token
            const next = { ...s, rdToken: null, rdRefresh: null, rdCredId: null, rdCredSecret: null };
            const ok = writeSettings(next);
            if (ok) return res.json({ success: true });
            return res.status(500).json({ success: false, error: 'Failed to clear token' });
        }
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
            const { key, position, duration, title, poster_path, tmdb_id, media_type, season, episode } = req.body || {};
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
            if (poster_path) rec.poster_path = String(poster_path);
            if (tmdb_id) rec.tmdb_id = tmdb_id;
            if (media_type) rec.media_type = String(media_type);
            if (season !== undefined && season !== null) rec.season = Number(season);
            if (episode !== undefined && episode !== null) rec.episode = Number(episode);
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
    
    // Get all resume records (for Continue Watching section)
    app.get('/api/resume/all', (req, res) => {
        try {
            const map = readResumeMap();
            // Convert to array and sort by most recent
            const items = Object.entries(map)
                .map(([key, data]) => ({
                    key,
                    title: data.title || 'Unknown',
                    position: data.position || 0,
                    duration: data.duration || 0,
                    poster_path: data.poster_path || null,
                    tmdb_id: data.tmdb_id || null,
                    media_type: data.media_type || null,
                    season: data.season || null,
                    episode: data.episode || null,
                    updatedAt: data.updatedAt || new Date().toISOString()
                }))
                .filter(item => item.duration > 0 && item.position > 0 && item.position / item.duration < 0.95) // Only show items not fully watched
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
                .slice(0, 20); // Return max 20 items
            
            return res.json(items);
        } catch (e) {
            return res.status(500).json({ error: e?.message || 'Failed to read resume data' });
        }
    });

    // --- AllDebrid minimal adapter & auth (PIN flow) ---
    const AD_BASE = 'https://api.alldebrid.com/v4';
    function isNetworkError(e) {
        const msg = (e?.message || '').toLowerCase();
        return (
            /econnrefused|enotfound|eai_again|network|fetch failed|timeout|timed out|socket hang up/.test(msg)
        );
    }
    function withTimeout(fetchPromise, ms = 8000) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), ms);
        return fetchPromise(ac.signal).finally(() => clearTimeout(t));
    }
    async function safeFetch(url, options = {}, timeoutMs = 8000) {
        try {
            const run = (signal) => fetch(url, { ...options, signal });
            const resp = await withTimeout(run, timeoutMs);
            return resp;
        } catch (e) {
            if (isNetworkError(e)) {
                const err = new Error('Network unreachable');
                err.code = 'NETWORK_UNREACHABLE';
                throw err;
            }
            throw e;
        }
    }
    async function adFetch(endpoint, opts = {}) {
        const s = readSettings();
        if (!s.adApiKey) throw new Error('Not authenticated with AllDebrid');
        const url = `${AD_BASE}${endpoint}`;
        console.log('[AD][call]', { endpoint, method: (opts.method || 'GET').toUpperCase() });
        let resp;
        try {
            resp = await safeFetch(url, { ...opts, headers: { Authorization: `Bearer ${s.adApiKey}`, ...(opts.headers || {}) } });
        } catch (e) {
            if (e?.code === 'NETWORK_UNREACHABLE') {
                const err = new Error('AllDebrid is unreachable right now.');
                err.code = 'AD_NETWORK';
                throw err;
            }
            throw e;
        }
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
        let resp;
        try {
            resp = await safeFetch(url, { ...opts, headers: { Authorization: `Bearer ${s.tbApiKey}`, Accept: 'application/json', ...(opts.headers || {}) } });
        } catch (e) {
            if (e?.code === 'NETWORK_UNREACHABLE') {
                const err = new Error('TorBox is unreachable right now.');
                err.code = 'TB_NETWORK';
                throw err;
            }
            throw e;
        }
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

    // Get a TorBox direct link for streaming using official API
    // Per official docs: GET /torrents/requestdl?token=KEY&torrent_id=ID&file_id=FILE&redirect=true
    // This returns a permanent streaming URL that works directly in video players
    async function tbRequestDirectLink(torrentId, fileId) {
        const s = readSettings();
        if (!s.tbApiKey) throw new Error('Not authenticated with TorBox');
        
        // Official API endpoint: /api/torrents/requestdl with query params
        // redirect=true returns a permanent CDN URL for streaming
        const qs = new URLSearchParams({
            token: s.tbApiKey,
            torrent_id: String(torrentId),
            file_id: String(fileId),
            redirect: 'true'  // Returns permanent URL instead of temporary link
        });
        
        const url = `${TB_BASE}/api/torrents/requestdl?${qs.toString()}`;
        console.log('[TB][requestdl] calling:', url.replace(s.tbApiKey, 'API_KEY'));
        
        try {
            // With redirect=true, API returns the direct CDN URL
            // Can be used as permanent streaming link
            const resp = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${s.tbApiKey}`,
                    'Accept': '*/*'
                },
                redirect: 'follow'  // Follow redirects to get final URL
            });
            
            if (!resp.ok) {
                const text = await resp.text();
                console.error('[TB][requestdl] HTTP error:', resp.status, text);
                
                // Handle specific error cases
                if (resp.status === 401) {
                    throw new Error('TorBox authentication invalid');
                }
                if (resp.status === 404) {
                    throw new Error('TorBox torrent or file not found');
                }
                if (resp.status === 429) {
                    throw new Error('TorBox rate limited');
                }
                
                throw new Error(`TorBox requestdl failed: ${resp.status} ${text}`);
            }
            
            // The response should be the direct CDN URL as plain text or redirect
            const directUrl = resp.url; // Final URL after redirects
            
            if (directUrl && /^https?:\/\//i.test(directUrl)) {
                console.log('[TB][requestdl] success, CDN URL obtained');
                return directUrl;
            }
            
            // Fallback: try reading response body
            const text = await resp.text();
            if (text && /^https?:\/\//i.test(text.trim())) {
                console.log('[TB][requestdl] success from response body');
                return text.trim();
            }
            
            throw new Error('TorBox requestdl returned no valid URL');
        } catch (e) {
            console.error('[TB][requestdl] error:', e.message);
            throw e;
        }
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
        
        let resp;
        try {
            resp = await safeFetch(url.toString(), {
                ...opts,
                headers: {
                    'Accept': 'application/json',
                    ...(opts.headers || {})
                }
            });
        } catch (e) {
            if (e?.code === 'NETWORK_UNREACHABLE') {
                const err = new Error('Premiumize is unreachable right now.');
                err.code = 'PM_NETWORK';
                throw err;
            }
            throw e;
        }
        
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
            // Use official Real-Debrid public client ID if none provided
            const DEFAULT_RD_CLIENT_ID = 'X245A4XAIBGVM';
            const clientId = (req.query.client_id || s.rdClientId || DEFAULT_RD_CLIENT_ID).toString().trim();
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
            const DEFAULT_RD_CLIENT_ID = 'X245A4XAIBGVM';
            const clientId = (req.body?.client_id || s.rdClientId || DEFAULT_RD_CLIENT_ID).toString().trim();
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
    // RD rate limiter: simple token bucket with 250 req/min limit
    const rdRateLimiter = {
        tokens: 250,
        maxTokens: 250,
        refillRate: 250 / 60, // 250 per minute = ~4.17 per second
        lastRefill: Date.now(),
        
        async acquire() {
            const now = Date.now();
            const elapsed = (now - this.lastRefill) / 1000; // seconds
            this.tokens = Math.min(this.maxTokens, this.tokens + (elapsed * this.refillRate));
            this.lastRefill = now;
            
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            
            // Wait until we have a token
            const waitTime = ((1 - this.tokens) / this.refillRate) * 1000;
            console.log(`[RD][rate-limit] Waiting ${Math.ceil(waitTime)}ms for token...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.tokens = 0; // consumed the token we waited for
        }
    };

    // Instant availability is intentionally disabled in this app flow
    let rdInstantAvailabilityDisabled = true;

    async function rdFetch(endpoint, opts = {}) {
        const started = Date.now();
        
        // Rate limiting: acquire token before making request
        await rdRateLimiter.acquire();
        
        const attempt = async (token, retryCount = 0) => {
            const url = `${RD_BASE}${endpoint}`;
            console.log('[RD][call]', { endpoint, method: (opts.method || 'GET').toUpperCase(), retry: retryCount });
            
            const headers = {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'User-Agent': 'Playtorrio/1.0',
                ...(opts.headers || {})
            };
            
            let response;
            try {
                response = await safeFetch(url, { ...opts, headers });
            } catch (e) {
                if (e?.code === 'NETWORK_UNREACHABLE') {
                    const err = new Error('Real‑Debrid is unreachable right now.');
                    err.code = 'RD_NETWORK';
                    throw err;
                }
                throw e;
            }
            
            // Handle 429 rate limit with exponential backoff
            if (response.status === 429) {
                if (retryCount < 3) {
                    const backoffMs = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                    console.warn(`[RD][429] Rate limited, backing off ${backoffMs}ms (attempt ${retryCount + 1}/3)`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    // Reset rate limiter tokens to prevent cascading issues
                    rdRateLimiter.tokens = Math.max(0, rdRateLimiter.tokens - 10);
                    return attempt(token, retryCount + 1);
                }
                console.error('[RD][429] Rate limit exceeded after 3 retries');
                const err = new Error('Real-Debrid rate limit exceeded. Please wait a moment.');
                err.code = 'RD_RATE_LIMIT';
                err.status = 429;
                throw err;
            }
            
            return response;
        };
        
        let s = readSettings();
        if (!s.rdToken) throw new Error('Not authenticated with Real-Debrid');
        let resp = await attempt(s.rdToken);
        
        if (resp.status === 401 || resp.status === 403) {
            // Try token refresh if possible (only for OAuth tokens with refresh capability)
            if (!rdRefreshing && s.rdRefresh && s.rdCredId && s.rdCredSecret) {
                try {
                    rdRefreshing = true;
                    console.warn('[RD][refresh] attempting refresh_token flow');
                    // Per RD docs, refresh is performed using device grant with code = refresh_token
                    const tb = new URLSearchParams({
                        client_id: s.rdCredId,
                        client_secret: s.rdCredSecret,
                        code: s.rdRefresh,
                        grant_type: 'http://oauth.net/grant_type/device/1.0'
                    });
                    const tr = await fetch('https://api.real-debrid.com/oauth/v2/token', {
                        method: 'POST', 
                        headers: { 
                            'Accept': 'application/json', 
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': 'Playtorrio/1.0'
                        }, 
                        body: tb
                    });
                    if (tr.ok) {
                        const tj = await tr.json();
                        const next = { ...s, rdToken: tj.access_token || s.rdToken, rdRefresh: tj.refresh_token || s.rdRefresh };
                        writeSettings(next);
                        s = next;
                        console.log('[RD][refresh] success, token rotated');
                        // Retry once with new token
                        resp = await attempt(s.rdToken);
                    } else {
                        const errorText = await tr.text();
                        console.warn('[RD][refresh] failed:', errorText);
                        // Refresh failed, clear OAuth tokens
                        const cleared = { ...s, rdToken: null, rdRefresh: null, rdCredId: null, rdCredSecret: null };
                        writeSettings(cleared);
                    }
                } catch (e) {
                    console.error('[RD][refresh] exception:', e?.message);
                }
                finally { rdRefreshing = false; }
            } else if (!s.rdRefresh && !s.rdCredId && !s.rdCredSecret) {
                // This is a direct API token (no OAuth credentials)
                // Don't auto-clear API tokens - they're permanent unless manually revoked
                console.warn('[RD] Direct API token got 401/403 - may be invalid, expired, or IP-blocked');
                console.warn('[RD] Please generate a new API token from Real-Debrid website');
                // Still throw the error so user gets notified, but don't auto-clear
            } else {
                // OAuth token but no refresh capability (shouldn't happen normally)
                console.warn('[RD] OAuth token without refresh capability, clearing');
                const cleared = { ...s, rdToken: null, rdRefresh: null };
                writeSettings(cleared);
            }
        }
        
        if (!resp.ok) {
            let msg = resp.statusText;
            let rawBody = '';
            try { 
                rawBody = await resp.text();
                msg = rawBody;
            } catch {}
            
            // Log detailed error info
            console.error('[RD][call] error', { 
                endpoint, 
                status: resp.status, 
                statusText: resp.statusText,
                body: truncate(msg, 500) 
            });
            
            // Provide specific error messages for common status codes
            if (resp.status === 403) {
                if (/permission_denied|account_locked|not_premium/i.test(msg)) {
                    const err = new Error('Real-Debrid premium account is required for this feature.');
                    err.code = 'RD_PREMIUM_REQUIRED';
                    err.status = 403;
                    throw err;
                } else if (/disabled_endpoint/i.test(msg)) {
                    const err = new Error('This Real-Debrid feature is disabled for your account.');
                    err.code = 'RD_FEATURE_UNAVAILABLE';
                    err.status = 403;
                    throw err;
                } else {
                    const err = new Error('Real-Debrid access denied. Check your account status and IP restrictions.');
                    err.code = 'RD_FORBIDDEN';
                    err.status = 403;
                    throw err;
                }
            }
            
            if (resp.status === 429) {
                const err = new Error('Real-Debrid rate limit exceeded. Please wait before retrying.');
                err.code = 'RD_RATE_LIMIT';
                err.status = 429;
                throw err;
            }
            
            if (resp.status === 502 || resp.status === 503) {
                const err = new Error('Real-Debrid service is temporarily unavailable.');
                err.code = 'RD_UNAVAILABLE';
                err.status = resp.status;
                throw err;
            }
            
            // For OAuth tokens that failed refresh, we already cleared them above
            // For API tokens, we keep them and just report the error
            const err = new Error(`RD ${endpoint} failed: ${resp.status} ${msg}`);
            err.status = resp.status;
            throw err;
        }
        
        const ct = resp.headers.get('content-type') || '';
        const elapsed = Date.now() - started;
        console.log('[RD][call] ok', { endpoint, status: resp.status, ms: elapsed });
        
        // Handle JSON parsing with error handling
        if (/json/i.test(ct)) {
            try {
                const text = await resp.text();
                if (!text || text.trim() === '') {
                    console.warn('[RD][call] Empty JSON response for', endpoint);
                    return {};
                }
                return JSON.parse(text);
            } catch (e) {
                console.error('[RD][call] JSON parse error for', endpoint, ':', e?.message);
                console.error('[RD][call] Response text:', text?.substring(0, 200));
                const err = new Error(`RD ${endpoint} returned invalid JSON: ${e?.message}`);
                err.code = 'RD_PARSE_ERROR';
                err.status = 502;
                throw err;
            }
        }
        
        return resp.text();
    }

    // Helper: extract info hash from magnet link
    function extractInfoHash(magnet) {
        const match = magnet.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
        if (!match) return null;
        let hash = match[1];
        // Convert base32 to hex if needed (32 chars = base32, 40 chars = hex)
        if (hash.length === 32) {
            // For simplicity, RD API accepts both formats, so just return uppercase
            return hash.toUpperCase();
        }
        return hash.toUpperCase();
    }

    // Helper: no-op; we no longer call RD instantAvailability
    async function rdMarkCachedFiles(info) { return info; }

    // Debrid availability endpoint is disabled for RD to avoid extra API calls
    app.get('/api/debrid/availability', async (req, res) => {
        try {
            const s = readSettings();
            if (!s.useDebrid) return res.status(400).json({ error: 'Debrid disabled' });
            const btih = String(req.query.btih || '').trim().toUpperCase();
            if (!btih || btih.length < 32) return res.status(400).json({ error: 'Invalid btih' });
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            if (provider === 'realdebrid') {
                return res.json({ provider: 'realdebrid', available: false, disabled: true, message: 'Instant availability is disabled in this app' });
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
                    if (e?.code === 'TB_NETWORK') return res.status(503).json({ error: 'TorBox is unreachable right now. Please try again later.', code: 'TB_UNAVAILABLE' });
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
                    if (e?.code === 'PM_NETWORK') return res.status(503).json({ error: 'Premiumize is unreachable right now. Please try again later.', code: 'PM_UNAVAILABLE' });
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
            if (e?.code === 'RD_NETWORK' || /econnrefused|enotfound|network|timeout/i.test(msg)) {
                return res.status(503).json({ error: 'Real‑Debrid is unreachable right now. Please try again later.', code: 'RD_UNAVAILABLE' });
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
                // Extract info hash from magnet
                const btih = extractInfoHash(magnet);
                
                // Step 2: Check existing torrents to avoid duplicates
                if (btih) {
                    try {
                        const existing = await rdFetch('/torrents');
                        if (Array.isArray(existing)) {
                            const match = existing.find(t => (t?.hash || '').toLowerCase() === btih.toLowerCase());
                            if (match && match.id) {
                                console.log('[RD][prepare] Reusing existing torrent', { id: match.id, status: match.status });
                                let info = await rdFetch(`/torrents/info/${match.id}`);
                                
                                // If torrent is already downloaded and has NO selected files, auto-select ALL files
                                // This ensures links are available immediately for downloaded torrents
                                if (info.status === 'downloaded' && Array.isArray(info.files)) {
                                    const hasSelected = info.files.some(f => f.selected === 1);
                                    if (!hasSelected) {
                                        console.log('[RD][prepare] Auto-selecting all files for downloaded torrent');
                                        const allFileIds = info.files.map(f => f.id).join(',');
                                        try {
                                            await rdFetch(`/torrents/selectFiles/${match.id}`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                                body: new URLSearchParams({ files: allFileIds })
                                            });
                                            // Refetch info to get updated links
                                            info = await rdFetch(`/torrents/info/${match.id}`);
                                        } catch (e) {
                                            console.warn('[RD][prepare] Auto-select failed:', e?.message);
                                        }
                                    }
                                }
                                
                                return res.json({ id: match.id, info, reused: true });
                            }
                        }
                    } catch (e) {
                        console.warn('[RD][prepare] Could not check existing torrents:', e?.message);
                    }
                }
                
                // Step 3: If not cached and not exists, add new magnet
                console.log('[RD][prepare] Adding magnet to Real-Debrid');
                const addRes = await rdFetch('/torrents/addMagnet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ magnet })
                });
                const id = addRes?.id;
                if (!id) return res.status(500).json({ error: 'Failed to add magnet' });
                console.log('[RD][prepare] added', { id });
                
                // DO NOT auto-select files here - wait for user to choose specific file
                // This prevents RD from downloading all files in multi-file torrents
                // File selection happens later via /api/debrid/select-files when user clicks
                console.log('[RD][prepare] Skipping auto-select to prevent bulk download');
                
                // Fetch latest info (may already contain links for cached items)
                let info = await rdFetch(`/torrents/info/${id}`);
                
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
                    if (e?.code === 'AD_NETWORK') {
                        return res.status(503).json({ error: 'AllDebrid is unreachable right now. Please try again later.', code: 'AD_UNAVAILABLE' });
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
                    if (code === 'TB_NETWORK') return res.status(503).json({ error: 'TorBox is unreachable right now. Please try again later.', code: 'TB_UNAVAILABLE' });
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
                    if (e?.code === 'PM_NETWORK') {
                        return res.status(503).json({ error: 'Premiumize is unreachable right now. Please try again later.', code: 'PM_UNAVAILABLE' });
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
            
            // Handle authentication errors
            if (/401|bad_token|invalid_token/i.test(msg)) {
                return res.status(401).json({ error: 'Real-Debrid authentication expired. Please login again.', code: 'DEBRID_UNAUTH' });
            }
            
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
            
            // Handle rate limiting
            if (/429|too_many_requests/i.test(msg)) {
                return res.status(429).json({ error: 'Real-Debrid rate limit. Please wait a moment.', code: 'RD_RATE_LIMIT' });
            }
            
            // Handle network errors
            if (e?.code === 'RD_NETWORK' || /econnrefused|enotfound|network|timeout/i.test(msg)) {
                return res.status(503).json({ error: 'Real‑Debrid is unreachable right now. Please try again later.', code: 'RD_UNAVAILABLE' });
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
            
            try {
                // For season packs with single file selection: RD doesn't allow changing selected files
                // Solution: Delete old torrent and re-add with new file selection
                const fileIds = files.split(',').filter(f => f && f !== 'all');
                const isSingleFileSelection = fileIds.length === 1;
                
                if (isSingleFileSelection) {
                    // Get current torrent info
                    const currentInfo = await rdFetch(`/torrents/info/${id}`);
                    const currentlySelected = currentInfo?.files?.filter(f => f.selected === 1).map(f => f.id) || [];
                    const requestedFileId = parseInt(fileIds[0]);
                    
                    // If a different file is currently selected, delete and re-add torrent
                    if (currentlySelected.length > 0 && !currentlySelected.includes(requestedFileId)) {
                        console.log('[RD][select-files] Different file requested. Deleting torrent', id, 'and re-adding with file', requestedFileId);
                        
                        // Get magnet link from torrent info to re-add it
                        const magnetHash = currentInfo?.hash;
                        if (!magnetHash) {
                            console.error('[RD][select-files] Cannot re-add torrent: no hash found');
                            return res.status(500).json({ error: 'Cannot switch files: torrent hash not found' });
                        }
                        
                        // Delete the old torrent
                        try {
                            await rdFetch(`/torrents/delete/${id}`, { method: 'DELETE' });
                            console.log('[RD][select-files] Deleted old torrent:', id);
                        } catch (e) {
                            console.warn('[RD][select-files] Failed to delete torrent:', e?.message);
                        }
                        
                        // Re-add the torrent with magnet
                        const magnet = `magnet:?xt=urn:btih:${magnetHash}`;
                        console.log('[RD][select-files] Re-adding torrent with magnet:', magnet.substring(0, 50) + '...');
                        
                        const addRes = await rdFetch('/torrents/addMagnet', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({ magnet })
                        });
                        
                        const newId = addRes?.id;
                        if (!newId) {
                            console.error('[RD][select-files] Failed to re-add torrent');
                            return res.status(500).json({ error: 'Failed to re-add torrent' });
                        }
                        
                        console.log('[RD][select-files] Re-added torrent with new ID:', newId);
                        
                        // Now select the requested file on the NEW torrent
                        const selectRes = await rdFetch(`/torrents/selectFiles/${newId}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({ files: requestedFileId.toString() })
                        });
                        
                        console.log('[RD][select-files] File selection response:', selectRes);
                        
                        // Get updated info with new links
                        const newInfo = await rdFetch(`/torrents/info/${newId}`);
                        console.log('[RD][select-files] New torrent info:', {
                            id: newInfo?.id,
                            status: newInfo?.status,
                            torrentLinks: newInfo?.links,
                            selectedFiles: newInfo?.files?.filter(f => f.selected === 1).map(f => ({ 
                                id: f.id, 
                                path: f.path 
                            }))
                        });
                        
                        return res.json({ 
                            id: newId, 
                            info: newInfo, 
                            reAddedForFileSwitch: true,
                            oldId: id
                        });
                    }
                }
                
                // Normal file selection (first time or same file)
                const out = await rdFetch(`/torrents/selectFiles/${id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ files })
                });
                
                console.log('[RD][select-files] Response:', out);
                
                // After selecting, immediately fetch torrent info to see if links are populated
                const info = await rdFetch(`/torrents/info/${id}`);
                console.log('[RD][select-files] Updated torrent info:', {
                    id: info?.id,
                    status: info?.status,
                    torrentLinks: info?.links,
                    selectedFiles: info?.files?.filter(f => f.selected === 1).map(f => ({ 
                        id: f.id, 
                        path: f.path, 
                        hasLinks: !!f.links,
                        links: f.links 
                    }))
                });
                
                res.json({ success: true, out, info });
            } catch (e) {
                // Handle specific RD errors
                if (e?.status === 429 || e?.code === 'RD_RATE_LIMIT') {
                    return res.status(429).json({ success: false, error: 'Real-Debrid rate limit. Please wait before retrying.', code: 'RD_RATE_LIMIT' });
                }
                if (e?.status === 403 || e?.code === 'RD_PREMIUM_REQUIRED' || e?.code === 'RD_FORBIDDEN') {
                    return res.status(403).json({ success: false, error: e?.message || 'Real-Debrid premium is required.', code: e?.code || 'RD_FORBIDDEN' });
                }
                if (e?.status === 502 || e?.code === 'RD_PARSE_ERROR') {
                    console.error('[RD][select-files] JSON parse error - response may be malformed');
                    return res.status(502).json({ success: false, error: 'Real-Debrid returned invalid response. Try again.', code: 'RD_PARSE_ERROR' });
                }
                if (e?.code === 'RD_NETWORK' || e?.code === 'RD_UNAVAILABLE') {
                    return res.status(503).json({ success: false, error: 'Real-Debrid is unreachable. Please try again later.', code: 'RD_UNAVAILABLE' });
                }
                
                // Generic error fallback
                throw e;
            }
        } catch (e) {
            const msg = e?.message || '';
            console.error('[RD][select-files] error', msg);
            
            // Handle authentication errors
            if (/401|bad_token|invalid_token/i.test(msg)) {
                return res.status(401).json({ success: false, error: 'Real-Debrid authentication expired. Please login again.', code: 'DEBRID_UNAUTH' });
            }
            
            // Handle permission errors
            if (/403\s+\{[^}]*permission_denied/i.test(msg)) {
                return res.status(403).json({ success: false, error: 'Real-Debrid premium is required to select files.', code: 'RD_PREMIUM_REQUIRED' });
            }
            
            // Handle rate limiting
            if (/429|too_many_requests/i.test(msg)) {
                return res.status(429).json({ success: false, error: 'Real-Debrid rate limit. Please wait a moment.', code: 'RD_RATE_LIMIT' });
            }
            
            // Handle network errors
            if (e?.code === 'RD_NETWORK' || /econnrefused|enotfound|network|timeout/i.test(msg)) {
                return res.status(503).json({ success: false, error: 'Real-Debrid is unreachable. Please try again later.', code: 'RD_UNAVAILABLE' });
            }
            
            res.status(502).json({ success: false, error: msg || 'Debrid select files failed' });
        }
    });

    // Cleanup/delete debrid torrent (for when user closes file selector or switches files)
    app.post('/api/debrid/cleanup', async (req, res) => {
        try {
            const s = readSettings();
            const provider = (s.debridProvider || 'realdebrid').toLowerCase();
            const id = (req.body?.id || '').toString();
            
            if (!id) return res.json({ success: true, message: 'No ID provided, nothing to cleanup' });
            
            if (provider === 'realdebrid') {
                console.log('[RD][cleanup] Deleting torrent:', id);
                try {
                    await rdFetch(`/torrents/delete/${id}`, { method: 'DELETE' });
                    console.log('[RD][cleanup] Successfully deleted torrent:', id);
                    return res.json({ success: true, deleted: true, id });
                } catch (e) {
                    // Torrent might already be deleted, that's okay
                    console.warn('[RD][cleanup] Failed to delete torrent (might already be deleted):', e?.message);
                    return res.json({ success: true, deleted: false, message: 'Torrent already deleted or not found' });
                }
            } else if (provider === 'alldebrid') {
                console.log('[AD][cleanup] Deleting magnet:', id);
                try {
                    await adFetch(`/magnet/delete?id=${id}`, { method: 'GET' });
                    console.log('[AD][cleanup] Successfully deleted magnet:', id);
                    return res.json({ success: true, deleted: true, id });
                } catch (e) {
                    console.warn('[AD][cleanup] Failed to delete magnet:', e?.message);
                    return res.json({ success: true, deleted: false, message: 'Magnet already deleted or not found' });
                }
            } else {
                // Other providers - no-op
                return res.json({ success: true, message: 'Cleanup not needed for ' + provider });
            }
        } catch (e) {
            console.error('[Debrid][cleanup] error', e?.message);
            res.status(500).json({ success: false, error: e?.message || 'Cleanup failed' });
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
                let info = await rdFetch(`/torrents/info/${id}`);
                
                // DEBUG: Log the raw response structure
                console.log('[RD][files] Raw response structure:', {
                    id: info?.id,
                    status: info?.status,
                    filesCount: info?.files?.length,
                    hasTorrentLevelLinks: !!info?.links,
                    torrentLinksCount: Array.isArray(info?.links) ? info.links.length : 0,
                    firstFile: info?.files?.[0] ? {
                        id: info.files[0].id,
                        selected: info.files[0].selected,
                        hasLinks: !!info.files[0].links,
                        linksType: typeof info.files[0].links,
                        linksLength: Array.isArray(info.files[0].links) ? info.files[0].links.length : 0
                    } : null
                });
                
                // No instant availability augmentation
                
                // CRITICAL: RD API doesn't always populate 'links' in /torrents/info response
                // For downloaded torrents with selected files, we need to construct the download link manually
                // Format: https://real-debrid.com/d/[download_id] (needs unrestricting)
                if (info && Array.isArray(info.files)) {
                    // For multi-file torrents (season packs): RD populates info.links with download links
                    // but ONLY for currently selected files, and the array indexing doesn't match file IDs
                    // We need to distribute available links to selected files
                    const selectedFiles = info.files.filter(f => f.selected === 1);
                    const availableLinks = Array.isArray(info.links) ? info.links.filter(l => l) : [];
                    
                    for (const f of info.files) {
                        // Normalize links to array format first
                        if (typeof f.links === 'string') {
                            f.links = [f.links];
                        } else if (!f.links) {
                            f.links = [];
                        }
                        
                        // If file is selected but has no links, try to get from torrent-level links array
                        if (f.selected === 1 && f.links.length === 0) {
                            // Try direct indexing first (works for single-file torrents)
                            if (availableLinks[f.id - 1]) {
                                f.links = [availableLinks[f.id - 1]];
                            }
                            // For season packs: if only 1 link available and 1 file selected, use it
                            else if (selectedFiles.length === 1 && availableLinks.length === 1) {
                                f.links = [availableLinks[0]];
                            }
                            // For season packs with multiple selected files: match by position
                            else if (selectedFiles.length > 0 && availableLinks.length > 0) {
                                const selectedIndex = selectedFiles.indexOf(f);
                                if (selectedIndex >= 0 && availableLinks[selectedIndex]) {
                                    f.links = [availableLinks[selectedIndex]];
                                }
                            }
                        }
                    }
                }
                
                console.log('[RD][files] Response:', { 
                    id, 
                    status: info?.status, 
                    filesCount: info?.files?.length,
                    selectedFiles: info?.files?.filter(f => f.selected === 1).length,
                    filesWithLinks: info?.files?.filter(f => Array.isArray(f.links) && f.links.length > 0).length,
                    torrentLevelLinks: Array.isArray(info?.links) ? info.links.length : 0,
                    sampleFiles: info?.files?.slice(0, 3).map(f => ({
                        id: f.id,
                        selected: f.selected,
                        path: f.path?.split('/').pop(),
                        links: f.links
                    }))
                });
                
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
                    if (e?.code === 'AD_NETWORK') {
                        return res.status(503).json({ error: 'AllDebrid is unreachable right now. Please try again later.', code: 'AD_UNAVAILABLE' });
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
                    if (code === 'TB_NETWORK') return res.status(503).json({ error: 'TorBox is unreachable right now. Please try again later.', code: 'TB_UNAVAILABLE' });
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
                    if (code === 'PM_NETWORK') return res.status(503).json({ error: 'Premiumize is unreachable right now. Please try again later.', code: 'PM_UNAVAILABLE' });
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
            if (e?.code === 'RD_NETWORK' || /econnrefused|enotfound|network|timeout/i.test(msg)) {
                return res.status(503).json({ error: 'Real‑Debrid is unreachable right now. Please try again later.', code: 'RD_UNAVAILABLE' });
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
                // ALWAYS unrestrict RD links to get the actual direct download URL
                // Links from /torrents/info are download page URLs (e.g., /d/...), not direct CDN links
                console.log('[RD][unrestrict] link:', link);
                
                try {
                    const out = await rdFetch('/unrestrict/link', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ link })
                    });
                    
                    if (!out?.download) {
                        console.error('[RD][unrestrict] No download URL in response:', out);
                        return res.status(502).json({ error: 'RD unrestrict returned no download URL' });
                    }
                    
                    console.log('[RD][unrestrict] success, CDN URL:', out.download);
                    return res.json({ url: out.download, raw: out });
                } catch (e) {
                    console.error('[RD][unrestrict] failed:', e?.message);
                    return res.status(502).json({ error: 'Failed to unrestrict RD link: ' + (e?.message || 'unknown error') });
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
                    if (e?.code === 'AD_NETWORK') {
                        return res.status(503).json({ error: 'AllDebrid is unreachable right now. Please try again later.', code: 'AD_UNAVAILABLE' });
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
                    
                    // Use official TorBox API: GET /torrents/requestdl with redirect=true
                    // This returns a permanent streaming URL per official documentation
                    console.log('[TB][link] requesting stream link for torrent:', torrentId, 'file:', fileId);
                    
                    try {
                        const direct = await tbRequestDirectLink(torrentId, fileId);
                        if (direct && /^https?:\/\//i.test(direct)) {
                            console.log('[TB][link] success, returning CDN URL');
                            return res.json({ url: direct });
                        }
                        
                        console.error('[TB][link] no valid URL returned');
                        return res.status(502).json({ error: 'TorBox returned no valid stream URL' });
                    } catch (e) {
                        const msg = e?.message || '';
                        console.error('[TB][link] error:', msg);
                        
                        if (/authentication invalid|401/i.test(msg)) {
                            return res.status(401).json({ error: 'TorBox authentication invalid. Please login again.', code: 'DEBRID_UNAUTH' });
                        }
                        if (/not found|404/i.test(msg)) {
                            return res.status(404).json({ error: 'TorBox torrent or file not found. The file may have been removed.', code: 'TB_NOT_FOUND' });
                        }
                        if (/rate limit|429/i.test(msg)) {
                            return res.status(429).json({ error: 'TorBox rate limit exceeded. Please wait and try again.', code: 'TB_RATE_LIMIT' });
                        }
                        if (e?.code === 'TB_NETWORK' || /network|unreachable|econnrefused/i.test(msg)) {
                            return res.status(503).json({ error: 'TorBox is unreachable right now. Please try again later.', code: 'TB_UNAVAILABLE' });
                        }
                        
                        return res.status(502).json({ error: 'Failed to get TorBox stream link: ' + msg });
                    }
                } catch (e) {
                    const msg = e?.message || '';
                    console.error('[TB][link] outer error:', msg);
                    return res.status(502).json({ error: 'TorBox link request failed: ' + msg });
                }
            }
            if (provider === 'premiumize') {
                
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
            if (e?.code === 'RD_NETWORK' || /econnrefused|enotfound|network|timeout/i.test(e?.message || '')) {
                return res.status(503).json({ error: 'Real‑Debrid is unreachable right now. Please try again later.', code: 'RD_UNAVAILABLE' });
            }
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
                    if (e?.code === 'AD_NETWORK') {
                        return res.status(503).json({ success: false, error: 'AllDebrid is unreachable right now. Please try again later.', code: 'AD_UNAVAILABLE' });
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
                    if (code === 'TB_NETWORK') return res.status(503).json({ success: false, error: 'TorBox is unreachable right now. Please try again later.', code: 'TB_UNAVAILABLE' });
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
                    if (code === 'PM_NETWORK') return res.status(503).json({ success: false, error: 'Premiumize is unreachable right now. Please try again later.', code: 'PM_UNAVAILABLE' });
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
            const msg = String(error?.message || '');
            // Map common device flow errors explicitly for the renderer
            if (msg.includes('authorization_pending') || msg.includes(' 400 ')) {
                return res.json({ success: false, error: 'pending' });
            }
            if (msg.includes('slow_down') || msg.includes(' 429 ')) {
                return res.status(429).json({ success: false, error: 'slow_down' });
            }
            if (msg.includes('expired_token') || msg.includes(' 410 ')) {
                return res.status(410).json({ success: false, error: 'expired' });
            }
            if (msg.includes('access_denied') || msg.includes(' 418 ')) {
                return res.status(418).json({ success: false, error: 'denied' });
            }
            if (msg.includes('invalid_grant') || msg.includes(' 409 ') || msg.includes(' 404 ')) {
                return res.status(409).json({ success: false, error: 'invalid' });
            }
            console.error('[TRAKT] Device verify error:', error);
            res.status(500).json({ success: false, error: 'verify_failed' });
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
            const page = req.query.page || 1;
            const limit = req.query.limit || 100;
            const response = await traktFetch(`/users/me/watchlist/${type}?page=${page}&limit=${limit}`);
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

    // ===== GENERIC PROXY ENDPOINTS (to avoid CORS) =====
    // Proxy Xtream player_api.php JSON
    app.get('/api/proxy/xtream', async (req, res) => {
        try {
            let base = (req.query.base || '').toString();
            const params = (req.query.params || '').toString();
            if (!base.startsWith('http')) return res.status(400).json({ success: false, error: 'Invalid base' });
            // Basic sanitization: strip known portal suffixes
            try {
                const u = new URL(base);
                base = u.origin + u.pathname.replace(/\/+$/, '');
            } catch {}
            base = base.replace(/\/(player_api\.php|xmltv\.php|get\.php)$/i, '')
                       .replace(/\/(c|panel_api|client_area)\/?$/i, '')
                       .replace(/\/+$/, '');
            const headers = {
                'Accept': 'application/json,text/plain,*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
                'Referer': base
            };
            async function tryJsonResponse(up) {
                const ct = up.headers.get('content-type') || '';
                const text = await up.text();
                if (/application\/json|\+json/i.test(ct) || (text.trim().startsWith('{') || text.trim().startsWith('['))) {
                    try { return { ok: true, json: JSON.parse(text) }; } catch {}
                }
                return { ok: false, status: up.status, contentType: ct, bodySnippet: text.slice(0, 1000) };
            }

            // Attempt 1: GET player_api.php
            let url = `${base}/player_api.php?${params}`;
            let up = await fetch(url, { headers });
            let parsed = await tryJsonResponse(up);

            // If 414 (Request-URI Too Large) or not JSON, try POST to player_api.php
            if (!parsed.ok && (up.status === 414 || true)) {
                let upPost = await fetch(`${base}/player_api.php`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
                let parsedPost = await tryJsonResponse(upPost);
                if (parsedPost.ok) return res.json(parsedPost.json);
                parsed = parsedPost; up = upPost;
            }

            // If still not JSON and this looks like a login (no action=), try panel_api.php GET then POST
            if (!parsed.ok && !/(^|&)action=/.test(params)) {
                let upPanel = await fetch(`${base}/panel_api.php?${params}`, { headers });
                let parsedPanel = await tryJsonResponse(upPanel);
                if (!parsedPanel.ok) {
                    upPanel = await fetch(`${base}/panel_api.php`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
                    parsedPanel = await tryJsonResponse(upPanel);
                }
                if (parsedPanel.ok) return res.json(parsedPanel.json);
                parsed = parsedPanel; up = upPanel;
            }

            if (parsed.ok) return res.json(parsed.json);
            return res.json({ success: false, nonJson: true, status: up.status, contentType: parsed.contentType, bodySnippet: parsed.bodySnippet });
        } catch (e) {
            console.error('[PROXY] xtream error:', e.message);
            res.status(502).json({ success: false, error: 'xtream proxy failed' });
        }
    });

    // Proxy fetch text (e.g., M3U/M3U8 playlists)
    app.get('/api/proxy/fetch-text', async (req, res) => {
        try {
            let url = (req.query.url || '').toString();
            if (!url.startsWith('http')) return res.status(400).end('Invalid URL');
            const upstream = await fetch(url, { headers: { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36' } });
            const body = await upstream.text();
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(body);
        } catch (e) {
            console.error('[PROXY] fetch-text error:', e.message);
            res.status(502).end('proxy error');
        }
    });

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
                const rewrittenBody = body.replace(/^([^#\n\r]+\.(ts|m3u8))/gm, (match, segment) => {
                    const segmentUrl = segment.startsWith('http') ? segment : baseUrl + segment;
                    return `${req.protocol}://${req.get('host')}/stream/debrid?url=${encodeURIComponent(segmentUrl)}`;
                });
                
                console.log('[STREAM] HLS playlist rewritten, segments proxied through', `${req.protocol}://${req.get('host')}`);
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
            console.log('[STREAM] Request received:', {
                userAgent: req.headers['user-agent'],
                url: req.url,
                queryUrl: req.query?.url,
                method: req.method,
                headers: req.headers
            });
            
            let directUrl = (req.query?.url || '').toString();
            
            if (!directUrl) {
                console.error('[STREAM] Missing URL parameter');
                return res.status(400).end('Missing URL parameter');
            }
            
            // Handle double URL encoding: if the URL contains %XX sequences, decode them
            // This happens when the CDN URL itself has encoded characters that get re-encoded
            if (directUrl.includes('%')) {
                try {
                    directUrl = decodeURIComponent(directUrl);
                    console.log('[STREAM] Decoded URL to:', directUrl);
                } catch (e) {
                    // Already decoded or malformed, use as-is
                    console.log('[STREAM] URL decode failed, using as-is:', e.message);
                }
            }
            
            if (!directUrl.startsWith('http')) {
                console.error('[STREAM] Invalid URL after decode:', directUrl);
                return res.status(400).end('Bad URL');
            }
            
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
                const rewrittenBody = body.replace(/^([^#\n\r]+\.(ts|m3u8))/gm, (match, segment) => {
                    const segmentUrl = segment.startsWith('http') ? segment : baseUrl + segment;
                    return `${req.protocol}://${req.get('host')}/api/stream/debrid?url=${encodeURIComponent(segmentUrl)}`;
                });
                
                console.log('[STREAM] API HLS playlist rewritten');
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
        // ALWAYS write to userData for consistency (both dev and packaged)
        // This matches the read priority in loadAPIKey()
        return path.join(userDataPath, 'jackett_api_key.json');
    };

    function loadAPIKey() {
        try {
            // Always try to read from a root-level file if present
            for (const candidate of resolveReadCandidates()) {
                try {
                    if (fs.existsSync(candidate)) {
                        const raw = fs.readFileSync(candidate, 'utf8');
                        
                        // Handle both cases: JSON file and plain text (legacy)
                        let key = '';
                        try {
                            const parsed = JSON.parse(raw);
                            key = parsed.apiKey || '';
                        } catch (jsonErr) {
                            // Not JSON, try as plain text
                            key = raw.trim();
                        }
                        
                        if (key) {
                            API_KEY = key;
                            lastKeyPath = candidate;
                            console.log(`✅ API Key loaded from ${candidate}`);
                            return true;
                        } else {
                            console.warn(`⚠️ API Key file exists but is empty: ${candidate}`);
                        }
                    }
                } catch (e) {
                    console.warn(`⚠️ Error reading API key from ${candidate}:`, e?.message);
                    // keep trying other candidates
                }
            }

            // No root-level file found; clear cached key
            if (API_KEY) {
                console.log('ℹ️ No API key file found, clearing cached key');
            }
            API_KEY = '';
        } catch (error) {
            console.error('❌ Error loading API key:', error);
        }
        return false;
    }

    function saveAPIKey(apiKey) {
        const payload = JSON.stringify({ apiKey }, null, 2);
        
        // Try multiple locations in order of preference
        const writeCandidates = [
            path.join(userDataPath, 'jackett_api_key.json'),     // Primary: userData (always writable)
            path.join(installDir, 'jackett_api_key.json'),       // Secondary: next to exe (legacy)
            path.join(devRoot, 'jackett_api_key.json'),          // Tertiary: dev root
            path.join(process.cwd(), 'jackett_api_key.json')     // Fallback: current working dir
        ];
        
        let lastError = null;
        
        for (const targetPath of writeCandidates) {
            try {
                console.log(`[API Key] Attempting to save to: ${targetPath}`);
                
                // Ensure directory exists with error handling
                const targetDir = path.dirname(targetPath);
                try {
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
                        console.log(`[API Key] Created directory: ${targetDir}`);
                    }
                    
                    // Verify directory is writable
                    fs.accessSync(targetDir, fs.constants.W_OK);
                } catch (dirErr) {
                    console.warn(`[API Key] Directory not writable: ${targetDir}`, dirErr?.message);
                    lastError = dirErr;
                    continue; // Try next location
                }
                
                // Write the file with explicit error handling
                fs.writeFileSync(targetPath, payload, { encoding: 'utf8', mode: 0o644 });
                
                // Verify the file was written correctly
                if (fs.existsSync(targetPath)) {
                    const verification = fs.readFileSync(targetPath, 'utf8');
                    const parsed = JSON.parse(verification);
                    if (parsed.apiKey === apiKey) {
                        API_KEY = apiKey;
                        lastKeyPath = targetPath;
                        console.log(`✅ API Key successfully saved to ${targetPath}`);
                        
                        // Clean up old files from other locations to avoid confusion
                        for (const oldPath of writeCandidates) {
                            if (oldPath !== targetPath) {
                                try {
                                    if (fs.existsSync(oldPath)) {
                                        fs.unlinkSync(oldPath);
                                        console.log(`🗑️ Removed old API key from ${oldPath}`);
                                    }
                                } catch (cleanupErr) {
                                    // Ignore cleanup errors
                                }
                            }
                        }
                        
                        return true;
                    } else {
                        console.warn(`[API Key] Verification failed for ${targetPath}`);
                        lastError = new Error('Verification failed');
                    }
                } else {
                    console.warn(`[API Key] File not found after write: ${targetPath}`);
                    lastError = new Error('File not found after write');
                }
            } catch (err) {
                console.warn(`[API Key] Failed to write to ${targetPath}:`, err?.message || err);
                lastError = err;
                continue; // Try next location
            }
        }
        
        // All locations failed
        console.error('❌ Failed to save API key to any location. Last error:', lastError?.message || lastError);
        return false;
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
        // ============ ULTIMATE PEER DISCOVERY & CONNECTION OPTIMIZATION ============
        maxConns: 500,           // Massive connection pool for maximum peers (5x default)
        
        // DHT Configuration - Distributed Hash Table for decentralized peer discovery
        dht: {
            bootstrap: [
                // Primary DHT routers
                'router.bittorrent.com:6881',
                'router.utorrent.com:6881',
                'dht.transmissionbt.com:6881',
                'dht.aelitis.com:6881',
                'dht.libtorrent.org:25401',
                // Additional high-performance DHT nodes
                'router.silotis.us:6881',
                'dht.anacrolix.link:42069',
                'router.bitcomet.com:6881'
            ],
            maxTables: 10000,        // MASSIVE DHT routing table (2x increase)
            concurrency: 16,         // Parallel DHT lookups for faster peer discovery
            bootstrap_interval: 30000 // Re-bootstrap every 30s to maintain connections
        },
        
        // Tracker Configuration - Centralized peer discovery from top-tier trackers
        tracker: {
            announce: [
                // Tier 1: Ultra-fast UDP trackers with high uptime
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://open.tracker.cl:1337/announce',
                'udp://tracker.torrent.eu.org:451/announce',
                'udp://exodus.desync.com:6969/announce',
                'udp://tracker.moeking.me:6969/announce',
                'udp://explodie.org:6969/announce',
                'udp://tracker.openbittorrent.com:6969/announce',
                'udp://open.demonii.com:1337/announce',
                'udp://tracker.theoks.net:6969/announce',
                'udp://tracker.dler.org:6969/announce',
                
                // Tier 2: Additional reliable trackers
                'udp://tracker1.bt.moack.co.kr:80/announce',
                'udp://bt1.archive.org:6969/announce',
                'udp://bt2.archive.org:6969/announce',
                'udp://retracker.lanta-net.ru:2710/announce',
                'udp://open.stealth.si:80/announce',
                'udp://tracker.cyberia.is:6969/announce',
                'udp://tracker.tiny-vps.com:6969/announce',
                'udp://tracker.0x.tf:6969/announce',
                'udp://ipv4.tracker.harry.lu:80/announce',
                
                // Tier 3: HTTP/WebSocket fallbacks for restricted networks
                'http://tracker.openbittorrent.com:80/announce',
                'http://nyaa.tracker.wf:7777/announce',
                'http://tracker.opentrackr.org:1337/announce',
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.btorrent.xyz',
                'wss://tracker.webtorrent.dev'
            ],
            getAnnounceOpts: function () {
                return { 
                    numwant: 500,        // Request MAXIMUM peers per announce (5x increase)
                    compact: 1,          // Use compact peer format for efficiency
                    no_peer_id: 1        // Reduce bandwidth usage
                }
            },
            rtcConfig: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            },
            wrtc: false              // Disable WebRTC for Electron (native TCP faster)
        },
        
        // ============ PERFORMANCE OPTIMIZATIONS ============
        webSeeds: true,              // Enable HTTP web seeds for faster initial download
        uploadLimit: -1,             // Unlimited upload for better peer relationships
        downloadLimit: -1,           // Unlimited download for maximum speed
        
        // Advanced Protocol Features
        utp: true,                   // Micro Transport Protocol - better NAT traversal & less congestion
        lsd: true,                   // Local Service Discovery - find peers on LAN instantly
        natUpnp: true,               // UPnP for automatic port forwarding
        natPmp: true,                // NAT-PMP for automatic port forwarding (Apple devices)
        
        // Download Strategy
        pieceTimeout: 20000,         // 20s timeout for pieces (faster retry)
        blocklist: [],               // No blocklist for maximum peer pool
        
        // Connection Optimization
        handshakeTimeout: 10000      // 10s handshake timeout (faster connection establishment)
    });
    
    // Handle WebTorrent client errors to prevent crashes
    client.on('error', (err) => {
        console.error('[WebTorrent] Client error (non-fatal):', err.message || err);
        // Don't crash the server, just log the error
    });

    // ============ ADVANCED PEER DISCOVERY MONITORING ============
    // Log DHT stats for debugging and optimization
    setInterval(() => {
        try {
            if (client.torrents.length > 0) {
                const stats = {
                    activeTorrents: client.torrents.length,
                    totalPeers: client.torrents.reduce((sum, t) => sum + (t.numPeers || 0), 0),
                    totalDownloadSpeed: (client.downloadSpeed / 1024 / 1024).toFixed(2) + ' MB/s',
                    totalUploadSpeed: (client.uploadSpeed / 1024 / 1024).toFixed(2) + ' MB/s'
                };
                console.log(`[WebTorrent Stats] ${JSON.stringify(stats)}`);
                
                // Log individual torrent stats
                client.torrents.forEach(t => {
                    if (t.name) {
                        console.log(`  └─ ${t.name.substring(0, 40)}... | Peers: ${t.numPeers} | Down: ${(t.downloadSpeed / 1024).toFixed(0)} KB/s | Progress: ${(t.progress * 100).toFixed(1)}%`);
                    }
                });
            }
        } catch (err) {
            // Silent fail - stats are optional
        }
    }, 30000); // Log every 30 seconds

    const activeTorrents = new Map();
    const torrentTimestamps = new Map(); // Track last access time for cleanup
    
    // Auto-cleanup inactive torrents every 30 minutes
    const TORRENT_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [hash, timestamp] of torrentTimestamps.entries()) {
            if (now - timestamp > TORRENT_TIMEOUT) {
                const torrent = activeTorrents.get(hash);
                if (torrent) {
                    console.log(`[Cleanup] Removing inactive torrent: ${hash}`);
                    try {
                        client.remove(torrent, () => {});
                        activeTorrents.delete(hash);
                        torrentTimestamps.delete(hash);
                    } catch (err) {
                        console.error(`[Cleanup] Error removing torrent ${hash}:`, err);
                    }
                }
            }
        }
    }, 10 * 60 * 1000); // Check every 10 minutes

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
        
        console.log('[API Key] Save request received');
        
        if (saveAPIKey(key)) {
            console.log('[API Key] Save successful, verifying...');
            
            // Verify by reading it back
            loadAPIKey();
            if (API_KEY === key) {
                console.log('[API Key] Verification successful');
                res.json({ 
                    success: true, 
                    message: 'API key saved successfully',
                    path: lastKeyPath 
                });
            } else {
                console.error('[API Key] Verification failed - saved key does not match');
                res.status(500).json({ 
                    error: 'API key saved but verification failed',
                    details: 'The key was written but could not be read back correctly'
                });
            }
        } else {
            console.error('[API Key] Save failed - no writable location found');
            res.status(500).json({ 
                error: 'Failed to save API key',
                details: 'Could not write to any of the expected locations. Check file permissions.',
                attemptedPaths: [
                    path.join(userDataPath, 'jackett_api_key.json'),
                    path.join(path.dirname(process.execPath), 'jackett_api_key.json')
                ]
            });
        }
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
        const torrentOptions = { 
            path: torrentDownloadPath, 
            destroyStoreOnDestroy: true,
            
            // ============ PER-TORRENT OPTIMIZATIONS ============
            announce: [  // Aggressive tracker list per torrent
                // Primary high-performance trackers
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://open.tracker.cl:1337/announce',
                'udp://tracker.torrent.eu.org:451/announce',
                'udp://exodus.desync.com:6969/announce',
                'udp://tracker.moeking.me:6969/announce',
                'udp://explodie.org:6969/announce',
                'udp://tracker.openbittorrent.com:6969/announce',
                'udp://open.demonii.com:1337/announce',
                'udp://tracker.theoks.net:6969/announce',
                'udp://tracker.cyberia.is:6969/announce',
                // Backup trackers
                'udp://retracker.lanta-net.ru:2710/announce',
                'udp://bt1.archive.org:6969/announce',
                'http://tracker.openbittorrent.com:80/announce',
                'wss://tracker.openwebtorrent.com'
            ],
            maxWebConns: 20,          // Increased web seed connections for faster download
            strategy: 'sequential',   // Sequential downloading optimized for streaming
            skipVerify: false,        // Always verify pieces for data integrity
            storeCacheSlots: 20       // Cache more pieces in memory for smoother playback
        };
        const torrent = client.add(magnet, torrentOptions);
        activeTorrents.set(infoHash, torrent);
        torrentTimestamps.set(infoHash, Date.now()); // Track access time

        // ============ AGGRESSIVE PEER WIRE OPTIMIZATION ============
        // Optimize each peer connection for maximum throughput
        torrent.on('wire', (wire, addr) => {
            console.log(`[Peer Connected] ${addr} for ${infoHash.substring(0, 8)}...`);
            
            // Enable fast extension for faster piece exchange
            try {
                if (wire.peerExtensions && wire.peerExtensions.extended) {
                    // Peer supports extensions - great for performance
                }
                
                // Unchoke peer immediately to start downloading
                if (wire.peerChoking) {
                    // We're choked, request unchoke
                }
                
                // Set aggressive request queue size for faster downloads
                wire.setKeepAlive(true);  // Keep connection alive
                
            } catch (err) {
                // Silent fail - wire optimization is optional
            }
        });
        
        // Monitor peer discovery progress
        torrent.on('peer', (peer) => {
            console.log(`[Peer Discovered] ${peer} for ${infoHash.substring(0, 8)}...`);
        });
        
        // Log when we get our first data to track buffering speed
        let firstDataLogged = false;
        torrent.on('download', () => {
            if (!firstDataLogged && torrent.downloaded > 0) {
                firstDataLogged = true;
                console.log(`[First Data] Received for ${infoHash.substring(0, 8)}... | Peers: ${torrent.numPeers} | Speed: ${(torrent.downloadSpeed / 1024).toFixed(0)} KB/s`);
            }
        });

        // Handle torrent-level errors
        torrent.on('error', (err) => {
            console.error(`[Torrent Error] ${infoHash}:`, err.message || err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Torrent error: ' + (err.message || 'Unknown error') });
            }
            // Clean up failed torrent
            try {
                activeTorrents.delete(infoHash);
                client.remove(torrent, () => {});
            } catch {}
        });

        // As soon as metadata is available, deselect everything to prevent auto-download
        torrent.on('metadata', () => {
            console.log(`[Metadata] Received for ${torrent.name} | Peers: ${torrent.numPeers} | Pieces: ${torrent.pieces.length}`);
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
    });

    app.get('/api/stream-file', (req, res) => {
        try {
            const { hash, file: fileIndex } = req.query;
            if (!hash || isNaN(fileIndex)) return res.status(400).send('Missing hash or file index');
            const torrent = activeTorrents.get(hash);
            if (!torrent) return res.status(404).send('Torrent not found');
            
            torrentTimestamps.set(hash, Date.now()); // Update access time

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
                
                // ============ ULTIMATE PIECE PRIORITIZATION STRATEGY ============
                const pieceLength = torrent.pieceLength;
                const fileStart = Math.max(0, Math.floor(file.offset / pieceLength));
                const fileEnd = Math.max(fileStart, Math.floor((file.offset + file.length - 1) / pieceLength));
                
                // Select the entire file range with priority
                try {
                    torrent.select(fileStart, fileEnd, 2);  // High priority for entire file
                } catch {}
                
                // ============ PHASE 1: CRITICAL INITIAL BUFFER (20MB) ============
                // Larger initial buffer = smoother playback start, less stuttering
                const criticalBytes = 20 * 1024 * 1024; // 20MB critical buffer (2x increase)
                const criticalPieces = Math.ceil(criticalBytes / pieceLength);
                const criticalEnd = Math.min(fileStart + criticalPieces, fileEnd);
                
                console.log(`[OPTIMIZATION] Critical buffer: ${(criticalBytes / 1024 / 1024).toFixed(1)}MB (pieces ${fileStart}-${criticalEnd})`);
                
                // Download critical pieces with MAXIMUM priority
                for (let i = fileStart; i <= criticalEnd; i++) {
                    try {
                        torrent.critical(i, i);  // Highest priority
                    } catch {}
                }
                
                // ============ PHASE 2: EXTENDED BUFFER FOR SMOOTH PLAYBACK (50MB) ============
                // Extended buffer prevents buffering during playback
                const extendedBytes = 50 * 1024 * 1024; // 50MB extended buffer
                const extendedPieces = Math.ceil(extendedBytes / pieceLength);
                const extendedEnd = Math.min(fileStart + extendedPieces, fileEnd);
                
                // High priority for extended buffer (after critical pieces)
                for (let i = criticalEnd + 1; i <= extendedEnd; i++) {
                    try {
                        torrent.select(i, i, 3);  // Very high priority
                    } catch {}
                }
                
                console.log(`[OPTIMIZATION] Extended buffer: ${(extendedBytes / 1024 / 1024).toFixed(1)}MB (pieces ${criticalEnd + 1}-${extendedEnd})`);
                
                // ============ PHASE 3: END PIECES FOR SEEKING ============
                // Pre-download end for instant seeking to credits/end
                const endPriorityPieces = Math.min(10, Math.floor((fileEnd - fileStart) / 10));
                const endStart = Math.max(fileStart, fileEnd - endPriorityPieces);
                
                for (let i = endStart; i <= fileEnd; i++) {
                    try {
                        torrent.select(i, i, 2);  // High priority for end pieces
                    } catch {}
                }
                
                console.log(`[OPTIMIZATION] End buffer: ${endPriorityPieces} pieces (${endStart}-${fileEnd})`);
                
                // ============ PHASE 4: MIDDLE PIECES - RAREST FIRST ============
                // Middle pieces use rarest-first for optimal swarm performance
                // WebTorrent handles this automatically for non-critical pieces
                
                console.log(`[Streaming] Optimized piece selection: Critical→Extended→End→Rarest for ${file.name}`);
                console.log(`[Streaming] Total file pieces: ${fileEnd - fileStart + 1}, File size: ${(file.length / 1024 / 1024).toFixed(1)}MB`);
                
                
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
        } catch (error) {
            console.error('[Stream Error]:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Streaming error: ' + (error.message || 'Unknown error') });
            }
        }
    });

    // Prepare a specific file for streaming: select the file and start downloading its pieces (and all subtitles), but do not stream yet
    app.get('/api/prepare-file', (req, res) => {
        try {
            const { hash, file: fileIndex } = req.query;
            if (!hash || isNaN(fileIndex)) return res.status(400).json({ success: false, error: 'Missing hash or file index' });
            const torrent = activeTorrents.get(hash);
            if (!torrent) return res.status(404).json({ success: false, error: 'Torrent not found' });
            
            torrentTimestamps.set(hash, Date.now()); // Update access time

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
                
                // CRITICAL: Prioritize first 15MB for pre-buffering (more than streaming)
                const priorityBytes = 15 * 1024 * 1024; // 15MB for prepare
                const priorityPieces = Math.ceil(priorityBytes / pieceLength);
                const priorityEnd = Math.min(fileStart + priorityPieces, fileEnd);
                
                // Download first pieces with highest priority
                for (let i = fileStart; i <= priorityEnd; i++) {
                    try {
                        torrent.critical(i, i);
                    } catch {}
                }
                
                // OPTIMIZATION: Also prioritize last few pieces for seeking
                const endPriorityPieces = Math.min(5, Math.floor((fileEnd - fileStart) / 2));
                for (let i = Math.max(fileStart, fileEnd - endPriorityPieces); i <= fileEnd; i++) {
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
        } catch (error) {
            console.error('[Prepare Error]:', error);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Prepare error: ' + (error.message || 'Unknown error') });
            }
        }
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
                torrentTimestamps.delete(hash); // Clean up timestamp
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
        console.log(`[/api/torrents] query="${query}", useTorrentless=${useTorrentless}, will use: ${useTorrentless ? 'TORRENTLESS' : 'JACKETT'}`);
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
        console.log(`[Jackett] API_KEY check: ${API_KEY ? 'KEY EXISTS (length=' + API_KEY.length + ')' : 'KEY IS EMPTY'}`);
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
            console.error('[Jackett] Error fetching torrents:', error);
            try {
                const msg = String(error?.message || '').toLowerCase();
                // Detect common connection failures to Jackett (e.g., ECONNREFUSED 127.0.0.1:9117)
                const isConnRefused = msg.includes('econnrefused');
                const isConnReset = msg.includes('econnreset');
                const isNotFound = msg.includes('enotfound');
                const isTimeout = msg.includes('timeout') || msg.includes('timed out');
                if (isConnRefused || isConnReset || isNotFound || isTimeout) {
                    return res.status(503).json({
                        error: 'Jackett is not enabled or not installed, please enable it and try again, other providers dont need jackett',
                        code: 'JACKETT_UNAVAILABLE'
                    });
                }
            } catch {}
            res.status(500).json({ error: error?.message || 'Jackett error' });
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

    // ===== MUSIC DOWNLOAD ENDPOINT =====
    
    // Store download progress and processes in memory
    const downloadProgress = new Map();
    const downloadProcesses = new Map(); // downloadId -> { proc, outputPath }
    
    app.post('/api/music/download', async (req, res) => {
        try {
            const { trackUrl, songName, artistName, downloadId } = req.body;
            
            console.log('\n[Music Download] Starting download...');
            console.log(`[Music Download] Song: "${songName}" by ${artistName}`);
            console.log(`[Music Download] Track URL: ${trackUrl}`);
            console.log(`[Music Download] Download ID: ${downloadId}`);
            
            if (!trackUrl || !songName || !artistName) {
                return res.status(400).json({ success: false, error: 'Missing required fields' });
            }

            // Create download directory in app data
            const downloadDir = path.join(userDataPath, 'Music Downloads');
            if (!fs.existsSync(downloadDir)) {
                fs.mkdirSync(downloadDir, { recursive: true });
                console.log(`[Music Download] Created download directory: ${downloadDir}`);
            }

            // Sanitize filename
            const sanitize = (str) => str.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
            const filename = `${sanitize(songName)} - ${sanitize(artistName)}.flac`;
            const outputPath = path.join(downloadDir, filename);

            console.log(`[Music Download] Output path: ${outputPath}`);

            // Check if file already exists
            if (fs.existsSync(outputPath)) {
                console.log('[Music Download] File already exists, skipping download');
                return res.json({ 
                    success: true, 
                    message: 'File already exists',
                    filePath: outputPath 
                });
            }

            // Start ffmpeg process
            // Resolve ffmpeg binary path (handle asar packaging)
            let resolvedFfmpegPath = ffmpegPath || 'ffmpeg';
            try {
                if (resolvedFfmpegPath && resolvedFfmpegPath.includes('app.asar')) {
                    resolvedFfmpegPath = resolvedFfmpegPath.replace('app.asar', 'app.asar.unpacked');
                }
                // If path doesn't exist (packaged quirks), fall back to PATH lookup
                if (resolvedFfmpegPath && !fs.existsSync(resolvedFfmpegPath)) {
                    console.warn(`[Music Download] ffmpeg binary not found at ${resolvedFfmpegPath}. Falling back to PATH executable.`);
                    resolvedFfmpegPath = 'ffmpeg';
                }
            } catch (_) {}

            console.log('[Music Download] Starting FFmpeg process using:', resolvedFfmpegPath);
            const ffmpeg = spawn(resolvedFfmpegPath, [
                '-i', trackUrl,
                '-vn',
                '-ar', '44100',
                '-ac', '2',
                '-c:a', 'flac',
                '-y', // Overwrite output file if exists
                outputPath
            ]);

            let currentProgress = 0;
            let duration = 0;

            // Initialize progress tracking
            if (downloadId) {
                downloadProgress.set(downloadId, { 
                    progress: 0, 
                    complete: false,
                    filePath: outputPath 
                });
                downloadProcesses.set(downloadId, { proc: ffmpeg, outputPath });
            }

            // Parse ffmpeg output for progress
            ffmpeg.stderr.on('data', (data) => {
                const output = data.toString();
                
                // Extract duration
                const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}.\d{2})/);
                if (durationMatch) {
                    const hours = parseInt(durationMatch[1]);
                    const minutes = parseInt(durationMatch[2]);
                    const seconds = parseFloat(durationMatch[3]);
                    duration = hours * 3600 + minutes * 60 + seconds;
                    console.log(`[Music Download] Duration detected: ${durationMatch[0]}`);
                }

                // Extract current time for progress
                const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2}.\d{2})/);
                if (timeMatch && duration > 0) {
                    const hours = parseInt(timeMatch[1]);
                    const minutes = parseInt(timeMatch[2]);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentTime = hours * 3600 + minutes * 60 + seconds;
                    const newProgress = Math.min(100, Math.round((currentTime / duration) * 100));
                    
                    // Update progress map
                    if (downloadId && downloadProgress.has(downloadId)) {
                        downloadProgress.get(downloadId).progress = newProgress;
                    }
                    
                    // Only log every 10% change
                    if (newProgress >= currentProgress + 10 || newProgress === 100) {
                        console.log(`[Music Download] Progress: ${newProgress}%`);
                        currentProgress = newProgress;
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                // Remove process reference
                if (downloadId) downloadProcesses.delete(downloadId);
                if (code === 0) {
                    console.log('[Music Download] ✓ Download complete!');
                    console.log(`[Music Download] Saved to: ${outputPath}\n`);
                    
                    // Mark as complete
                    if (downloadId && downloadProgress.has(downloadId)) {
                        downloadProgress.get(downloadId).complete = true;
                        downloadProgress.get(downloadId).progress = 100;
                    }
                    
                    res.json({ 
                        success: true, 
                        message: 'Download complete',
                        filePath: outputPath 
                    });
                    
                    // Clean up progress after 5 seconds
                    setTimeout(() => {
                        if (downloadId) downloadProgress.delete(downloadId);
                    }, 5000);
                } else {
                    console.error(`[Music Download] ✗ FFmpeg exited with code ${code}`);
                    // Clean up partial file
                    if (fs.existsSync(outputPath)) {
                        try { 
                            fs.unlinkSync(outputPath); 
                            console.log('[Music Download] Deleted partial file');
                        } catch(_) {}
                    }
                    
                    if (downloadId) downloadProgress.delete(downloadId);
                    
                    res.status(500).json({ 
                        success: false, 
                        error: `FFmpeg exited with code ${code}` 
                    });
                }
            });

            ffmpeg.on('error', (err) => {
                if (downloadId) downloadProcesses.delete(downloadId);
                console.error('[Music Download] ✗ FFmpeg error:', err);
                // Clean up partial file
                if (fs.existsSync(outputPath)) {
                    try { 
                        fs.unlinkSync(outputPath); 
                        console.log('[Music Download] Deleted partial file');
                    } catch(_) {}
                }
                
                if (downloadId) downloadProgress.delete(downloadId);
                
                if (!res.headersSent) {
                    res.status(500).json({ 
                        success: false, 
                        error: 'Failed to start download: ' + err.message 
                    });
                }
            });

        } catch (error) {
            console.error('[Music Download] Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get download progress
    app.get('/api/music/download/progress/:downloadId', (req, res) => {
        const { downloadId } = req.params;
        const progress = downloadProgress.get(downloadId);
        if (progress) {
            res.json(progress);
        } else {
            res.json({ progress: 0, complete: false });
        }
    });

    // Cancel a music download
    app.post('/api/music/download/cancel', (req, res) => {
        try {
            const { downloadId } = req.body || {};
            if (!downloadId) return res.status(400).json({ success: false, error: 'Missing downloadId' });
            const procEntry = downloadProcesses.get(downloadId);
            const progEntry = downloadProgress.get(downloadId);
            if (!procEntry && !progEntry) {
                return res.status(404).json({ success: false, error: 'Download not found' });
            }
            // Kill ffmpeg process if exists
            if (procEntry && procEntry.proc && !procEntry.proc.killed) {
                try {
                    procEntry.proc.kill('SIGKILL');
                } catch (_) {
                    try { procEntry.proc.kill(); } catch (_) {}
                }
            }
            // Delete partial file if exists
            const outputPath = (procEntry && procEntry.outputPath) || (progEntry && progEntry.filePath);
            if (outputPath && fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            downloadProcesses.delete(downloadId);
            downloadProgress.delete(downloadId);
            console.log(`[Music Download] ✗ Cancelled download ${downloadId} and cleaned up`);
            return res.json({ success: true });
        } catch (error) {
            console.error('[Music Download] Cancel error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    // Serve downloaded music files
    app.get('/api/music/serve/:filePath(*)', (req, res) => {
        try {
            const filePath = decodeURIComponent(req.params.filePath);
            console.log(`[Music Serve] Request to serve: ${filePath}`);
            
            const downloadDir = path.join(userDataPath, 'Music Downloads');
            // Ensure the path is within our download directory
            if (!filePath.startsWith(downloadDir)) {
                console.log('[Music Serve] ✗ Invalid path - outside download directory');
                return res.status(400).json({ error: 'Invalid path' });
            }
            
            if (!fs.existsSync(filePath)) {
                console.log('[Music Serve] ✗ File not found');
                return res.status(404).json({ error: 'File not found' });
            }
            
            console.log('[Music Serve] ✓ Serving file');
            res.setHeader('Content-Type', 'audio/flac');
            res.setHeader('Accept-Ranges', 'bytes');
            
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;
            
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(filePath, { start, end });
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Length': chunksize
                });
                file.pipe(res);
            } else {
                res.writeHead(200, { 'Content-Length': fileSize });
                fs.createReadStream(filePath).pipe(res);
            }
        } catch (error) {
            console.error('[Music Serve] ✗ Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Delete downloaded music file
    app.post('/api/music/delete', (req, res) => {
        try {
            const { filePath } = req.body;
            console.log(`[Music Delete] Request to delete: ${filePath}`);
            
            if (!filePath) return res.status(400).json({ success: false, error: 'Missing filePath' });
            
            const downloadDir = path.join(userDataPath, 'Music Downloads');
            // Ensure the path is within our download directory
            if (!filePath.startsWith(downloadDir)) {
                console.log('[Music Delete] ✗ Invalid path - outside download directory');
                return res.status(400).json({ success: false, error: 'Invalid path' });
            }
            
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log('[Music Delete] ✓ File deleted successfully');
                return res.json({ success: true });
            } else {
                console.log('[Music Delete] ✗ File not found');
                return res.status(404).json({ success: false, error: 'File not found' });
            }
        } catch (error) {
            console.error('[Music Delete] ✗ Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Batch check for existence of downloaded music files
    app.post('/api/music/exists-batch', (req, res) => {
        try {
            const { filePaths } = req.body || {};
            if (!Array.isArray(filePaths)) {
                return res.status(400).json({ success: false, error: 'filePaths must be an array' });
            }

            const downloadDir = path.join(userDataPath, 'Music Downloads');
            const normDownloadDir = path.normalize(downloadDir);

            const results = {};
            for (const fp of filePaths) {
                try {
                    if (!fp || typeof fp !== 'string') { results[String(fp)] = false; continue; }
                    const norm = path.normalize(fp);
                    // Security: ensure within downloads directory
                    if (!norm.startsWith(normDownloadDir)) { results[fp] = false; continue; }
                    results[fp] = fs.existsSync(norm);
                } catch (_) {
                    results[String(fp)] = false;
                }
            }
            return res.json({ success: true, results });
        } catch (error) {
            console.error('[Music Exists Batch] ✗ Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== GLOBAL ERROR HANDLERS =====
    
    // Catch-all 404 handler for undefined routes
    app.use((req, res, next) => {
        if (!res.headersSent) {
            res.status(404).json({ error: 'Route not found: ' + req.path });
        }
    });

    // Global error handling middleware - must be last
    app.use((err, req, res, next) => {
        console.error('[Express Error]:', err.stack || err);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error',
                message: err.message || 'Unknown error'
            });
        }
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
        console.error('[UNCAUGHT EXCEPTION]:', err);
        console.error('Stack:', err.stack);
        // Don't exit the process, just log it
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[UNHANDLED REJECTION]:', reason);
        console.error('Promise:', promise);
        // Don't exit the process, just log it
    });

    // Track active sockets for forceful shutdown
    const activeSockets = new Set();

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
        console.log(`  🎮 Games       → http://localhost:${PORT}/api/games/search/*`);
        console.log(`  🌊 Nuvio Proxy  → http://localhost:${PORT}/api/nuvio/stream/*`);
        console.log(`  ☄️  Comet Proxy  → http://localhost:${PORT}/api/comet/stream/*`);
        console.log(`\n💾 Cache System:\n`);
        console.log(`  ⏱️  Duration     → 1 hour (auto-refresh)`);
        console.log(`  🗑️  Clear Cache  → POST /api/clear-cache`);
        console.log(`  📊 Cache Stats  → GET /api/cache-stats`);
        if (!hasAPIKey) console.log('\n⚠️  Jackett API key not configured.');
        console.log(`\n${'='.repeat(70)}\n`);
    });

    // Track connections for later forced destroy
    server.on('connection', (socket) => {
        activeSockets.add(socket);
        socket.on('close', () => { activeSockets.delete(socket); });
    });

    // Handle server errors
    server.on('error', (err) => {
        console.error('[Server Error]:', err);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use. Please close other instances or change the port.`);
        }
    });

    // Augment server with forceful shutdown helpers
    server.destroyAllSockets = () => {
        for (const s of activeSockets) {
            try { s.destroy(); } catch(_) {}
        }
        activeSockets.clear();
    };
    server.getActiveSocketCount = () => activeSockets.size;

    return { server, client, clearCache };
}
