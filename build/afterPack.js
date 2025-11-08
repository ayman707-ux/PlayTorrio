// afterPack.js - fix Linux AppImage chrome-sandbox permissions when possible
// Also a good place for any other platform post-pack tweaks

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

exports.default = async function afterPack(context) {
  try {
    if (process.platform !== 'linux') return;
    const appOutDir = context.appOutDir; // e.g., dist/linux-unpacked
    const chromeSandbox = path.join(appOutDir, 'chrome-sandbox');
    if (fs.existsSync(chromeSandbox)) {
      try {
        console.log('[afterPack] Found chrome-sandbox, attempting to set 4755 permissions');
        // Best effort chmod; setuid only works properly if owned by root
        fs.chmodSync(chromeSandbox, 0o4755);
        // Try to chown root:root if possible on CI (may fail without sudo)
        const res = spawnSync('sudo', ['chown', 'root:root', chromeSandbox], { stdio: 'inherit' });
        if (res.status !== 0) {
          console.warn('[afterPack] Could not chown root:root (continuing).');
        } else {
          console.log('[afterPack] Successfully chowned chrome-sandbox to root:root');
        }
      } catch (e) {
        console.warn('[afterPack] Failed to adjust chrome-sandbox permissions:', e.message);
      }
    } else {
      console.log('[afterPack] chrome-sandbox not found in', appOutDir);
    }
  } catch (e) {
    console.warn('[afterPack] Error:', e.message);
  }
};
