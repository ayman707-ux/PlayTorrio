# Quick Start: Building PlayTorrio for macOS

## What You Need

1. A Mac computer (Intel or Apple Silicon)
2. mpv.app or IINA.app (for video playback)
3. VLC.app (optional, for alternative video playback)
4. icon.icns file for your app icon

## Step-by-Step Setup

### 1. Get the Media Players

#### Download MPV (Recommended)
```bash
# Option A: Using Homebrew (easiest)
brew install --cask mpv

# Then copy to project:
mkdir -p mpv
cp -r /Applications/mpv.app mpv/

# Option B: Or use IINA (modern MPV frontend)
# Download from: https://iina.io/
# Then:
mkdir -p mpv
cp -r /Applications/IINA.app mpv/
```

#### Download VLC (Optional)
```bash
# Download from: https://www.videolan.org/vlc/download-macosx.html
# Then:
mkdir -p VLC
cp -r /Applications/VLC.app VLC/
```

### 2. Verify Directory Structure

Your project should look like this:

```
electron build/
├── main.js
├── package.json
├── build/
│   ├── icon.icns          ← Add your icon here
│   └── entitlements.mac.plist ✓ (already created)
├── mpv/
│   └── mpv.app/           ← Your MPV or IINA.app here
│       └── Contents/
│           └── MacOS/
│               └── mpv (or IINA)
└── VLC/
    └── VLC.app/           ← Your VLC.app here (optional)
        └── Contents/
            └── MacOS/
                └── VLC
```

### 3. Create App Icon (if you don't have one)

If you have a PNG icon (1024x1024), create an ICNS:

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

Or use an online converter: https://cloudconvert.com/png-to-icns

### 4. Install Dependencies

```bash
npm install
```

### 5. Build the macOS App

```bash
npm run build
```

This will create DMG files in the `dist/` folder:
- `PlayTorrio-{version}-x64.dmg` (Intel Macs)
- `PlayTorrio-{version}-arm64.dmg` (Apple Silicon Macs)

### 6. Test the App

1. Open the DMG file
2. Drag PlayTorrio to Applications
3. Right-click PlayTorrio in Applications → Open (first time only)
4. Test all features!

## Troubleshooting

### "Cannot find MPV"
- Make sure mpv.app is in the `mpv/` folder
- Check the path: `mpv/mpv.app/Contents/MacOS/mpv` exists
- Or install MPV system-wide: `brew install --cask mpv`

### "Build failed"
```bash
# Clean and rebuild
rm -rf dist/ node_modules/
npm install
npm run build
```

### "App is damaged" error
This happens on unsigned apps. To fix:
```bash
# Remove quarantine attribute
xattr -cr /Applications/PlayTorrio.app
```

### Build is unsigned
For personal use, this is fine. For distribution:
1. Get Apple Developer account ($99/year)
2. Add your signing identity to package.json
3. Notarize the app

## What's Different on macOS?

### Media Players
- Uses .app bundles instead of .exe files
- Hardware acceleration uses VideoToolbox (not D3D11)

### File Locations
- Settings: `~/Library/Application Support/PlayTorrio/`
- Cache: `~/Library/Caches/PlayTorrio/`
- Books: `~/Library/Application Support/PlayTorrio/epub/`
- Music: `~/Library/Application Support/PlayTorrio/music_offline/`

### Everything Else Works the Same!
- WebTorrent streaming ✓
- Debrid services ✓
- Chromecast ✓
- Book downloads ✓
- Music downloads ✓
- API integrations ✓

## That's It!

You now have a fully functional macOS build of PlayTorrio. Just run `npm run build` and you'll get a DMG file ready to distribute or use!

---

**Need help?** Check the full documentation in `MACOS_BUILD.md` or the change summary in `CHANGES.md`.
