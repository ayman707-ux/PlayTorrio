# PlayTorrio macOS Build Guide

## Overview
This guide explains how to build PlayTorrio for macOS. The application has been fully updated to support macOS with native .app bundles for media players, proper path handling, and hardware acceleration.

## Prerequisites

1. **macOS System** - You need to be on a Mac to build for macOS
2. **Node.js** - Install from https://nodejs.org/
3. **Xcode Command Line Tools** - Install via: `xcode-select --install`

## Setting Up Media Players for macOS

PlayTorrio uses MPV or VLC for video playback. You need to include these in your build:

### Option 1: Use Bundled Players (Recommended for Distribution)

Create the following directory structure in your project:

```
electron build/
├── mpv/
│   └── mpv.app/          (or IINA.app)
│       └── Contents/
│           └── MacOS/
│               └── mpv   (executable)
└── VLC/
    └── VLC.app/
        └── Contents/
            └── MacOS/
                └── VLC   (executable)
```

**Getting the Players:**

#### MPV (Recommended)
1. Download MPV from https://mpv.io/installation/ (macOS section)
2. Or use IINA (a modern MPV frontend): https://iina.io/
3. Copy the .app bundle to `electron build/mpv/`
4. Ensure the structure matches: `mpv/mpv.app/Contents/MacOS/mpv`

#### VLC
1. Download VLC from https://www.videolan.org/vlc/download-macosx.html
2. Copy VLC.app to `electron build/VLC/`
3. Ensure the structure matches: `VLC/VLC.app/Contents/MacOS/VLC`

### Option 2: System-Wide Installation (Fallback)

The app will also detect system-wide installations in `/Applications/`:
- `/Applications/mpv.app/Contents/MacOS/mpv`
- `/Applications/IINA.app/Contents/MacOS/IINA`
- `/Applications/VLC.app/Contents/MacOS/VLC`

## Building the macOS App

### 1. Install Dependencies
```bash
npm install
```

### 2. Place Media Players
Ensure your media players are in the correct directories as described above.

### 3. Add App Icon
Place your macOS icon file at:
```
build/icon.icns
```

You can convert a PNG to ICNS using online tools or this command:
```bash
# If you have a 1024x1024 PNG
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

### 4. Build the DMG
```bash
npm run build
```

This will create:
- `dist/PlayTorrio-{version}-x64.dmg` (Intel Macs)
- `dist/PlayTorrio-{version}-arm64.dmg` (Apple Silicon)

## macOS-Specific Features

### Hardware Acceleration
- **macOS**: Uses VideoToolbox for hardware-accelerated video decoding
- **Windows**: Uses D3D11VA
- **Linux**: Uses VAAPI

### File Paths
All file paths are now cross-platform:
- **User Data**: `~/Library/Application Support/PlayTorrio/`
- **Cache**: `~/Library/Caches/PlayTorrio/`
- **Temp Files**: System temp directory via `os.tmpdir()`
- **EPUB Books**: `~/Library/Application Support/PlayTorrio/epub/`
- **Music Offline**: `~/Library/Application Support/PlayTorrio/music_offline/`
- **Subtitles**: `{cache}/playtorrio_subs/`
- **WebTorrent**: `{cache}/webtorrent/`

### Media Player Integration
The app automatically detects the platform and uses the correct player path:
- Searches bundled .app bundles first
- Falls back to system-wide installations
- Supports both MPV and IINA on macOS
- Proper error messages guide users to install missing players

## Troubleshooting

### Build Fails with Code Signing Error
If you see code signing errors, you can:
1. Disable signing temporarily by setting in package.json:
   ```json
   "mac": {
     "identity": null
   }
   ```
2. Or sign with your Apple Developer certificate

### Players Not Found
- Ensure .app bundles are complete (Contents/MacOS/executable must exist)
- Check console logs for the exact paths being searched
- Install players system-wide as a fallback

### Permission Errors
The app needs permissions for:
- Network access (streaming)
- File system access (downloads, cache)
- Apple Events (controlling external players)

These are declared in `build/entitlements.mac.plist`

### DMG Not Mounting
- Make sure you have enough disk space
- Try cleaning the build: `rm -rf dist/ && npm run build`

## Distribution

### For Personal Use
The generated DMG can be installed by:
1. Opening the DMG
2. Dragging PlayTorrio to Applications folder
3. Right-clicking and selecting "Open" on first launch (macOS Gatekeeper)

### For Public Distribution
You'll need:
1. Apple Developer Account ($99/year)
2. Sign the app with your certificate
3. Notarize the app with Apple
4. Update package.json with your signing identity

## Testing

After building, test the following features:
- [ ] App launches successfully
- [ ] MPV/VLC players can be launched
- [ ] Streaming works (WebTorrent, debrid services)
- [ ] File downloads work (books, music)
- [ ] Cache clearing works
- [ ] Settings persist between launches
- [ ] Hardware acceleration is active (check CPU usage during playback)

## Platform Differences

### What Works the Same
- WebTorrent streaming
- Debrid integration (Real-Debrid, etc.)
- Chromecast support
- Book downloads (EPUB)
- Music downloads
- API integrations
- Cache management

### What's Different
- Media player paths (.app bundles vs .exe)
- Hardware acceleration methods
- File system paths (Unix-style vs Windows)
- Cache locations (Library vs AppData)
- No NSIS installer (uses DMG instead)

## Support

If you encounter issues:
1. Check the console logs in the app
2. Verify media players are correctly installed
3. Ensure all dependencies are installed
4. Check file permissions on userData directory

## Credits

PlayTorrio by Ayman
- GitHub: https://github.com/ayman707-ux/PlayTorrio
- Email: aymanisthedude1@gmail.com
