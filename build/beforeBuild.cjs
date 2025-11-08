// beforeBuild.cjs - Rebuild native modules for the target architecture
const { execSync } = require('child_process');

module.exports = async function beforeBuild(context) {
  const { platform, arch } = context;
  
  console.log(`[beforeBuild] Building for platform: ${platform.name}, arch: ${arch === 0 ? 'x64' : arch === 2 ? 'arm64' : 'universal'}`);
  
  if (platform.name === 'mac') {
    const targetArch = arch === 0 ? 'x64' : arch === 2 ? 'arm64' : 'x64';
    console.log(`[beforeBuild] Rebuilding native modules for macOS ${targetArch}...`);
    
    try {
      // Install electron-rebuild if not present
      try {
        execSync('npx electron-rebuild --version', { stdio: 'ignore' });
      } catch {
        console.log('[beforeBuild] Installing electron-rebuild...');
        execSync('npm install --no-save electron-rebuild', { stdio: 'inherit' });
      }
      
      // Rebuild all native modules for the target architecture
      const electronVersion = require('../package.json').devDependencies.electron.replace(/[\^~]/, '');
      execSync(`npx electron-rebuild --force --arch=${targetArch} --version=${electronVersion}`, {
        stdio: 'inherit',
        env: { ...process.env, npm_config_arch: targetArch }
      });
      
      console.log(`[beforeBuild] Successfully rebuilt native modules for ${targetArch}`);
    } catch (error) {
      console.error(`[beforeBuild] Failed to rebuild native modules:`, error.message);
      throw error;
    }
  }
};
