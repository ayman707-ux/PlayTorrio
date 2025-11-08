// afterSign.cjs - CommonJS version (electron-builder requires require())
// Sign nested mpv.app (optional when signing disabled)

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async function afterSign(context) {
  try {
    if (process.platform !== 'darwin') return;

    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename; // PlayTorrio
    const appPath = path.join(appOutDir, `${appName}.app`);
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');

    const candidates = [
      path.join(resourcesPath, 'mpv', 'mpv.app'),
      path.join(resourcesPath, 'mpv', 'IINA.app'),
    ];

    const identity = process.env.CSC_NAME || 'Developer ID Application';

    function codesign(target) {
      if (!fs.existsSync(target)) return;
      console.log(`[afterSign] codesigning ${target}`);
      const args = ['--force', '--deep', '--options', 'runtime', '--sign', identity, target];
      const res = spawnSync('codesign', args, { stdio: 'inherit' });
      if (res.status !== 0) {
        console.warn(`[afterSign] Warning: codesign failed for ${target} (continuing)`);
      }
    }

    for (const appBundle of candidates) {
      try { if (fs.existsSync(appBundle)) codesign(appBundle); } catch (_) {}
    }

  } catch (e) {
    console.warn('[afterSign] Error during nested signing:', e?.message || e);
  }
};
