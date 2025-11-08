// afterAllArtifactBuild.cjs - Set AppImage executable after build completes
const fs = require('fs');
const path = require('path');

module.exports = async function afterAllArtifactBuild(context) {
  try {
    const artifactPaths = context.artifactPaths || [];
    
    for (const artifactPath of artifactPaths) {
      // Set executable on AppImage files
      if (artifactPath.endsWith('.AppImage')) {
        try {
          fs.chmodSync(artifactPath, 0o755);
          console.log('[afterAllArtifactBuild] Set executable on:', path.basename(artifactPath));
        } catch (err) {
          console.warn('[afterAllArtifactBuild] Failed to chmod:', err.message);
        }
      }
    }
  } catch (e) {
    console.warn('[afterAllArtifactBuild] Error:', e.message);
  }
};
