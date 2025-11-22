const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Download and extract Chromium during build
async function downloadAndExtractChromium() {
    const platform = process.platform;
    const version = '142.0.7444.175';
    
    // Determine which Chrome to download based on platform
    let downloadUrl;
    let platformFolder;
    
    if (platform === 'win32') {
        downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
        platformFolder = 'chrome-win64';
    } else if (platform === 'linux') {
        downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip`;
        platformFolder = 'chrome-linux64';
    } else if (platform === 'darwin') {
        // Detect ARM64 vs x64 Mac
        const arch = process.arch;
        if (arch === 'arm64') {
            downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-arm64/chrome-mac-arm64.zip`;
            platformFolder = 'chrome-mac-arm64';
        } else {
            downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/mac-x64/chrome-mac-x64.zip`;
            platformFolder = 'chrome-mac-x64';
        }
    } else {
        console.log('[Chromium] Unsupported platform:', platform);
        return;
    }
    
    const chromeDest = path.join(__dirname, '..', 'chromium-bundle', version);
    const zipPath = path.join(__dirname, '..', 'chromium-temp.zip');
    
    // Check if already exists
    if (fs.existsSync(path.join(chromeDest, platformFolder))) {
        console.log('[Chromium] Chromium already bundled, skipping download');
        return;
    }
    
    console.log(`[Chromium] Downloading Chromium ${version} for ${platform}...`);
    console.log(`[Chromium] URL: ${downloadUrl}`);
    
    // Download the zip file
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        
        const handleResponse = (response) => {
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                process.stdout.write(`\r[Chromium] Downloaded: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(1)} MB)`);
            });
            
            response.pipe(file);
        };
        
        file.on('finish', () => {
            file.close(() => {
                console.log('\n[Chromium] Download complete!');
                resolve();
            });
        });
        
        file.on('error', (err) => {
            fs.unlinkSync(zipPath);
            reject(err);
        });
        
        https.get(downloadUrl, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Follow redirect
                https.get(response.headers.location, handleResponse).on('error', reject);
            } else {
                handleResponse(response);
            }
        }).on('error', (err) => {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            reject(err);
        });
    });
    
    console.log('[Chromium] Extracting Chromium...');
    
    // Create destination directory
    fs.mkdirSync(chromeDest, { recursive: true });
    
    // Extract based on platform
    try {
        if (platform === 'win32') {
            // Use PowerShell on Windows
            execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${chromeDest}' -Force"`, {
                stdio: 'inherit'
            });
        } else {
            // Use unzip on Unix-like systems
            execSync(`unzip -q "${zipPath}" -d "${chromeDest}"`, {
                stdio: 'inherit'
            });
        }
        console.log('[Chromium] ✓ Chromium extracted successfully!');
    } catch (error) {
        console.error('[Chromium] ✗ Failed to extract:', error.message);
        throw error;
    }
    
    // Clean up zip file
    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
        console.log('[Chromium] Cleaned up temporary files');
    }
    
    console.log('[Chromium] ✓✓✓ Chromium bundled successfully!');
    console.log(`[Chromium] Location: ${path.join(chromeDest, platformFolder)}`);
}

// Run the download
downloadAndExtractChromium().catch(err => {
    console.error('[Chromium] Fatal error:', err);
    process.exit(1);
});

