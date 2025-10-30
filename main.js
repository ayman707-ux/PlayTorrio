import { app, BrowserWindow, ipcMain, shell, clipboard, dialog, Menu } from 'electron';
import { spawn, fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import os from 'os';
import got from 'got';
import { pipeline as streamPipelineCb } from 'stream';
import { promisify } from 'util';
import dns from 'dns';

// electron-updater is CommonJS; use default import + destructure for ESM
import updaterPkg from 'electron-updater';
// discord-rpc is CommonJS; default import works under ESM
import RPC from 'discord-rpc';
import { startServer } from './server.mjs'; // Import the server
// Chromecast module will be dynamically imported when needed

const { autoUpdater } = updaterPkg;
const streamPipeline = promisify(streamPipelineCb);
const dnsLookup = promisify(dns.lookup);

let httpServer;
let webtorrentClient;
let mainWindow;

// ============================================================================
// NOTE: Microservice process variables no longer used
// All services now integrated into server.mjs via api.cjs on port 3000
// ============================================================================
// let torrentlessProc = null;
// let svc111477Proc = null;
// let booksProc = null;
// let booksDesiredPort = 3004;
// let booksBaseUrl = 'http://127.0.0.1:3004';
// let randomBookProc = null;
// let randomBookDesiredPort = 5000;
// let randomBookBaseUrl = 'http://127.0.0.1:5000';
// let animeProc = null;
// let animeDesiredPort = 7000;
// let animeBaseUrl = 'http://127.0.0.1:7000';
// let torrentioProc = null;
// let torrentioDesiredPort = 5500;
// let torrentioBaseUrl = 'http://127.0.0.1:5500';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Ensure a stable AppUserModelID to prevent Windows taskbar/shortcut icon issues after updates
try { app.setAppUserModelId('com.ayman.PlayTorrio'); } catch(_) {}

// ----------------------
// Discord Rich Presence
// ----------------------
const DISCORD_CLIENT_ID = '1430114242815725579';
let discordRpc = null;
let discordRpcReady = false;

function setupDiscordRPC() {
    try {
        if (!DISCORD_CLIENT_ID) return;
        // Avoid double init
        if (discordRpc) return;
        try { RPC.register(DISCORD_CLIENT_ID); } catch(_) {}

        discordRpc = new RPC.Client({ transport: 'ipc' });

        const setBaseActivity = () => {
            try {
                if (!discordRpc) return;
                discordRpc.setActivity({
                    details: 'Browsing PlayTorrio',
                    startTimestamp: new Date(),
                    largeImageKey: 'icon', // uploaded image name on Discord dev portal
                    largeImageText: 'PlayTorrio App',
                    buttons: [
                        { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                    ]
                });
            } catch (e) {
                console.error('[Discord RPC] setActivity error:', e?.message || e);
            }
        };

        discordRpc.on('ready', () => {
            discordRpcReady = true;
            setBaseActivity();
            console.log('✅ Discord Rich Presence active!');
        });

        discordRpc.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
            console.error('[Discord RPC] login failed:', err?.message || err);
        });
    } catch (e) {
        console.error('[Discord RPC] setup failed:', e?.message || e);
    }
}

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
    // We want to show the NSIS installer UI (non-silent) and exit immediately once ready
    // So do NOT auto-install on app quit; we will explicitly quitAndInstall when downloaded
    autoUpdater.autoInstallOnAppQuit = false;

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
            // Immediately start installer with UI (isSilent=false) and run app after finish (isForceRunAfter=true)
            try {
                console.log('[Updater] Launching installer and quitting app...');
                // Small delay to allow renderer to show a toast before quitting
                setTimeout(() => {
                    // Note: Microservices no longer running - all handled by server.mjs
                    try { autoUpdater.quitAndInstall(false, true); } catch (e) {
                        console.error('[Updater] quitAndInstall failed:', e);
                        // As a fallback, force app to quit; installer will run on next start if needed
                        try { app.quit(); } catch(_) {}
                    }
                }, 1500);
            } catch (e) {
                console.error('[Updater] Failed to launch installer:', e);
            }
        });

        // Perform initial check with connectivity guard and retry logic
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

        const isOnline = async (timeoutMs = 1500) => {
            try {
                const p = dnsLookup('github.com');
                await Promise.race([
                    p,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
                ]);
                return true;
            } catch (_) {
                return false;
            }
        };

        const scheduleInitialCheck = async () => {
            const online = await isOnline(1500);
            if (!online) {
                console.log('[Updater] Offline at startup, delaying update check...');
                setTimeout(scheduleInitialCheck, 10000);
                return;
            }
            checkForUpdatesWithRetry();
        };
        setTimeout(scheduleInitialCheck, 4000);
    } catch (e) {
        console.error('[Updater] setup failed:', e?.message || e);
    }
}

// Ensure processes are terminated when updater begins quitting
app.on('before-quit-for-update', () => {
    // Note: Microservices no longer running - all handled by server.mjs on port 3000
});

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

