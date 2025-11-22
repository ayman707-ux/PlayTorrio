const fs = require('fs');
const path = require('path');
const os = require('os');

// Copy Chromium from cache to project directory for bundling
function copyChromiumToProject() {
    const platform = process.platform;
    let cacheDir;
    
    if (platform === 'win32') {
        // Try both possible locations on Windows
        const cacheDirs = [
            path.join(os.homedir(), '.cache', 'puppeteer'),
            path.join(os.homedir(), 'AppData', 'Local', '.cache', 'puppeteer')
        ];
        for (const dir of cacheDirs) {
            if (fs.existsSync(dir)) {
                cacheDir = dir;
                break;
            }
        }
        if (!cacheDir) {
            cacheDir = cacheDirs[0]; // Default to first option
        }
    } else if (platform === 'darwin') {
        cacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
    } else {
        cacheDir = path.join(os.homedir(), '.cache', 'puppeteer');
    }
    
    const chromeDest = path.join(__dirname, '..', 'chromium-bundle');
    
    console.log(`[Chromium] Looking for cache in: ${cacheDir}`);
    
    if (!fs.existsSync(cacheDir)) {
        console.log('[Chromium] Cache not found, skipping bundle');
        return;
    }
    
    // Find chrome folder
    const chromeDir = path.join(cacheDir, 'chrome');
    
    if (!fs.existsSync(chromeDir)) {
        console.log('[Chromium] Chrome folder not found, skipping bundle');
        return;
    }
    
    // Copy chrome to project
    console.log(`[Chromium] Copying Chrome to: ${chromeDest}`);
    
    if (fs.existsSync(chromeDest)) {
        fs.rmSync(chromeDest, { recursive: true, force: true });
    }
    
    copyRecursiveSync(chromeDir, chromeDest);
    console.log('[Chromium] Chromium bundled successfully!');
}

function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    
    if (isDirectory) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        fs.readdirSync(src).forEach(childItemName => {
            copyRecursiveSync(
                path.join(src, childItemName),
                path.join(dest, childItemName)
            );
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

copyChromiumToProject();
