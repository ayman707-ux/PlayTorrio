import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, Menu } from 'electron';
import { spawn, fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import os from 'os';
// electron-updater is CommonJS; use default import + destructure for ESM
import updaterPkg from 'electron-updater';
import { startServer } from './server.mjs'; // Import the server

const { autoUpdater } = updaterPkg;

let httpServer;
let webtorrentClient;
let mainWindow;
let torrentlessProc = null;
let svc111477Proc = null;
let booksProc = null;
let booksDesiredPort = 3004;
let booksBaseUrl = 'http://127.0.0.1:3004';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure a stable AppUserModelID to prevent Windows taskbar/shortcut icon issues after updates
try { app.setAppUserModelId('com.ayman.PlayTorrio'); } catch(_) {}

// ----------------------
// Auto Update (Main-only)
// ----------------------
function setupAutoUpdater() {
    try {
        // Only enable in packaged builds
        if (!app.isPackaged) {
            console.log('[Updater] Skipping auto-update in development mode');
            return;
        }

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            console.log('[Updater] Checking for updates...');
            try {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    if (mainWindow.webContents.isLoading()) {
                        mainWindow.webContents.once('did-finish-load', () => {
                            mainWindow.webContents.send('update-checking', {});
                        });
                    } else {
                        mainWindow.webContents.send('update-checking', {});
                    }
                }
            } catch(_) {}
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[Updater] Update available:', info?.version || 'unknown');
            try {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    // Ensure renderer is ready before sending
                    if (mainWindow.webContents.isLoading()) {
                        mainWindow.webContents.once('did-finish-load', () => {
                            mainWindow.webContents.send('update-available', info || {});
                        });
                    } else {
                        mainWindow.webContents.send('update-available', info || {});
                    }
                }
            } catch(_) {}
            // Auto-download will start automatically, so the download-progress event will follow
        });

        autoUpdater.on('update-not-available', (info) => {
            console.log('[Updater] No updates available');
            try {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
                    if (mainWindow.webContents.isLoading()) {
                        mainWindow.webContents.once('did-finish-load', () => {
                            mainWindow.webContents.send('update-not-available', info || {});
                        });
                    } else {
                        mainWindow.webContents.send('update-not-available', info || {});
                    }
                }
            } catch(_) {}
        });

        autoUpdater.on('error', (err) => {
            console.error('[Updater] Error:', err?.message || err);
            // Retry on network errors after delay
            if (checkAttempts < maxRetries && (
                err?.message?.includes('net::') || 
                err?.message?.includes('ENOTFOUND') ||
                err?.message?.includes('timeout')
            )) {
                console.log(`[Updater] Network error detected, retrying in 30s...`);
                setTimeout(checkForUpdatesWithRetry, 30000);
            }
        });

        autoUpdater.on('download-progress', (progressObj) => {
            const pct = Math.round(progressObj?.percent || 0);
            console.log(`[Updater] Download progress: ${pct}%`);
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-download-progress', progressObj || {});
                }
            } catch(_) {}
        });

        autoUpdater.on('update-downloaded', async (info) => {
            console.log('[Updater] Update downloaded:', info?.version || 'unknown');
            try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('update-downloaded', info || {});
                }
            } catch(_) {}
        });

        // Perform initial check with retry logic
        let checkAttempts = 0;
        const maxRetries = 3;
        const checkForUpdatesWithRetry = () => {
            try {
                checkAttempts++;
                autoUpdater.checkForUpdates();
            } catch (e) {
                console.error(`[Updater] checkForUpdates failed (attempt ${checkAttempts}):`, e?.message || e);
                if (checkAttempts < maxRetries) {
                    setTimeout(checkForUpdatesWithRetry, 10000); // Retry after 10s
                }
            }
        };
        setTimeout(checkForUpdatesWithRetry, 4000);
    } catch (e) {
        console.error('[Updater] setup failed:', e?.message || e);
    }
}

