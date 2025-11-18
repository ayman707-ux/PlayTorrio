const fs = require('fs');
const path = require('path');

const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const sourceFile = path.join(__dirname, '..', 'build', 'Release', 'mpvjs.node');
const destDir = path.join(__dirname, '..', 'mpv', platform);
const destFile = path.join(destDir, 'mpvjs.node');

if (!fs.existsSync(sourceFile)) {
  console.error('Error: mpvjs.node not found in build/Release/');
  process.exit(1);
}

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

fs.copyFileSync(sourceFile, destFile);
console.log(`Copied mpvjs.node to mpv/${platform}/`);
