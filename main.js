import { app, BrowserWindow, ipcMain, shell, clipboard } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import os from 'os';
import { startServer } from './server.mjs'; // Import the server

let httpServer;
let webtorrentClient;

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

// Launch MPV and set up cleanup listeners
function openInMPV(win, streamUrl, infoHash) {
    try {
        console.log('Attempting to launch MPV with URL:', streamUrl);
        const mpvProcess = spawn('mpv', [streamUrl], { stdio: 'ignore' });

        mpvProcess.on('close', async (code) => {
            console.log(`MPV player closed with code ${code}. Initiating cleanup for ${infoHash}.`);
            
            // 1. Tell server to stop the stream
            const stopStreamUrl = `http://localhost:3000/api/stop-stream?hash=${infoHash}`;
            http.get(stopStreamUrl, (res) => {
                console.log(`Stop stream request finished with status: ${res.statusCode}`);
            }).on('error', (err) => {
                console.error('Error sending stop-stream request:', err.message);
            });

            // Notify the frontend that cleanup is done (optional)
            win.webContents.send('cleanup-done');
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

    if (app.isPackaged) {
        // In production, load the local HTML file
        win.loadFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        // In development, load from the server after a delay
        // The server needs a moment to start
        setTimeout(() => win.loadURL('http://localhost:3000'), 2000);
    }
    return win;
}

app.whenReady().then(() => {
    // Start the integrated server
    const { server, client } = startServer(app.getPath('userData'));
    httpServer = server;
    webtorrentClient = client;

    const win = createWindow();

    // IPC handler to open MPV from renderer
    ipcMain.handle('open-in-mpv', (event, data) => {
        const { streamUrl, infoHash } = data;
        console.log(`Received MPV open request for hash: ${infoHash}`);
        return openInMPV(win, streamUrl, infoHash);
    });

    // IPC handler for manual temp folder clearing (e.g., from Close Player button)
    ipcMain.handle('clear-webtorrent-temp', async () => {
        return await clearWebtorrentTemp();
    });

    // IPC handler for the new Clear Cache button
    ipcMain.handle('clear-cache', async () => {
        return await clearWebtorrentTemp();
    });

    // Helper: check if MPV is installed (global PATH or user-installed folder)
    function checkMPVInstalled() {
        return new Promise((resolve) => {
            try {
                const proc = spawn('mpv', ['--version']);
                let detected = false;
                proc.stdout?.on('data', () => { detected = true; });
                proc.on('close', (code) => {
                    if (detected || code === 0) {
                        resolve({ installed: true, via: 'path' });
                    } else {
                        // Fallback: try user-local install path
                        const base = path.join(os.homedir(), 'mpv');
                        try {
                            const entries = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory());
                            if (entries.length > 0) {
                                const mpvDir = path.join(base, entries[0].name);
                                const exePath = path.join(mpvDir, 'mpv.exe');
                                if (fs.existsSync(exePath)) {
                                    const proc2 = spawn(exePath, ['--version']);
                                    proc2.on('close', (code2) => {
                                        resolve({ installed: code2 === 0, via: 'userdir', exePath });
                                    });
                                    proc2.on('error', () => resolve({ installed: false }));
                                    return;
                                }
                            }
                        } catch (e) {}
                        resolve({ installed: false });
                    }
                });
                proc.on('error', () => {
                    // Try user dir immediately
                    const base = path.join(os.homedir(), 'mpv');
                    try {
                        const entries = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory());
                        if (entries.length > 0) {
                            const mpvDir = path.join(base, entries[0].name);
                            const exePath = path.join(mpvDir, 'mpv.exe');
                            if (fs.existsSync(exePath)) {
                                const proc2 = spawn(exePath, ['--version']);
                                proc2.on('close', (code2) => {
                                    resolve({ installed: code2 === 0, via: 'userdir', exePath });
                                });
                                proc2.on('error', () => resolve({ installed: false }));
                                return;
                            }
                        }
                    } catch (e) {}
                    resolve({ installed: false });
                });
            } catch (e) {
                resolve({ installed: false });
            }
        });
    }

    // Helper: install MPV via PowerShell script
    function installMPV() {
        return new Promise((resolve) => {
            const psScript = [
                '$mpvDir="$env:USERPROFILE\\mpv"',
                'New-Item -ItemType Directory -Force -Path $mpvDir | Out-Null',
                'Invoke-WebRequest -Uri "https://github.com/mpv-player/mpv/releases/latest/download/mpv-x86_64-windows.zip" -OutFile "$mpvDir\\mpv.zip"',
                'Expand-Archive "$mpvDir\\mpv.zip" -DestinationPath $mpvDir -Force',
                '$mpvExe = Get-ChildItem $mpvDir -Directory | Select-Object -First 1',
                '[Environment]::SetEnvironmentVariable("Path", $env:Path + ";$($mpvExe.FullName)", "User")'
            ].join('; ');

            const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { windowsHide: true });
            let stderr = '';
            child.stderr?.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ success: true });
                } else {
                    resolve({ success: false, error: stderr || `Exit code ${code}` });
                }
            });
            child.on('error', (err) => resolve({ success: false, error: err.message }));
        });
    }

    // IPC handler: Launch elevated CMD (admin) for manual MPV install flow
    ipcMain.handle('install-mpv', async () => {
        return await new Promise((resolve) => {
            try {
                // Launch an elevated CMD window maximized
                const child = spawn('powershell.exe', [
                    '-NoProfile',
                    '-ExecutionPolicy', 'Bypass',
                    '-Command',
                    'Start-Process cmd -Verb runAs -WindowStyle Maximized'
                ], { windowsHide: false, detached: true });
                child.on('error', (err) => {
                    resolve({ status: 'error', message: err?.message || 'Failed to open elevated PowerShell' });
                });
                // We resolve immediately; the UAC prompt/admin shell is independent of our process
                setTimeout(() => resolve({ status: 'launched' }), 200);
            } catch (e) {
                resolve({ status: 'error', message: e?.message || 'Failed to open elevated PowerShell' });
            }
        });
    });

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
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