// Function to clear the webtorrent temp folder
async function clearWebtorrentTemp() {
    try {
        // Get cache location from settings
        const userDataPath = app.getPath('userData');
        const settingsPath = path.join(userDataPath, 'user_settings.json');
        let cacheLocation = os.tmpdir();
        
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.cacheLocation) {
                    cacheLocation = settings.cacheLocation;
                }
            } catch (err) {
                console.error('Error reading settings:', err);
            }
        }
        
        const tempPath = path.join(cacheLocation, 'webtorrent');
        console.log(`Clearing webtorrent temp folder: ${tempPath}`);
        await fs.promises.rm(tempPath, { recursive: true, force: true });
        console.log('Webtorrent temp folder cleared successfully');
        return { success: true, message: 'Webtorrent temp folder cleared' };
    } catch (error) {
        console.error('Error clearing webtorrent temp folder:', error);
        return { success: false, message: 'Failed to clear webtorrent temp folder: ' + error.message };
    }
}

// Function to clear the downloaded subtitles temp folder (cross-user)
async function clearPlaytorrioSubtitlesTemp() {
    try {
        // Get cache location from settings
        const userDataPath = app.getPath('userData');
        const settingsPath = path.join(userDataPath, 'user_settings.json');
        let cacheLocation = os.tmpdir();
        
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                if (settings.cacheLocation) {
                    cacheLocation = settings.cacheLocation;
                }
            } catch (err) {
                console.error('Error reading settings:', err);
            }
        }
        
        const subsPath = path.join(cacheLocation, 'playtorrio_subs');
        console.log(`Clearing subtitles temp folder: ${subsPath}`);
        await fs.promises.rm(subsPath, { recursive: true, force: true });
        console.log('Subtitles temp folder cleared successfully');
        return { success: true, message: 'Subtitles temp folder cleared' };
    } catch (error) {
        console.error('Error clearing subtitles temp folder:', error);
        return { success: false, message: 'Failed to clear subtitles temp folder: ' + error.message };
    }
}

// Resolve bundled MPV executable path (prefer packaged resources, then local dev folder). Windows-focused.
function resolveMpvExe() {
    try {
        const candidates = [];
        // In packaged apps, resourcesPath is where extraResources are copied
        if (process.resourcesPath) {
            // When using asarUnpack, binaries live under app.asar.unpacked
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'mpv', process.platform === 'win32' ? 'mpv.exe' : 'mpv'));
            // Some configurations might place directly under resources
            candidates.push(path.join(process.resourcesPath, 'mpv', process.platform === 'win32' ? 'mpv.exe' : 'mpv'));
        }
        // Next to the current file when running unpackaged
        candidates.push(path.join(__dirname, 'mpv', process.platform === 'win32' ? 'mpv.exe' : 'mpv'));
        // Next to the executable (some packagers place resources here)
        candidates.push(path.join(path.dirname(process.execPath), 'mpv', process.platform === 'win32' ? 'mpv.exe' : 'mpv'));

        for (const p of candidates) {
            try { if (fs.existsSync(p)) return p; } catch {}
        }
    } catch {}
    return null;
}

