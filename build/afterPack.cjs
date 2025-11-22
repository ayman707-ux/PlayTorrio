// afterPack.cjs - Set executable permissions for Linux builds
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async function afterPack(context) {
  console.log('[afterPack] Running for platform:', context.electronPlatformName);
  
  try {
    if (context.electronPlatformName === 'linux') {
      const appOutDir = context.appOutDir;
      const executableName = context.packager.executableName || 'playtorrio';
      const executablePath = path.join(appOutDir, executableName);
      
      // Set executable permission on main binary
      if (fs.existsSync(executablePath)) {
        fs.chmodSync(executablePath, 0o755);
        console.log('[afterPack] ✓ Set executable permission on:', executablePath);
      } else {
        console.warn('[afterPack] ⚠ Executable not found:', executablePath);
      }
      
      // Handle chrome-sandbox: either set proper permissions or remove it
      const sandboxPath = path.join(appOutDir, 'chrome-sandbox');
      if (fs.existsSync(sandboxPath)) {
        try {
          fs.chmodSync(sandboxPath, 0o4755);
          console.log('[afterPack] ✓ Set chrome-sandbox permissions (4755)');
        } catch (err) {
          // If we can't set proper permissions, remove it since we're using --no-sandbox anyway
          fs.rmSync(sandboxPath, { force: true });
          console.log('[afterPack] ✓ Removed chrome-sandbox (sandboxing disabled in app)');
        }
      }
      
      // Verify Chromium bundle for Linux
      const chromiumBundleDir = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'chromium-bundle');
      
      console.log('[afterPack][Chromium] Checking for bundled Chromium...');
      console.log('[afterPack][Chromium] Looking in:', chromiumBundleDir);
      
      if (fs.existsSync(chromiumBundleDir)) {
        const chromiumDirs = fs.readdirSync(chromiumBundleDir);
        console.log('[afterPack][Chromium] ✓ Chromium bundle found with versions:', chromiumDirs);
        
        // Find chrome executable
        for (const versionDir of chromiumDirs) {
          const chromeExePath = path.join(chromiumBundleDir, versionDir, 'chrome-linux64', 'chrome');
          if (fs.existsSync(chromeExePath)) {
            console.log('[afterPack][Chromium] ✓✓ chrome executable found at:', chromeExePath);
            // Set executable permission
            fs.chmodSync(chromeExePath, 0o755);
            console.log('[afterPack][Chromium] ✓✓ Set executable permission on chrome');
          }
        }
      } else {
        console.warn('[afterPack][Chromium] ⚠⚠ WARNING: Chromium bundle NOT FOUND! Comics will not work!');
      }
      
      
      console.log('[afterPack] ✓ Linux build prepared');
    } else if (context.electronPlatformName === 'darwin') {
      // Verify Chromium bundle for macOS
      const resourcesDir = path.join(context.appOutDir, '..', 'Resources');
      const chromiumBundleDir = path.join(resourcesDir, 'chromium-bundle');
      
      console.log('[afterPack][Chromium] Checking for bundled Chromium on macOS...');
      console.log('[afterPack][Chromium] Looking in:', chromiumBundleDir);
      
      if (fs.existsSync(chromiumBundleDir)) {
        const chromiumDirs = fs.readdirSync(chromiumBundleDir);
        console.log('[afterPack][Chromium] ✓ Chromium bundle found with versions:', chromiumDirs);
        
        // Find chrome executable (different names for arm64 vs x64)
        for (const versionDir of chromiumDirs) {
          const possiblePaths = [
            path.join(chromiumBundleDir, versionDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
            path.join(chromiumBundleDir, versionDir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
          ];
          
          for (const chromePath of possiblePaths) {
            if (fs.existsSync(chromePath)) {
              console.log('[afterPack][Chromium] ✓✓ Chrome executable found at:', chromePath);
              // Set executable permission
              fs.chmodSync(chromePath, 0o755);
              console.log('[afterPack][Chromium] ✓✓ Set executable permission on Chrome');
              break;
            }
          }
        }
      } else {
        console.warn('[afterPack][Chromium] ⚠⚠ WARNING: Chromium bundle NOT FOUND! Comics will not work!');
      }
      
      console.log('[afterPack] ✓ macOS build prepared');
    } else if (context.electronPlatformName === 'win32') {
      // Verify Chromium bundle
      const resourcesDir = path.join(context.appOutDir, 'resources');
      const chromiumBundleDir = path.join(resourcesDir, 'chromium-bundle');
      
      console.log('[afterPack][Chromium] Checking for bundled Chromium...');
      console.log('[afterPack][Chromium] Looking in:', chromiumBundleDir);
      
      if (fs.existsSync(chromiumBundleDir)) {
        const chromiumDirs = fs.readdirSync(chromiumBundleDir);
        console.log('[afterPack][Chromium] ✓ Chromium bundle found with versions:', chromiumDirs);
        
        // Find chrome.exe
        for (const versionDir of chromiumDirs) {
          const chromeExePath = path.join(chromiumBundleDir, versionDir, 'chrome-win64', 'chrome.exe');
          if (fs.existsSync(chromeExePath)) {
            console.log('[afterPack][Chromium] ✓✓ chrome.exe found at:', chromeExePath);
          }
        }
      } else {
        console.warn('[afterPack][Chromium] ⚠⚠ WARNING: Chromium bundle NOT FOUND! Comics will not work!');
      }
      
      // Ensure mpv.js-master-updated has its own Electron 1.8.8 runtime bundled so it can launch independently
      try {
        const mpvjsDir = path.join(resourcesDir, 'mpv.js-master-updated');
        const electronDist = path.join(mpvjsDir, 'node_modules', 'electron', 'dist');
        const electronExe = path.join(electronDist, 'electron.exe');

        if (fs.existsSync(mpvjsDir)) {
          if (!fs.existsSync(electronExe)) {
            console.log('[afterPack][win] electron.exe not found for mpv.js-master-updated, installing electron@1.8.8 ...');
            // Run npm install electron@1.8.8 --no-save within the mpv.js-master-updated folder
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const result = spawnSync(npmCmd, ['install', 'electron@1.8.8', '--no-save'], {
              cwd: mpvjsDir,
              stdio: 'inherit',
              shell: false
            });
            if (result.status !== 0) {
              console.warn('[afterPack][win] Failed to install electron@1.8.8 into mpv.js-master-updated');
            } else if (fs.existsSync(electronExe)) {
              console.log('[afterPack][win] ✓ Installed electron@1.8.8 for mpv.js-master-updated');
            }
          } else {
            console.log('[afterPack][win] ✓ electron.exe already present for mpv.js-master-updated');
          }
        } else {
          console.warn('[afterPack][win] ⚠ mpv.js-master-updated folder not found in resources');
        }
      } catch (e) {
        console.warn('[afterPack][win] Skipping mpv.js electron injection:', e.message);
      }
    }
  } catch (error) {
    console.error('[afterPack] Error:', error.message);
    // Don't fail the build
  }
};
