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
      
      
      console.log('[afterPack] ✓ Linux build prepared');
    } else if (context.electronPlatformName === 'win32') {
      // Ensure mpv.js-master-updated has its own Electron 1.8.8 runtime bundled so it can launch independently
      try {
        const resourcesDir = path.join(context.appOutDir, 'resources');
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