// Launch MPV and set up cleanup listeners
function openInMPV(win, streamUrl, infoHash, startSeconds) {
    try {
        console.log('Attempting to launch MPV with URL:', streamUrl);
        const mpvPath = resolveMpvExe();
        if (!mpvPath) {
            const msg = 'Bundled MPV not found. Place portable mpv.exe under the app\mpv folder.';
            console.error(msg);
            return { success: false, message: msg };
        }
        const args = [];
        const start = Number(startSeconds || 0);
        if (!isNaN(start) && start > 10) {
            args.push(`--start=${Math.floor(start)}`);
        }
        args.push(streamUrl);
        const mpvProcess = spawn(mpvPath, args, { stdio: 'ignore' });

        mpvProcess.on('close', async (code) => {
            // By request: do not disconnect torrent or delete temp when MPV closes.
            console.log(`MPV player closed with code ${code}. Leaving torrent active and temp files intact.`);
            // Optionally inform renderer that MPV closed (no cleanup performed)
            try { win.webContents.send('mpv-closed', { infoHash, code }); } catch(_) {}
        });

        mpvProcess.on('error', (err) => {
            console.error('Failed to start MPV process:', err);
        });

        return { success: true, message: 'MPV launched successfully' };
    } catch (error) {
        console.error('Error launching MPV:', error);
        return { success: false, message: 'Failed to launch MPV: ' + error.message };
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1200,
        minHeight: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false, // Disable web security to allow iframes from different origins
            allowRunningInsecureContent: true, // Allow mixed content
            experimentalFeatures: true, // Enable experimental features for better iframe support
        },
        // Enable custom title bar (frameless) and set background to match purple theme
        frame: false,
        backgroundColor: '#120a1f',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    });
    // Remove default application menu (File/Edit/View/Help)
    try { Menu.setApplicationMenu(null); } catch(_) {}

    // Enable all permissions for iframe content
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        // Allow all permissions (autoplay, media, etc.)
        callback(true);
    });

    // Helper: allow-list for external reader/login domains
    const ALLOWED_READER_HOSTS = new Set([
        'reader.z-lib.gd',
        'reader.z-library.sk',
        'reader.z-lib.fm'
    ]);
    const isAllowedReaderDomain = (url) => {
        try {
            const { hostname } = new URL(url);
            const h = hostname.toLowerCase();
            if (ALLOWED_READER_HOSTS.has(h)) return true;
            // Allow SingleLogin for auth redirects if reader requires it
            if (h.includes('singlelogin')) return true;
            return false;
        } catch (_) { return false; }
    };

    // Intercept new windows (target=_blank) and open allowed reader domains externally
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedReaderDomain(url)) {
            console.log('[Books] Opening reader in external browser:', url);
            try { shell.openExternal(url); } catch(_) {}
            return { action: 'deny' };
        }
        console.log('Blocked popup attempt:', url);
        return { action: 'deny' };
    });

    // Prevent navigation away from the app, but open allowed reader domains externally
    win.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('http://127.0.0.1:3000') || url.startsWith('http://localhost:3000')) {
            return; // internal app navigation
        }
        if (isAllowedReaderDomain(url)) {
            event.preventDefault();
            console.log('[Books] Opening reader via navigation in external browser:', url);
            try { shell.openExternal(url); } catch(_) {}
            return;
        }
        console.log('Blocked navigation attempt:', url);
        event.preventDefault();
    });

    // Allow iframes to load
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': ['default-src * \'unsafe-inline\' \'unsafe-eval\' data: blob:;']
            }
        });
    });

    // Always load the local server so all API and subtitle URLs are same-origin HTTP
    setTimeout(() => win.loadURL('http://localhost:3000'), app.isPackaged ? 500 : 2000);
    return win;
}

