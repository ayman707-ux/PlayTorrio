import { app, BrowserWindow, ipcMain, shell, clipboard, dialog } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { startServer } from './server.mjs'; // Import the server

let httpServer;
let webtorrentClient;
let mainWindow;
let torrentlessProcess; // child process for Torrentless (port 3002)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to clear the webtorrent temp folder
async function clearWebtorrentTemp() {
    const tempPath = path.join(os.tmpdir(), 'webtorrent');
    console.log(`Clearing webtorrent temp folder: ${tempPath}`);
    try {
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
    const subsPath = path.join(os.tmpdir(), 'playtorrio_subs');
    console.log(`Clearing subtitles temp folder: ${subsPath}`);
    try {
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
function openInMPV(win, streamUrl, infoHash) {
    try {
        console.log('Attempting to launch MPV with URL:', streamUrl);
        const mpvPath = resolveMpvExe();
        if (!mpvPath) {
            const msg = 'Bundled MPV not found. Place portable mpv.exe under the app\mpv folder.';
            console.error(msg);
            return { success: false, message: msg };
        }
        const mpvProcess = spawn(mpvPath, [streamUrl], { stdio: 'ignore' });

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
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // Always load the local server so all API and subtitle URLs are same-origin HTTP
    setTimeout(() => win.loadURL('http://localhost:3000'), app.isPackaged ? 500 : 2000);
    return win;
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
    // Start the integrated server
    const { server, client } = startServer(app.getPath('userData'));
    httpServer = server;
    webtorrentClient = client;

    // Start the Torrentless server (scraper service on http://localhost:3002)
    try {
        // Resolve path to Torrentless/server.js in dev and packaged modes
        const candidates = [
            path.join(__dirname, 'Torrentless', 'server.js'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'Torrentless', 'server.js'),
            path.join(process.resourcesPath || '', 'app.asar', 'Torrentless', 'server.js'),
            path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'Torrentless', 'server.js'),
        ].filter(Boolean);
        let torrentlessEntry = null;
        for (const p of candidates) {
            try { if (p && fs.existsSync(p)) { torrentlessEntry = p; break; } } catch {}
        }
        if (torrentlessEntry) {
            // Use Electron binary as Node by setting ELECTRON_RUN_AS_NODE
            const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '3002' };
            torrentlessProcess = spawn(process.execPath, [torrentlessEntry], { env, stdio: 'ignore', windowsHide: true });
            torrentlessProcess.on('error', (e) => console.error('Torrentless failed to start:', e));
            torrentlessProcess.on('exit', (code) => console.log('Torrentless exited with code', code));
            console.log('🔧 Torrentless server starting...');
        } else {
            console.warn('⚠️ Could not locate Torrentless/server.js. Torrentless mode will be unavailable.');
        }
    } catch (err) {
        console.warn('⚠️ Failed to launch Torrentless server:', err?.message || err);
    }

        mainWindow = createWindow();

    // IPC handler to open MPV from renderer
    ipcMain.handle('open-in-mpv', (event, data) => {
        const { streamUrl, infoHash } = data;
        console.log(`Received MPV open request for hash: ${infoHash}`);
            return openInMPV(mainWindow, streamUrl, infoHash);
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

    // Removed MPV installer helpers and IPC

    // IPC handler: Restart app on demand
    ipcMain.handle('restart-app', () => {
        app.relaunch();
        app.exit(0);
    });

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
    });
}

// Graceful shutdown
app.on('will-quit', () => {
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
    // Stop Torrentless server
    try {
        if (torrentlessProcess && !torrentlessProcess.killed) {
            torrentlessProcess.kill();
        }
    } catch {}
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});