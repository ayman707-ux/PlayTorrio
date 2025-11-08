#!/bin/bash
# This script sets up and pushes your macOS build to GitHub

echo "🚀 Setting up macOS build for GitHub Actions..."
echo ""

# Step 1: Remove cached large files if they exist
echo "📦 Removing large files from Git tracking..."
git rm -r --cached node_modules 2>/dev/null || true
git rm -r --cached mpv 2>/dev/null || true
git rm -r --cached VLC 2>/dev/null || true
git rm -r --cached dist 2>/dev/null || true
echo "✓ Done"
echo ""

# Step 2: Add all necessary files
echo "📝 Adding source files..."
git add .gitignore
git add .github/
git add package.json
git add package-lock.json
git add main.js
git add server.mjs
git add preload.js
git add api.cjs
git add chromecast.mjs
git add torrentscrapernew-server.cjs
git add index.cjs
git add public/
git add build/
git add icon.ico
git add jackett_api_key.json
git add *.md
echo "✓ Done"
echo ""

# Step 3: Commit
echo "💾 Committing changes..."
git commit -m "Add macOS build workflow with icon conversion"
echo "✓ Done"
echo ""

# Step 4: Push
echo "⬆️  Pushing to GitHub..."
git push origin main
echo "✓ Done"
echo ""

echo "✅ All done! Your macOS build will start automatically on GitHub."
echo ""
echo "📍 Watch the build at:"
echo "   https://github.com/ayman707-ux/PlayTorrioMAC/actions"
echo ""
echo "⏱️  Build takes ~5-10 minutes"
echo "📦 Download the DMG from the 'Artifacts' section when done"