// Launch the Torrentless scraper server
function startTorrentless() {
    try {
        // Resolve script path in both dev and packaged environments (prefer resources/Torrentless/server.js in build)
        const candidates = [];
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'Torrentless', 'server.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'Torrentless', 'server.js'));
        }
        candidates.push(path.join(__dirname, 'Torrentless', 'server.js'));
        // Back-compat extra candidates
        if (process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'Torrentless', 'start.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'Torrentless', 'start.js'));
        }
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('Torrentless server entry not found. Ensure the Torrentless folder is packaged.');
            return;
        }
        // Compute NODE_PATH so the child can resolve dependencies from the app's node_modules
        const nodePathCandidates = [
            path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
            path.join(process.resourcesPath || '', 'node_modules'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
            path.join(__dirname, 'node_modules'),
            path.join(path.dirname(entry), 'node_modules'),
        ];
        const existingNodePaths = nodePathCandidates.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
        const NODE_PATH_VALUE = existingNodePaths.join(path.delimiter);
        // Spawn Electron binary in Node mode to run server.js (equivalent to: node server.js)
        const logPath = path.join(app.getPath('userData'), 'torrentless.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const childEnv = { ...process.env, PORT: '3002', ELECTRON_RUN_AS_NODE: '1', NODE_PATH: NODE_PATH_VALUE };
        torrentlessProc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        // Pipe logs for diagnostics in packaged builds
        try {
            torrentlessProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            torrentlessProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        torrentlessProc.on('exit', (code, signal) => {
            console.log(`Torrentless exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            // On unexpected exit during runtime, attempt a single restart
            if (!app.isQuitting) {
                setTimeout(() => { try { startTorrentless(); } catch(_) {} }, 1000);
            }
        });

        torrentlessProc.on('error', (err) => {
            console.error('Failed to start Torrentless server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Probe /api/health to confirm the service is up; fallback to system Node if needed
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25; // ~10s @ 400ms
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: 3002, path: '/api/health', timeout: 350 }, (res) => {
                        if (res.statusCode === 200) {
                            healthy = true;
                            console.log('Torrentless is up on http://127.0.0.1:3002');
                            clearInterval(timer);
                            try { res.resume(); } catch(_) {}
                        } else {
                            try { res.resume(); } catch(_) {}
                        }
                    });
                    req.on('timeout', () => { try { req.destroy(); } catch(_) {} });
                    req.on('error', () => {});
                } catch(_) {}
                if (attempts >= maxAttempts) {
                    clearInterval(timer);
                    if (!healthy && !app.isQuitting) {
                        // Attempt fallback using system Node if available (dev only)
                        if (!app.isPackaged) {
                            try {
                                console.warn('Torrentless did not respond; attempting to start with system Node (dev)...');
                                // Stop previous child if any
                                try { torrentlessProc && torrentlessProc.kill('SIGTERM'); } catch(_) {}
                                const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
                                torrentlessProc = spawn(nodeCmd, [entry], {
                                    stdio: ['ignore', 'pipe', 'pipe'],
                                    env: { ...process.env, PORT: '3002' },
                                    cwd: path.dirname(entry),
                                    shell: false
                                });
                                try {
                                    torrentlessProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
                                    torrentlessProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
                                    torrentlessProc.on('error', (err) => {
                                        console.error('System Node fallback failed (Torrentless):', err?.message || err);
                                        try { logStream.write('System Node fallback error: ' + String(err?.stack || err) + '\n'); } catch(_) {}
                                    });
                                } catch(_) {}
                            } catch (e) {
                                console.error('Fallback start with system Node failed:', e);
                                try { logStream.write('Fallback failed: ' + String(e?.stack || e) + '\n'); } catch(_) {}
                            }
                        } else {
                            console.warn('Skipping system Node fallback in packaged build (Torrentless).');
                        }
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start Torrentless server:', e);
    }
}

function start111477() {
    try {
        const candidates = [];
        // In packaged builds, prefer resources locations first (avoid running from inside asar)
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, '111477', 'src', 'index.js'));
            candidates.push(path.join(process.resourcesPath, '111477', 'index.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', '111477', 'src', 'index.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', '111477', 'index.js'));
        }
        // Dev paths
        candidates.push(path.join(__dirname, '111477', 'src', 'index.js'));
        candidates.push(path.join(__dirname, '111477', 'index.js'));
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('111477 server entry not found. Ensure the 111477 folder is packaged.');
            return;
        }
        console.log('[111477] Using entry:', entry);

        // Resolve NODE_PATH for child
        const nodePathCandidates = [
            path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
            path.join(process.resourcesPath || '', 'node_modules'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
            path.join(__dirname, 'node_modules'),
            // node_modules next to entry dir (covers dev when src/node_modules exists)
            path.join(path.dirname(entry), 'node_modules'),
            // node_modules in parent of src (packaged extraResources: 111477/node_modules)
            path.join(path.dirname(path.dirname(entry)), 'node_modules'),
        ];
        const existingNodePaths = nodePathCandidates.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
        const NODE_PATH_VALUE = existingNodePaths.join(path.delimiter);

        // Spawn electron binary as node
        const logPath = path.join(app.getPath('userData'), '111477.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const childEnv = { ...process.env, PORT: '3003', ELECTRON_RUN_AS_NODE: '1', NODE_PATH: NODE_PATH_VALUE, TMDB_API_KEY: 'b3556f3b206e16f82df4d1f6fd4545e6' };
        svc111477Proc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        try {
            svc111477Proc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            svc111477Proc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        svc111477Proc.on('exit', (code, signal) => {
            console.log(`111477 exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            if (!app.isQuitting) {
                setTimeout(() => { try { start111477(); } catch(_) {} }, 1000);
            }
        });

        svc111477Proc.on('error', (err) => {
            console.error('Failed to start 111477 server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Health probe
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25;
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: 3003, path: '/health', timeout: 350 }, (res) => {
                        if (res.statusCode === 200) {
                            healthy = true;
                            console.log('111477 is up on http://127.0.0.1:3003');
                            clearInterval(timer);
                            try { res.resume(); } catch(_) {}
                        } else {
                            try { res.resume(); } catch(_) {}
                        }
                    });
                    req.on('timeout', () => { try { req.destroy(); } catch(_) {} });
                    req.on('error', () => {});
                } catch(_) {}
                if (attempts >= maxAttempts) {
                    clearInterval(timer);
                    if (!healthy && !app.isQuitting) {
                        if (!app.isPackaged) {
                            try {
                                console.warn('111477 did not respond; attempting to start with system Node (dev)...');
                                try { svc111477Proc && svc111477Proc.kill('SIGTERM'); } catch(_) {}
                                const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
                                svc111477Proc = spawn(nodeCmd, [entry], {
                                    stdio: ['ignore', 'pipe', 'pipe'],
                                    env: { ...process.env, PORT: '3003', TMDB_API_KEY: 'b3556f3b206e16f82df4d1f6fd4545e6' },
                                    cwd: path.dirname(entry),
                                    shell: false
                                });
                                try {
                                    svc111477Proc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
                                    svc111477Proc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
                                    svc111477Proc.on('error', (err) => {
                                        console.error('System Node fallback failed (111477):', err?.message || err);
                                        try { logStream.write('System Node fallback error: ' + String(err?.stack || err) + '\n'); } catch(_) {}
                                    });
                                } catch(_) {}
                            } catch (e) {
                                console.error('Fallback start with system Node failed (111477):', e);
                                try { logStream.write('Fallback failed: ' + String(e?.stack || e) + '\n'); } catch(_) {}
                            }
                        } else {
                            console.warn('111477 did not respond in time; restarting Electron-as-Node child (packaged)...');
                            try { svc111477Proc && svc111477Proc.kill('SIGTERM'); } catch(_) {}
                            setTimeout(() => { try { start111477(); } catch(_) {} }, 500);
                        }
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start 111477 server:', e);
    }
}

// Launch the Books (Z-Library) search server
function startBooks() {
    try {
        // Resolve script path in both dev and packaged environments
        const candidates = [];
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'books', 'server.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'books', 'server.js'));
        }
        candidates.push(path.join(__dirname, 'books', 'server.js'));
        
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('Books server entry not found. Ensure the books folder is packaged.');
            return;
        }
        console.log('[Books] Using entry:', entry);

        // Compute NODE_PATH so the child can resolve dependencies from the app's node_modules
        const nodePathCandidates = [
            path.join(process.resourcesPath || '', 'app.asar', 'node_modules'),
            path.join(process.resourcesPath || '', 'node_modules'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules'),
            path.join(__dirname, 'node_modules'),
            path.join(path.dirname(entry), 'node_modules'),
        ];
        const existingNodePaths = nodePathCandidates.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
        const NODE_PATH_VALUE = existingNodePaths.join(path.delimiter);

        // Spawn Electron binary in Node mode to run server.js
        const logPath = path.join(app.getPath('userData'), 'books.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const childEnv = { 
            ...process.env, 
            PORT: String(booksDesiredPort), 
            ELECTRON_RUN_AS_NODE: '1', 
            NODE_PATH: NODE_PATH_VALUE,
            // Force the Books server to use z-lib.gd as the primary/only mirror
            ZLIB_FORCE_DOMAIN: 'z-lib.gd'
        };
        booksProc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        // Pipe logs for diagnostics
        try {
            booksProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            booksProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        booksProc.on('exit', (code, signal) => {
            console.log(`Books server exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            // On unexpected exit during runtime, attempt a single restart
            if (!app.isQuitting) {
                setTimeout(() => { try { startBooks(); } catch(_) {} }, 1000);
            }
        });

        booksProc.on('error', (err) => {
            console.error('Failed to start Books server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Probe /health to confirm the service is up
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25; // ~10s @ 400ms
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: booksDesiredPort, path: '/health', timeout: 350 }, (res) => {
                        if (res.statusCode === 200) {
                            healthy = true;
                            booksBaseUrl = `http://127.0.0.1:${booksDesiredPort}`;
                            console.log('Books server is up on ' + booksBaseUrl);
                            clearInterval(timer);
                            try { res.resume(); } catch(_) {}
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('books-url', { url: booksBaseUrl });
                                }
                            } catch(_) {}
                        } else {
                            try { res.resume(); } catch(_) {}
                        }
                    });
                    req.on('timeout', () => { try { req.destroy(); } catch(_) {} });
                    req.on('error', () => {});
                } catch(_) {}
                if (attempts >= maxAttempts) {
                    clearInterval(timer);
                    if (!healthy && !app.isQuitting) {
                        // Try a different local port and restart the books server for reliability
                        const fallbackPorts = [43004, 53004];
                        const nextPort = fallbackPorts.find(p => p !== booksDesiredPort) || 43004;
                        console.warn(`[Books] Health check failed on port ${booksDesiredPort}. Retrying on port ${nextPort}...`);
                        try { booksProc && booksProc.kill('SIGTERM'); } catch(_) {}
                        booksDesiredPort = nextPort;
                        // Restart fresh
                        setTimeout(() => { try { startBooks(); } catch(_) {} }, 300);
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start Books server:', e);
    }
}

// Enforce single instance with a friendly error on second run
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    // Show a friendly error instead of port-in-use errors
    try { dialog.showErrorBox("PlayTorrio", "The app is already running."); } catch(_) {}
    app.quit();
} else {
    app.on('second-instance', () => {
        // Focus existing window if user tried to open a second instance
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
    // Start the integrated streaming server (port 3000)
    const { server, client } = startServer(app.getPath('userData'));
    httpServer = server;
    webtorrentClient = client;

    // Start the Torrentless scraper server (port 3002)
    startTorrentless();

    // Start the 111477 service (port 3003)
    start111477();

    // Start the Books (Z-Library) search server (port 3004)
    startBooks();

        mainWindow = createWindow();

    // IPC handler to open MPV from renderer
    ipcMain.handle('open-in-mpv', (event, data) => {
        const { streamUrl, infoHash, startSeconds } = data || {};
        console.log(`Received MPV open request for hash: ${infoHash}`);
            return openInMPV(mainWindow, streamUrl, infoHash, startSeconds);
    });

    // IPC handler for manual temp folder clearing (e.g., from Close Player button)
    ipcMain.handle('clear-webtorrent-temp', async () => {
        return await clearWebtorrentTemp();
    });

    // IPC handler for the new Clear Cache button
    ipcMain.handle('clear-cache', async () => {
            const results = [];
            const r1 = await clearWebtorrentTemp(); results.push(r1);
            const r2 = await clearPlaytorrioSubtitlesTemp(); results.push(r2);
            const success = results.every(r => r.success);
            const message = success
                ? 'Cache cleared: webtorrent and downloaded subtitles.'
                : results.map(r => r.message).join(' | ');
            return { success, message };
    });

    // IPC handler: Select cache folder
    ipcMain.handle('select-cache-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select Cache Location'
        });
        
        if (!result.canceled && result.filePaths.length > 0) {
            return { success: true, path: result.filePaths[0] };
        }
        return { success: false };
    });

    // Removed MPV installer helpers and IPC

    // IPC handler: Restart app on demand
    ipcMain.handle('restart-app', () => {
        app.relaunch();
        app.exit(0);
    });

    // Window control IPC handlers
    ipcMain.handle('window-minimize', () => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); } catch(_) {}
        return { success: true };
    });
    ipcMain.handle('window-maximize-toggle', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMaximized()) {
                    mainWindow.restore();
                } else {
                    mainWindow.maximize();
                }
                return { success: true, isMaximized: mainWindow.isMaximized() };
            }
        } catch(_) {}
        return { success: false };
    });
    ipcMain.handle('window-close', () => {
        try {
            app.isQuitting = true;
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        } catch(_) {}
        return { success: true };
    });

    // Notify renderer about maximize state changes (to swap icons)
    try {
        if (mainWindow) {
            mainWindow.on('maximize', () => {
                try { mainWindow.webContents.send('window-maximize-changed', { isMaximized: true }); } catch(_) {}
            });
            mainWindow.on('unmaximize', () => {
                try { mainWindow.webContents.send('window-maximize-changed', { isMaximized: false }); } catch(_) {}
            });
        }
    } catch(_) {}

    // IPC handler: Open external URL in default browser
    ipcMain.handle('open-external', async (event, url) => {
        try {
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
                return { success: false, message: 'Invalid URL' };
            }
            await shell.openExternal(url);
            return { success: true };
        } catch (err) {
            return { success: false, message: err?.message || 'Failed to open URL' };
        }
    });

    // IPC: get current Books base URL (dynamic port safe)
    ipcMain.handle('books-get-url', async () => {
        try { return { success: true, url: booksBaseUrl }; } catch(e) { return { success: false, url: 'http://127.0.0.1:3004' }; }
    });

    // IPC: copy text to clipboard
    ipcMain.handle('copy-to-clipboard', async (event, text) => {
        try {
            if (typeof text !== 'string' || !text.length) {
                return { success: false, message: 'Nothing to copy' };
            }
            clipboard.writeText(text);
            return { success: true };
        } catch (err) {
            return { success: false, message: err?.message || 'Failed to copy' };
        }
    });

    // Optional IPC: allow renderer to install the downloaded update
    // Change: Close the app and DO NOT relaunch automatically.
    ipcMain.handle('updater-install', async () => {
        try {
            // Install update and do not run after install
            // electron-updater: quitAndInstall(isSilent=false, isForceRunAfter=false)
            try {
                // Relaunch automatically after install to reduce user friction
                autoUpdater.quitAndInstall(false, true);
            } catch (e) {
                // Fallback: force exit if updater throws; Electron/installer should relaunch
                app.exit(0);
            }
            // Safety: if app still hasn't exited in 3s (edge cases), force exit
            setTimeout(() => { try { app.exit(0); } catch(_) {} }, 3000);
            return { success: true };
        } catch (e) {
            return { success: false, message: e?.message || 'Failed to install update' };
        }
    });

    // My List IPC handlers
    ipcMain.handle('my-list-read', async () => {
        try {
            const myListPath = path.join(app.getPath('userData'), 'my-list.json');
            if (fs.existsSync(myListPath)) {
                const data = await fs.promises.readFile(myListPath, 'utf8');
                return { success: true, data: JSON.parse(data) };
            } else {
                return { success: true, data: [] };
            }
        } catch (error) {
            console.error('Error reading my-list.json:', error);
            return { success: false, message: error.message, data: [] };
        }
    });

    ipcMain.handle('my-list-write', async (event, listData) => {
        try {
            const myListPath = path.join(app.getPath('userData'), 'my-list.json');
            await fs.promises.writeFile(myListPath, JSON.stringify(listData, null, 2));
            return { success: true };
        } catch (error) {
            console.error('Error writing my-list.json:', error);
            return { success: false, message: error.message };
        }
    });

    // Done Watching IPC handlers
    ipcMain.handle('done-watching-read', async () => {
        try {
            const doneWatchingPath = path.join(app.getPath('userData'), 'done-watching.json');
            if (fs.existsSync(doneWatchingPath)) {
                const data = await fs.promises.readFile(doneWatchingPath, 'utf8');
                return { success: true, data: JSON.parse(data) };
            } else {
                return { success: true, data: [] };
            }
        } catch (error) {
            console.error('Error reading done-watching.json:', error);
            return { success: false, message: error.message, data: [] };
        }
    });

    ipcMain.handle('done-watching-write', async (event, listData) => {
        try {
            const doneWatchingPath = path.join(app.getPath('userData'), 'done-watching.json');
            await fs.promises.writeFile(doneWatchingPath, JSON.stringify(listData, null, 2));
            return { success: true };
        } catch (error) {
            console.error('Error writing done-watching.json:', error);
            return { success: false, message: error.message };
        }
    });

    // Fullscreen management
    ipcMain.handle('set-fullscreen', async (event, isFullscreen) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setFullScreen(isFullscreen);
                return { success: true };
            }
            return { success: false, message: 'Main window not available' };
        } catch (error) {
            console.error('Error setting fullscreen:', error);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('get-fullscreen', async () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                return { success: true, isFullscreen: mainWindow.isFullScreen() };
            }
            return { success: false, message: 'Main window not available' };
        } catch (error) {
            console.error('Error getting fullscreen state:', error);
            return { success: false, message: error.message };
        }
    });

        // Initialize the auto-updater (main-process only, no renderer changes)
        setupAutoUpdater();
    });
}

// Graceful shutdown
app.on('will-quit', () => {
    app.isQuitting = true;
    // Shut down the webtorrent client
    if (webtorrentClient) {
        webtorrentClient.destroy(() => {
            console.log('WebTorrent client destroyed.');
        });
    }
    // Shut down the HTTP server
    if (httpServer) {
        httpServer.close(() => {
            console.log('HTTP server closed.');
        });
    }
    // Stop Torrentless child process
    if (torrentlessProc) {
        try { torrentlessProc.kill('SIGTERM'); } catch(_) {}
        torrentlessProc = null;
    }
    // Stop 111477 child process
    if (svc111477Proc) {
        try { svc111477Proc.kill('SIGTERM'); } catch(_) {}
        svc111477Proc = null;
    }
    // Stop Books child process
    if (booksProc) {
        try { booksProc.kill('SIGTERM'); } catch(_) {}
        booksProc = null;
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