// Resolve bundled VLC executable path (prefer packaged resources, then local dev folder). Windows-focused.
function resolveVlcExe() {
    try {
        const exeName = process.platform === 'win32' ? 'vlc.exe' : 'vlc';
        const candidates = [];
        // In packaged apps, resourcesPath is where extraResources are copied
        if (process.resourcesPath) {
            // PortableApps layout: VLC/App/vlc/vlc.exe
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'VLC', 'App', 'vlc', exeName));
            candidates.push(path.join(process.resourcesPath, 'VLC', 'App', 'vlc', exeName));
            // Flat layout fallback: vlc/vlc.exe
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'vlc', exeName));
            candidates.push(path.join(process.resourcesPath, 'vlc', exeName));
        }
        // Next to current file when running unpackaged
        candidates.push(path.join(__dirname, 'VLC', 'App', 'vlc', exeName));
        candidates.push(path.join(__dirname, 'vlc', exeName));
        // Next to executable
        candidates.push(path.join(path.dirname(process.execPath), 'VLC', 'App', 'vlc', exeName));
        candidates.push(path.join(path.dirname(process.execPath), 'vlc', exeName));

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
            
            // Clear Discord presence when MPV closes
            try {
                if (discordRpc && discordRpcReady) {
                    await discordRpc.setActivity({
                        details: 'Browsing PlayTorrio',
                        startTimestamp: new Date(),
                        largeImageKey: 'icon',
                        largeImageText: 'PlayTorrio App',
                        buttons: [
                            { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                        ]
                    });
                }
            } catch (err) {
                console.error('[Discord RPC] Failed to clear on MPV close:', err);
            }
            
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

// Launch VLC and set up cleanup listeners
function openInVLC(win, streamUrl, infoHash, startSeconds) {
    try {
        console.log('Attempting to launch VLC with URL:', streamUrl);
        const vlcPath = resolveVlcExe();
        if (!vlcPath) {
            const msg = 'Bundled VLC not found. Place portable VLC under the app/VLC (PortableApps) or app/vlc folder.';
            console.error(msg);
            return { success: false, message: msg };
        }
        const args = [];
        const start = Number(startSeconds || 0);
        if (!isNaN(start) && start > 10) {
            // VLC start time in seconds
            args.push(`--start-time=${Math.floor(start)}`);
        }
        args.push(streamUrl);
        const vlcProcess = spawn(vlcPath, args, { stdio: 'ignore' });

        vlcProcess.on('close', async (code) => {
            console.log(`VLC player closed with code ${code}. Leaving torrent active and temp files intact.`);
            // Clear Discord presence when VLC closes
            try {
                if (discordRpc && discordRpcReady) {
                    await discordRpc.setActivity({
                        details: 'Browsing PlayTorrio',
                        startTimestamp: new Date(),
                        largeImageKey: 'icon',
                        largeImageText: 'PlayTorrio App',
                        buttons: [
                            { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                        ]
                    });
                }
            } catch (err) {
                console.error('[Discord RPC] Failed to clear on VLC close:', err);
            }
            try { win.webContents.send('vlc-closed', { infoHash, code }); } catch(_) {}
        });

        vlcProcess.on('error', (err) => {
            console.error('Failed to start VLC process:', err);
        });

        return { success: true, message: 'VLC launched successfully' };
    } catch (error) {
        console.error('Error launching VLC:', error);
        return { success: false, message: 'Failed to launch VLC: ' + error.message };
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
            spellcheck: false,
            backgroundThrottling: true
        },
        backgroundColor: '#120a1f',
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

// Start RandomBook server
function startRandomBook() {
    if (randomBookProc) {
        console.log('RandomBook server already running');
        return;
    }

    try {
        console.log('Starting RandomBook server...');
        
        // Resolve script path in both dev and packaged environments
        const candidates = [];
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'RandomBook', 'server.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'RandomBook', 'server.js'));
        }
        candidates.push(path.join(__dirname, 'RandomBook', 'server.js'));
        
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('RandomBook server entry not found. Ensure the RandomBook folder is packaged.');
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

        // Spawn Electron binary in Node mode to run server.js
        const logPath = path.join(app.getPath('userData'), 'randombook.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const childEnv = { 
            ...process.env, 
            PORT: String(randomBookDesiredPort), 
            ELECTRON_RUN_AS_NODE: '1', 
            NODE_PATH: NODE_PATH_VALUE
        };
        randomBookProc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        // Pipe logs for diagnostics
        try {
            randomBookProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            randomBookProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        randomBookProc.on('exit', (code, signal) => {
            console.log(`RandomBook server exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            // On unexpected exit during runtime, attempt a single restart
            if (!app.isQuitting) {
                setTimeout(() => { try { startRandomBook(); } catch(_) {} }, 1000);
            }
        });

        randomBookProc.on('error', (err) => {
            console.error('Failed to start RandomBook server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Test if the server is up by checking port response
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25; // ~10s @ 400ms
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: randomBookDesiredPort, path: '/', timeout: 350 }, (res) => {
                        if (res.statusCode === 200 || res.statusCode === 404) {
                            healthy = true;
                            randomBookBaseUrl = `http://127.0.0.1:${randomBookDesiredPort}`;
                            console.log('RandomBook server is up on ' + randomBookBaseUrl);
                            clearInterval(timer);
                            try { res.resume(); } catch(_) {}
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('randombook-url', { url: randomBookBaseUrl });
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
                        console.warn(`[RandomBook] Failed to start server on port ${randomBookDesiredPort}`);
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start RandomBook server:', e);
    }
}

// Start Anime (Nyaa) server
function startAnime() {
    if (animeProc) {
        console.log('Anime server already running');
        return;
    }

    try {
        console.log('Starting Anime server...');
        
        // Resolve script path in both dev and packaged environments
        const candidates = [];
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'anime', 'server.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'anime', 'server.js'));
        }
        candidates.push(path.join(__dirname, 'anime', 'server.js'));
        
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('Anime server entry not found. Ensure the anime folder is packaged.');
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

        // Spawn Electron binary in Node mode to run server.js
        const logPath = path.join(app.getPath('userData'), 'anime.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const childEnv = { 
            ...process.env, 
            PORT: String(animeDesiredPort), 
            ELECTRON_RUN_AS_NODE: '1', 
            NODE_PATH: NODE_PATH_VALUE
        };
        animeProc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        // Pipe logs for diagnostics
        try {
            animeProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            animeProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        animeProc.on('exit', (code, signal) => {
            console.log(`Anime server exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            // On unexpected exit during runtime, attempt a single restart
            if (!app.isQuitting) {
                setTimeout(() => { try { startAnime(); } catch(_) {} }, 1000);
            }
        });

        animeProc.on('error', (err) => {
            console.error('Failed to start Anime server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Probe /api/test to confirm the service is up
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25; // ~10s @ 400ms
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: animeDesiredPort, path: '/health', timeout: 350 }, (res) => {
                        if (res.statusCode === 200) {
                            healthy = true;
                            animeBaseUrl = `http://127.0.0.1:${animeDesiredPort}`;
                            console.log('Anime server is up on ' + animeBaseUrl);
                            clearInterval(timer);
                            try { res.resume(); } catch(_) {}
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('anime-url', { url: animeBaseUrl });
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
                        console.warn(`[Anime] Failed to start server on port ${animeDesiredPort}`);
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start Anime server:', e);
    }
}

function startTorrentio() {
    if (torrentioProc) {
        console.log('Torrentio server already running');
        return;
    }

    try {
        console.log('Starting Torrentio server...');
        
        // Resolve script path in both dev and packaged environments
        const candidates = [];
        if (app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'Torrentio', 'server.js'));
            candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'Torrentio', 'server.js'));
        }
        candidates.push(path.join(__dirname, 'Torrentio', 'server.js'));
        
        let entry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { entry = p; break; } } catch {}
        }
        if (!entry) {
            console.warn('Torrentio server entry not found. Ensure the Torrentio folder is packaged.');
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

        // Spawn Electron binary in Node mode to run server.js
        const logPath = path.join(app.getPath('userData'), 'torrentio.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const childEnv = { 
            ...process.env, 
            PORT: String(torrentioDesiredPort), 
            ELECTRON_RUN_AS_NODE: '1', 
            NODE_PATH: NODE_PATH_VALUE
        };
        torrentioProc = spawn(process.execPath, [entry], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv,
            cwd: path.dirname(entry),
        });

        // Pipe logs for diagnostics
        try {
            torrentioProc.stdout.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
            torrentioProc.stderr.on('data', (d) => { try { logStream.write(d); } catch(_) {} });
        } catch (_) {}

        torrentioProc.on('exit', (code, signal) => {
            console.log(`Torrentio server exited code=${code} signal=${signal}`);
            try { logStream.end(); } catch(_) {}
            // On unexpected exit during runtime, attempt a single restart
            if (!app.isQuitting) {
                setTimeout(() => { try { startTorrentio(); } catch(_) {} }, 1000);
            }
        });

        torrentioProc.on('error', (err) => {
            console.error('Failed to start Torrentio server process:', err);
            try { logStream.write(String(err?.stack || err) + '\n'); } catch(_) {}
        });

        // Probe / (root endpoint) to confirm the service is up
        try {
            let attempts = 0;
            let healthy = false;
            const maxAttempts = 25; // ~10s @ 400ms
            const timer = setInterval(() => {
                attempts++;
                try {
                    const req = http.get({ hostname: '127.0.0.1', port: torrentioDesiredPort, path: '/', timeout: 350 }, (res) => {
                        if (res.statusCode === 200) {
                            healthy = true;
                            clearInterval(timer);
                            console.log(`Torrentio is up on ${torrentioBaseUrl}`);
                            try {
                                if (mainWindow && !mainWindow.isDestroyed()) {
                                    mainWindow.webContents.send('torrentio-url', { url: torrentioBaseUrl });
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
                        console.warn(`[Torrentio] Failed to start server on port ${torrentioDesiredPort}`);
                    }
                }
            }, 400);
        } catch(_) {}
    } catch (e) {
        console.error('Failed to start Torrentio server:', e);
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

    app.whenReady().then(async () => {
    // Initialize Discord RPC (guard on connectivity)
    try {
        const online = await (async () => {
            try { await dnsLookup('discord.com'); return true; } catch { return false; }
        })();
        if (online) {
            setupDiscordRPC();
        } else {
            console.log('[Discord RPC] Skipping init: offline');
        }
    } catch(_) {}
    // Start the unified server (port 3000) - handles all API routes including anime, books, torrents, etc.
    const { server, client, clearCache } = startServer(app.getPath('userData'));
    httpServer = server;
    webtorrentClient = client;
    
    // Store clearCache function globally for cleanup on exit
    global.clearApiCache = clearCache;

    // ============================================================================
    // NOTE: All microservices below are now integrated into server.mjs via api.cjs
    // No need to start individual servers - all routes available on localhost:3000
    // ============================================================================
    // startTorrentless();  // Now: localhost:3000/torrentless/api/*
    // start111477();       // Now: localhost:3000/111477/api/*
    // startBooks();        // Now: localhost:3000/zlib/*
    // startRandomBook();   // Now: localhost:3000/otherbook/api/*
    // startAnime();        // Now: localhost:3000/anime/api/*
    // startTorrentio();    // Now: localhost:3000/torrentio/api/*

        mainWindow = createWindow();

    // IPC handler to open MPV from renderer
    ipcMain.handle('open-in-mpv', (event, data) => {
        const { streamUrl, infoHash, startSeconds } = data || {};
        console.log(`Received MPV open request for hash: ${infoHash}`);
            return openInMPV(mainWindow, streamUrl, infoHash, startSeconds);
    });

    // Advanced MPV launcher with headers (for MovieBox/FMovies)
    ipcMain.handle('open-mpv-headers', async (event, options) => {
        try {
            const {
                url,
                userAgent,
                referer,
                cookie,
                startSeconds,
                hlsBitrate
            } = options || {};

            if (!url) {
                return { success: false, message: 'Missing URL' };
            }

            const mpvPath = resolveMpvExe();
            if (!mpvPath) {
                return { success: false, message: 'Bundled MPV not found' };
            }

            const args = [];
            const start = Number(startSeconds || 0);
            if (!isNaN(start) && start > 10) {
                args.push(`--start=${Math.floor(start)}`);
            }

            if (userAgent) {
                args.push(`--user-agent=${userAgent}`);
            }
            if (referer) {
                args.push(`--referrer=${referer}`);
            }
            if (cookie) {
                // Pass cookie via HTTP header fields
                args.push(`--http-header-fields=Cookie: ${cookie}`);
            }
            if (typeof hlsBitrate === 'number' && hlsBitrate > 0) {
                args.push(`--hls-bitrate=${Math.floor(hlsBitrate)}`);
            }

            // Finally add the URL
            args.push(url);

            const mpvProcess = spawn(mpvPath, args, { stdio: 'ignore' });

            mpvProcess.on('close', async (code) => {
                console.log(`MPV (headers) closed with code ${code}`);
                try {
                    if (discordRpc && discordRpcReady) {
                        await discordRpc.setActivity({
                            details: 'Browsing PlayTorrio',
                            startTimestamp: new Date(),
                            largeImageKey: 'icon',
                            largeImageText: 'PlayTorrio App',
                            buttons: [
                                { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                            ]
                        });
                    }
                } catch (err) {
                    console.error('[Discord RPC] Failed to clear on MPV (headers) close:', err);
                }
            });

            mpvProcess.on('error', (err) => {
                console.error('Failed to start MPV (headers):', err);
            });

            return { success: true, message: 'MPV launched with headers' };
        } catch (e) {
            console.error('Error launching MPV with headers:', e);
            return { success: false, message: e?.message || 'Failed to launch MPV with headers' };
        }
    });

    // Direct MPV launch for external URLs (111477, etc.)
    ipcMain.handle('open-mpv-direct', async (event, url) => {
        try {
            console.log('Opening URL in MPV (direct):', url);
            const mpvPath = resolveMpvExe();
            if (!mpvPath) {
                throw new Error('MPV not found');
            }

            // Performance-friendly defaults and UA header for direct HTTP playback (111477, etc.)
            const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
            const args = [
                '--cache=yes',
                '--cache-secs=30',
                '--demuxer-readahead-secs=20',
                '--cache-pause=yes',
                '--force-seekable=yes',
                `--http-header-fields=User-Agent: ${userAgent}`,
                '--vd-lavc-threads=4',
                '--hwdec=d3d11va',
                '--gpu-context=d3d11',
                '--profile=fast',
                '--cache-on-disk=yes',
                url
            ];

            const mpvProcess = spawn(mpvPath, args, { stdio: 'ignore', detached: true });
            
            // Listen for process close to clear Discord presence
            mpvProcess.on('close', async (code) => {
                console.log(`MPV (direct) closed with code ${code}`);
                try {
                    if (discordRpc && discordRpcReady) {
                        await discordRpc.setActivity({
                            details: 'Browsing PlayTorrio',
                            startTimestamp: new Date(),
                            largeImageKey: 'icon',
                            largeImageText: 'PlayTorrio App',
                            buttons: [
                                { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                            ]
                        });
                    }
                } catch (err) {
                    console.error('[Discord RPC] Failed to clear on MPV direct close:', err);
                }
            });
            
            mpvProcess.unref();
            return { success: true };
        } catch (error) {
            console.error('Error opening MPV:', error);
            return { success: false, error: error.message };
        }
    });

    // IPC handler to open VLC from renderer
    ipcMain.handle('open-in-vlc', (event, data) => {
        const { streamUrl, infoHash, startSeconds } = data || {};
        console.log(`Received VLC open request for hash: ${infoHash}`);
        return openInVLC(mainWindow, streamUrl, infoHash, startSeconds);
    });

    // Direct VLC launch for external URLs
    ipcMain.handle('open-vlc-direct', async (event, url) => {
        try {
            console.log('Opening URL in VLC:', url);
            const vlcPath = resolveVlcExe();
            if (!vlcPath) {
                throw new Error('VLC not found');
            }
            const vlcProcess = spawn(vlcPath, [url], { stdio: 'ignore', detached: true });

            vlcProcess.on('close', async (code) => {
                console.log(`VLC (direct) closed with code ${code}`);
                try {
                    if (discordRpc && discordRpcReady) {
                        await discordRpc.setActivity({
                            details: 'Browsing PlayTorrio',
                            startTimestamp: new Date(),
                            largeImageKey: 'icon',
                            largeImageText: 'PlayTorrio App',
                            buttons: [
                                { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                            ]
                        });
                    }
                } catch (err) {
                    console.error('[Discord RPC] Failed to clear on VLC direct close:', err);
                }
            });

            vlcProcess.unref();
            return { success: true };
        } catch (error) {
            console.error('Error opening VLC:', error);
            return { success: false, error: error.message };
        }
    });

    // Helper function to get local network IP
    function getLocalNetworkIP(targetDeviceIP = null) {
        const interfaces = os.networkInterfaces();
        
        // If we have a target device IP, try to find an interface on the same subnet
        if (targetDeviceIP) {
            const targetParts = targetDeviceIP.split('.');
            const targetSubnet = `${targetParts[0]}.${targetParts[1]}.${targetParts[2]}`;
            
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        const ifaceParts = iface.address.split('.');
                        const ifaceSubnet = `${ifaceParts[0]}.${ifaceParts[1]}.${ifaceParts[2]}`;
                        
                        // Found interface on same subnet as target device
                        if (ifaceSubnet === targetSubnet) {
                            console.log(`[Network] Found matching subnet interface: ${iface.address} for target ${targetDeviceIP}`);
                            return iface.address;
                        }
                    }
                }
            }
        }
        
        // Fallback: return first non-internal IPv4 address, skip virtual adapters
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                // Skip internal, virtual adapters, and APIPA addresses
                if (iface.family === 'IPv4' && !iface.internal && 
                    !name.toLowerCase().includes('virtualbox') &&
                    !name.toLowerCase().includes('vmware') &&
                    !iface.address.startsWith('169.254') &&
                    !iface.address.startsWith('192.168.56')) { // Common VirtualBox subnet
                    return iface.address;
                }
            }
        }
        return 'localhost'; // fallback
    }

    // Helper function to replace localhost with network IP
    function replaceLocalhostWithNetworkIP(url, targetDeviceIP = null) {
        const networkIP = getLocalNetworkIP(targetDeviceIP);
        console.log(`[Chromecast] Network IP: ${networkIP}`);
        
        if (url.includes('localhost')) {
            const newUrl = url.replace('localhost', networkIP);
            console.log(`[Chromecast] Replaced localhost URL: ${url} -> ${newUrl}`);
            return newUrl;
        }
        if (url.includes('127.0.0.1')) {
            const newUrl = url.replace('127.0.0.1', networkIP);
            console.log(`[Chromecast] Replaced 127.0.0.1 URL: ${url} -> ${newUrl}`);
            return newUrl;
        }
        return url;
    }

    // IPC handler to cast to Chromecast using bundled castv2-client
    ipcMain.handle('cast-to-chromecast', async (event, data) => {
        const { streamUrl, metadata, deviceHost } = data || {};
        
        if (!streamUrl) {
            return { success: false, message: 'No stream URL provided' };
        }
        
        try {
            console.log('[Chromecast] Starting cast request...');
            console.log('[Chromecast] Original stream URL:', streamUrl);
            
            // Detect if this is HLS
            const isHLS = streamUrl.includes('.m3u8') || streamUrl.includes('mpegurl') || 
                         streamUrl.includes('/playlist/');
            
            // Update metadata contentType if HLS
            if (isHLS && metadata) {
                metadata.contentType = 'application/x-mpegURL';
                console.log('[Chromecast] Detected HLS stream, set contentType to application/x-mpegURL');
            }
            
            // Wrap URL through local proxy if it's not already proxied
            let urlToProxy = streamUrl;
            const alreadyProxied = /\/stream\/debrid\?url=/.test(urlToProxy);
            if (!alreadyProxied) {
                // Wrap through proxy so PC handles fetching/caching
                urlToProxy = `http://localhost:3000/stream/debrid?url=${encodeURIComponent(streamUrl)}`;
            }
            
            // Replace localhost with network IP on same subnet as device
            const networkStreamUrl = replaceLocalhostWithNetworkIP(urlToProxy, deviceHost);
            
            console.log('[Chromecast] Final URL for Chromecast:', networkStreamUrl);
            
            let result;
            if (deviceHost) {
                // Cast to specific device
                console.log(`[Chromecast] Casting to specific device: ${deviceHost}`);
                const { castMedia } = await import('./chromecast.mjs');
                result = await castMedia(deviceHost, networkStreamUrl, metadata);
            } else {
                // Cast to first available device
                const { castToFirstDevice } = await import('./chromecast.mjs');
                result = await castToFirstDevice(networkStreamUrl, metadata);
            }
            
            return { 
                success: true, 
                message: result.message || 'Casting to Chromecast...' 
            };
        } catch (error) {
            console.error('[Chromecast] Casting error:', error);
            
            return { 
                success: false, 
                message: error.message || 'Failed to cast to Chromecast' 
            };
        }
    });

    // IPC handler to discover Chromecast devices
    ipcMain.handle('discover-chromecast-devices', async () => {
        try {
            console.log('[Chromecast] Discovering devices...');
            const { discoverDevices } = await import('./chromecast.mjs');
            const devices = await discoverDevices(3000);
            
            return {
                success: true,
                devices: devices
            };
        } catch (error) {
            console.error('[Chromecast] Discovery error:', error);
            return {
                success: false,
                devices: [],
                message: error.message
            };
        }
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
            
            // Also clear API cache
            if (global.clearApiCache) {
                try {
                    global.clearApiCache();
                    results.push({ success: true, message: 'API cache cleared' });
                } catch (error) {
                    results.push({ success: false, message: 'Failed to clear API cache: ' + error.message });
                }
            }
            
            const success = results.every(r => r.success);
            const message = success
                ? 'Cache cleared: webtorrent, downloaded subtitles, and API cache.'
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

    // IPC: show folder in file explorer
    ipcMain.handle('show-folder-in-explorer', async (event, inputPath) => {
        try {
            // Accept either a file path or a directory path
            let directory = inputPath;
            if (fs.existsSync(inputPath)) {
                const stat = fs.statSync(inputPath);
                if (stat.isFile()) {
                    directory = path.dirname(inputPath);
                }
            }
            console.log('[Show Folder] Opening directory:', directory);
            await shell.openPath(directory);
            return { success: true };
        } catch (err) {
            console.error('[Show Folder] Error:', err);
            return { success: false, message: err?.message || 'Failed to open folder' };
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

    // Discord Rich Presence handlers
    ipcMain.handle('update-discord-presence', async (event, presenceData) => {
        try {
            if (!discordRpc || !discordRpcReady) {
                return { success: false, message: 'Discord RPC not ready' };
            }
            
            const activity = {
                details: presenceData.details || 'Using PlayTorrio',
                state: presenceData.state || '',
                startTimestamp: presenceData.startTimestamp || new Date(),
                largeImageKey: presenceData.largeImageKey || 'icon',
                largeImageText: presenceData.largeImageText || 'PlayTorrio App'
            };

            // Add small image if provided (for music/video icons)
            if (presenceData.smallImageKey) {
                activity.smallImageKey = presenceData.smallImageKey;
                activity.smallImageText = presenceData.smallImageText || '';
            }

            // Add buttons if provided
            if (presenceData.buttons && Array.isArray(presenceData.buttons)) {
                activity.buttons = presenceData.buttons;
            } else {
                activity.buttons = [
                    { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                ];
            }

            await discordRpc.setActivity(activity);
            return { success: true };
        } catch (error) {
            console.error('[Discord RPC] Update error:', error);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('clear-discord-presence', async () => {
        try {
            if (!discordRpc || !discordRpcReady) {
                return { success: false, message: 'Discord RPC not ready' };
            }
            
            // Reset to base activity - just "Browsing PlayTorrio"
            await discordRpc.setActivity({
                details: 'Browsing PlayTorrio',
                startTimestamp: new Date(),
                largeImageKey: 'icon',
                largeImageText: 'PlayTorrio App',
                buttons: [
                    { label: 'Download App', url: 'https://github.com/ayman707-ux/PlayTorrio' }
                ]
            });
            return { success: true };
        } catch (error) {
            console.error('[Discord RPC] Clear error:', error);
            return { success: false, message: error.message };
        }
    });

    // EPUB Library functionality
    ipcMain.handle('get-epub-folder', async () => {
        try {
            const epubFolder = path.join(app.getPath('userData'), 'epub');
            // Create folder if it doesn't exist
            if (!fs.existsSync(epubFolder)) {
                fs.mkdirSync(epubFolder, { recursive: true });
            }
            return { success: true, path: epubFolder };
        } catch (error) {
            console.error('Error getting EPUB folder:', error);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('download-epub', async (event, { url, bookData }) => {
        try {
            const epubFolder = path.join(app.getPath('userData'), 'epub');
            // Create folder if it doesn't exist
            if (!fs.existsSync(epubFolder)) {
                fs.mkdirSync(epubFolder, { recursive: true });
            }

            // Clean filename for the book
            const safeBook = bookData || {};
            const titleRaw = typeof safeBook.title === 'string' ? safeBook.title : (safeBook.name || 'Unknown Title');
            const cleanTitle = titleRaw.replace(/[<>:"/\\|?*]/g, '').trim() || 'Unknown Title';
            const authorRaw = Array.isArray(safeBook.author)
                ? (safeBook.author[0] || 'Unknown Author')
                : (typeof safeBook.author === 'string' ? safeBook.author : 'Unknown Author');
            const cleanAuthor = String(authorRaw).replace(/[<>:"/\\|?*]/g, '').trim() || 'Unknown Author';
            const filename = `${cleanTitle} - ${cleanAuthor}.epub`;
            const filePath = path.join(epubFolder, filename);

            // Persist cover URL and basic metadata so Library can show covers
            try {
                const metadataPath = path.join(epubFolder, 'covers.json');
                let covers = {};
                if (fs.existsSync(metadataPath)) {
                    try {
                        covers = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) || {};
                    } catch (_) {
                        covers = {};
                    }
                }
                // Helper to normalize title/author for indexing
                const normalize = (s) => String(s || '')
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                const indexKey = `${normalize(cleanTitle)}|${normalize(cleanAuthor)}`;

                covers[filename] = {
                    title: cleanTitle,
                    author: cleanAuthor,
                    coverUrl: typeof safeBook.coverUrl === 'string' ? safeBook.coverUrl : null,
                    sourceUrl: url || null,
                    savedAt: new Date().toISOString()
                };
                // Maintain a reverse index for fuzzy lookup by title+author
                covers._index = covers._index || {};
                covers._index[indexKey] = covers._index[indexKey] || [];
                if (!covers._index[indexKey].includes(filename)) {
                    covers._index[indexKey].push(filename);
                }
                fs.writeFileSync(metadataPath, JSON.stringify(covers, null, 2), 'utf8');
            } catch (metaErr) {
                console.warn('Could not persist EPUB cover metadata:', metaErr);
            }

            return { 
                success: true, 
                path: filePath,
                folder: epubFolder,
                filename,
                url: url,
                bookData: safeBook
            };
        } catch (error) {
            console.error('Error preparing EPUB download:', error);
            return { success: false, message: error.message };
        }
    });

    ipcMain.handle('get-epub-library', async () => {
        try {
            const epubFolder = path.join(app.getPath('userData'), 'epub');
            
            if (!fs.existsSync(epubFolder)) {
                return { success: true, books: [] };
            }

            // Scan for .epub files
            const files = fs.readdirSync(epubFolder);
            const epubFiles = files.filter(file => file.toLowerCase().endsWith('.epub'));
            
            // Load cover metadata if present
            let covers = {};
            const metadataPath = path.join(epubFolder, 'covers.json');
            if (fs.existsSync(metadataPath)) {
                try {
                    covers = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) || {};
                } catch (_) {
                    covers = {};
                }
            }
            
            const books = epubFiles.map(filename => {
                const filePath = path.join(epubFolder, filename);
                const stats = fs.statSync(filePath);
                
                // Try to extract title and author from filename
                const nameWithoutExt = filename.replace(/\.epub$/i, '');
                let title = nameWithoutExt;
                let author = 'Unknown Author';
                
                // Check if filename has " - " pattern for author
                const parts = nameWithoutExt.split(' - ');
                if (parts.length >= 2) {
                    title = parts[0].trim();
                    author = parts.slice(1).join(' - ').trim();
                }

                // Merge in any saved cover from metadata (filename match first)
                let meta = covers[filename] || {};
                let coverUrl = typeof meta.coverUrl === 'string' ? meta.coverUrl : null;
                
                // If no cover via filename, try fuzzy match via normalized title|author
                if (!coverUrl && covers._index) {
                    const normalize = (s) => String(s || '')
                        .toLowerCase()
                        .replace(/[^a-z0-9\s]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const idxKey = `${normalize(title)}|${normalize(author)}`;
                    const possibleFiles = covers._index[idxKey];
                    if (Array.isArray(possibleFiles) && possibleFiles.length > 0) {
                        const first = possibleFiles[0];
                        const metaAlt = covers[first] || {};
                        if (typeof metaAlt.coverUrl === 'string' && metaAlt.coverUrl) {
                            coverUrl = metaAlt.coverUrl;
                            // Also adopt stored title/author if present
                            if (typeof metaAlt.title === 'string' && metaAlt.title.trim()) title = metaAlt.title;
                            if (typeof metaAlt.author === 'string' && metaAlt.author.trim()) author = metaAlt.author;
                        }
                    }
                }
                // Prefer saved title/author if present
                title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : title;
                author = typeof meta.author === 'string' && meta.author.trim() ? meta.author : author;
                
                return {
                    id: filename,
                    title: title,
                    author: [author],
                    filename: filename,
                    localPath: filePath,
                    fileSize: stats.size,
                    downloadedAt: stats.mtime.toISOString(),
                    fileExtension: 'epub',
                    // Cover URL from metadata or placeholder
                    coverUrl: coverUrl || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMDZiNmQ0Ii8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxNHB4IiBmaWxsPSJ3aGl0ZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkVQVUI8L3RleHQ+PC9zdmc+'
                };
            });

            return { success: true, books: books };
        } catch (error) {
            console.error('Error getting EPUB library:', error);
            return { success: false, message: error.message, books: [] };
        }
    });

    // Read an EPUB file and return base64 so renderer can load it with epub.js
    ipcMain.handle('read-epub-file', async (event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, message: 'File not found' };
            }
            const data = fs.readFileSync(filePath);
            const base64 = data.toString('base64');
            return { success: true, base64, mime: 'application/epub+zip' };
        } catch (err) {
            console.error('Error reading EPUB file:', err);
            return { success: false, message: err.message };
        }
    });

    // ----------------------
    // Music Offline Download
    // ----------------------
    const HIFI_BASE = 'https://hifi.401658.xyz';
    const offlineDir = path.join(app.getPath('userData'), 'music_offline');
    const coversDir = path.join(offlineDir, 'covers');
    const offlineIndexPath = path.join(offlineDir, 'offline_music.json');
    function ensureDirSync(dir) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch(_) {}
    }
    function readOfflineIndex() {
        try {
            if (fs.existsSync(offlineIndexPath)) {
                return JSON.parse(fs.readFileSync(offlineIndexPath, 'utf8'));
            }
        } catch(_) {}
        return [];
    }
    function writeOfflineIndex(arr) {
        try { ensureDirSync(offlineDir); fs.writeFileSync(offlineIndexPath, JSON.stringify(arr, null, 2)); } catch(_) {}
    }
    function sanitizeFilename(name) {
        return (name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }
    async function downloadToFile(url, destPath) {
        await streamPipeline(got.stream(url), fs.createWriteStream(destPath));
        return destPath;
    }

    ipcMain.handle('music-download-track', async (event, track) => {
        try {
            if (!track || !track.id) return { success: false, message: 'Invalid track' };
            ensureDirSync(offlineDir); ensureDirSync(coversDir);
            const index = readOfflineIndex();
            // If already exists, return it
            const existing = index.find(e => e.id == track.id);
            if (existing && fs.existsSync(existing.filePath)) {
                return { success: true, entry: existing, already: true };
            }
            // Fetch OriginalTrackUrl
            const resp = await got(`${HIFI_BASE}/track/?id=${encodeURIComponent(track.id)}&quality=LOSSLESS`, { timeout: 20000 }).json();
            let audioUrl = null;
            if (Array.isArray(resp)) {
                for (const it of resp) {
                    const cand = it?.OriginalTrackUrl || it?.originalTrackUrl;
                    if (cand && !String(cand).includes('tidal.com/browse')) { audioUrl = cand; break; }
                }
            }
            if (!audioUrl) return { success: false, message: 'Audio URL not found' };
            const lower = audioUrl.toLowerCase();
            let ext = 'mp3';
            if (lower.includes('.flac')) ext = 'flac';
            else if (lower.includes('.m4a')) ext = 'm4a';
            else if (lower.includes('.mp4')) ext = 'mp4';
            else if (lower.includes('.aac')) ext = 'aac';
            else if (lower.includes('.ogg')) ext = 'ogg';
            const baseName = sanitizeFilename(`${track.artist || 'Artist'} - ${track.title || 'Track'}`);
            const audioPath = path.join(offlineDir, `${baseName}.${ext}`);
            await downloadToFile(audioUrl, audioPath);
            // Download cover offline if available and http(s)
            let coverPath = '';
            try {
                if (track.cover && /^https?:\/\//i.test(track.cover)) {
                    const coverExt = track.cover.toLowerCase().includes('.png') ? 'png' : 'jpg';
                    const coverName = sanitizeFilename(`${track.id}.${coverExt}`);
                    const coverDest = path.join(coversDir, coverName);
                    await downloadToFile(track.cover, coverDest);
                    coverPath = coverDest;
                }
            } catch(_) {}

            const entry = {
                id: track.id,
                title: track.title || 'Unknown Title',
                artist: track.artist || 'Unknown Artist',
                cover: coverPath || track.cover || '',
                filePath: audioPath,
                ext,
                addedAt: new Date().toISOString()
            };
            const updated = existing ? index.map(e => e.id == entry.id ? entry : e) : [...index, entry];
            writeOfflineIndex(updated);
            return { success: true, entry };
        } catch (e) {
            console.error('[Music Offline] download failed:', e);
            return { success: false, message: e?.message || 'Download failed' };
        }
    });

    ipcMain.handle('music-offline-library', async () => {
        try {
            const index = readOfflineIndex();
            // Filter out missing files
            const valid = index.filter(e => {
                try { return e.filePath && fs.existsSync(e.filePath); } catch(_) { return false; }
            });
            if (valid.length !== index.length) writeOfflineIndex(valid);
            return { success: true, items: valid };
        } catch (e) {
            return { success: false, items: [], message: e?.message || 'Failed to read offline library' };
        }
    });

    ipcMain.handle('music-offline-delete', async (event, entryId) => {
        try {
            if (!entryId) return { success: false, message: 'Missing id' };
            const index = readOfflineIndex();
            const entry = index.find(e => e.id == entryId);
            if (entry) {
                try { if (entry.filePath && fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath); } catch(_) {}
                // Remove cover only if inside coversDir
                try {
                    if (entry.cover && entry.cover.startsWith(coversDir) && fs.existsSync(entry.cover)) fs.unlinkSync(entry.cover);
                } catch(_) {}
            }
            const updated = index.filter(e => e.id != entryId);
            writeOfflineIndex(updated);
            return { success: true };
        } catch (e) {
            return { success: false, message: e?.message || 'Failed to delete offline item' };
        }
    });

        // Initialize the auto-updater (main-process only, no renderer changes)
        setupAutoUpdater();
    });
}

// Graceful shutdown
app.on('will-quit', () => {
    app.isQuitting = true;
    
    // Clear API cache on exit
    console.log('Clearing API cache on exit...');
    if (global.clearApiCache) {
        try {
            global.clearApiCache();
        } catch (error) {
            console.error('Error clearing cache:', error);
        }
    }
    
    // Clean up Discord RPC
    try {
        if (discordRpc) {
            try { discordRpc.clearActivity().catch(() => {}); } catch(_) {}
            try { discordRpc.destroy(); } catch(_) {}
            discordRpc = null;
        }
    } catch(_) {}
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
    // ============================================================================
    // NOTE: Microservice processes no longer used - all handled by server.mjs
    // ============================================================================
    // if (torrentlessProc) {
    //     try { torrentlessProc.kill('SIGTERM'); } catch(_) {}
    //     torrentlessProc = null;
    // }
    // if (svc111477Proc) {
    //     try { svc111477Proc.kill('SIGTERM'); } catch(_) {}
    //     svc111477Proc = null;
    // }
    // if (booksProc) {
    //     try { booksProc.kill('SIGTERM'); } catch(_) {}
    //     booksProc = null;
    // }
    // if (randomBookProc) {
    //     try { randomBookProc.kill('SIGTERM'); } catch(_) {}
    //     randomBookProc = null;
    // }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
