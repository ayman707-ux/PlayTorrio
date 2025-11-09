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
      
      // Don't try to fix chrome-sandbox - we're running with --no-sandbox anyway
      console.log('[afterPack] ✓ Linux build prepared (sandboxing disabled in app)');
    }
  } catch (error) {
    console.error('[afterPack] Error:', error.message);
    // Don't fail the build
  }
};
