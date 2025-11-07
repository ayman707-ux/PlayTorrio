# 🎯 YOUR TODO CHECKLIST - Build macOS Version

## Before You Can Build

### ☐ 1. Get MPV or IINA
Pick one method:

**Option A: Using Homebrew (Easiest)**
```bash
brew install --cask mpv
mkdir -p mpv
cp -r /Applications/mpv.app mpv/
```

**Option B: Download IINA (Modern MPV UI)**
1. Go to https://iina.io/
2. Download IINA.app
3. Move it to Applications
4. Copy to your project:
```bash
mkdir -p mpv
cp -r /Applications/IINA.app mpv/
```

**Option C: Download MPV Directly**
1. Go to https://mpv.io/installation/
2. Download for macOS
3. Copy mpv.app to your project's `mpv/` folder

### ☐ 2. (Optional) Get VLC
```bash
# Download from https://www.videolan.org/vlc/download-macosx.html
# Then:
mkdir -p VLC
cp -r /Applications/VLC.app VLC/
```

### ☐ 3. Create App Icon (icon.icns)

**If you have a PNG (1024x1024):**
```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
mv icon.icns build/
rm -rf icon.iconset
```

**Or use an online converter:**
- https://cloudconvert.com/png-to-icns
- Download the .icns file
- Save it as `build/icon.icns`

## Verification Checklist

### ☐ 4. Verify File Structure
Run this to check everything is in place:
```bash
# Check MPV/IINA
ls -la mpv/mpv.app/Contents/MacOS/mpv 2>/dev/null || ls -la mpv/IINA.app/Contents/MacOS/IINA

# Check icon
ls -la build/icon.icns

# Check entitlements (should already exist)
ls -la build/entitlements.mac.plist
```

Expected output:
```
✓ mpv/mpv.app/Contents/MacOS/mpv (or IINA)
✓ build/icon.icns
✓ build/entitlements.mac.plist
```

### ☐ 5. Install Dependencies
```bash
npm install
```

## Build Process

### ☐ 6. Run the Build
```bash
npm run build
```

This will take a few minutes. You'll see:
- ⠋ Packaging for macOS...
- ⠋ Building DMG...
- ✓ Build complete!

### ☐ 7. Find Your DMG Files
```bash
ls -lh dist/*.dmg
```

You should see:
- `PlayTorrio-1.7.9-x64.dmg` (Intel Macs)
- `PlayTorrio-1.7.9-arm64.dmg` (Apple Silicon)

## Testing

### ☐ 8. Test the Build
```bash
# Open the DMG
open dist/PlayTorrio-*-arm64.dmg  # For Apple Silicon
# OR
open dist/PlayTorrio-*-x64.dmg    # For Intel

# Install it:
# 1. Drag PlayTorrio to Applications
# 2. Close the DMG
# 3. Open Applications folder
# 4. Right-click PlayTorrio → Open (first time only)
```

### ☐ 9. Test All Features

Open the app and test:
- [ ] App launches successfully
- [ ] Click on a movie/show
- [ ] Try streaming with WebTorrent
- [ ] Try opening in MPV player
- [ ] Try opening in VLC player (if included)
- [ ] Download a book (BookTorrio tab)
- [ ] Download music (Music tab)
- [ ] Clear cache (Settings → Clear Cache)
- [ ] Change cache location (Settings)
- [ ] Check if files are saved correctly:
  ```bash
  ls ~/Library/Application\ Support/PlayTorrio/epub/
  ls ~/Library/Application\ Support/PlayTorrio/music_offline/
  ```

## Troubleshooting

### ❌ "Cannot find MPV" error
```bash
# Make sure the path exists:
ls mpv/mpv.app/Contents/MacOS/mpv
# OR
ls mpv/IINA.app/Contents/MacOS/IINA

# If not, copy it again:
cp -r /Applications/mpv.app mpv/
```

### ❌ Build fails with "icon.icns not found"
```bash
# Check if icon exists:
ls build/icon.icns

# If not, create it (see step 3 above)
```

### ❌ "App is damaged" when opening
```bash
# Remove quarantine attribute:
xattr -cr /Applications/PlayTorrio.app
```

### ❌ Build succeeds but no DMG created
```bash
# Clean and rebuild:
rm -rf dist/ node_modules/.cache
npm run build
```

## Distribution

### ☐ 10. (Optional) Share Your Build

Once tested and working:
1. Upload DMG files to GitHub Releases
2. Or share directly with users
3. Tell users which DMG to download:
   - Intel Macs → x64 version
   - Apple Silicon (M1/M2/M3) → arm64 version

## Quick Reference

| What | Command |
|------|---------|
| Build | `npm run build` |
| Dev Mode | `npm start` |
| Clean Build | `rm -rf dist/ && npm run build` |
| Check Logs | Open app, check Console.app |
| DMG Location | `dist/PlayTorrio-*.dmg` |

## Summary

```bash
# THE COMPLETE BUILD PROCESS:
# 1. Get players
brew install --cask mpv
mkdir -p mpv
cp -r /Applications/mpv.app mpv/

# 2. Get/create icon (if needed)
# [Create icon.icns and save to build/]

# 3. Build
npm install
npm run build

# 4. Test
open dist/PlayTorrio-*-arm64.dmg

# 5. Done! 🎉
```

---

**Need more help?** Check these files:
- `QUICKSTART_MACOS.md` - Quick guide
- `MACOS_BUILD.md` - Detailed instructions
- `BUILD_COMPLETE.md` - What was changed

**Ready to build?** Follow this checklist step by step!
