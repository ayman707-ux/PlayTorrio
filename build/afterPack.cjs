// afterPack.cjs - Set executable permissions for Linux builds
const fs = require('fs');
const path = require('path');

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
    }
  } catch (error) {
    console.error('[afterPack] Error:', error.message);
    // Don't fail the build
  }
};
