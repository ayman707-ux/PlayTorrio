// afterPack.cjs - CommonJS version (electron-builder requires require())
// Fix Linux AppImage permissions and chrome-sandbox

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

module.exports = async function afterPack(context) {
  try {
    // Linux: Set AppImage executable and fix chrome-sandbox
    if (context.electronPlatformName === 'linux') {
      const appOutDir = context.appOutDir;
      
      // Fix chrome-sandbox permissions
      const chromeSandbox = path.join(appOutDir, 'chrome-sandbox');
      if (fs.existsSync(chromeSandbox)) {
        try {
          console.log('[afterPack] Found chrome-sandbox, attempting to set 4755 permissions');
          fs.chmodSync(chromeSandbox, 0o4755);
          const res = spawnSync('sudo', ['chown', 'root:root', chromeSandbox], { stdio: 'inherit' });
          if (res.status !== 0) {
            console.warn('[afterPack] Could not chown root:root (continuing).');
          } else {
            console.log('[afterPack] Successfully chowned chrome-sandbox to root:root');
          }
        } catch (e) {
          console.warn('[afterPack] Failed to adjust chrome-sandbox permissions:', e.message);
        }
      }
      
      // Set executable permissions on the main app binary
      const executablePath = path.join(appOutDir, context.packager.executableName);
      if (fs.existsSync(executablePath)) {
        try {
          fs.chmodSync(executablePath, 0o755);
          console.log('[afterPack] Set executable permission on:', executablePath);
        } catch (e) {
          console.warn('[afterPack] Failed to chmod executable:', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[afterPack] Error:', e.message);
  }
};
