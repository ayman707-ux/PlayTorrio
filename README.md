# PlayTorrio - Cross-Platform Media Center

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://github.com/ayman707-ux/PlayTorrio/tree/main?tab=License-1-ov-file)

**PlayTorrio** is an all-in-one media center application that brings together streaming, torrenting, and media management in a beautiful, easy-to-use interface.

## ✨ Features

### 🎬 Media Streaming
- **WebTorrent Integration** - Stream torrents directly without waiting for downloads
- **Debrid Services** - Support for Real-Debrid, AllDebrid, and more
- **Multi-File Selection** - Choose which files to stream from torrents
- **Resume Playback** - Continue watching where you left off

### 📺 Content Discovery
- **Movies & TV Shows** - Browse and search extensive catalogs
- **Anime** - Dedicated anime section with subtitles
- **Metadata** - Rich information from TMDB, TVDB, and more
- **Jackett Integration** - Search across hundreds of torrent sites

### 📱 Casting & Playback
- **Chromecast Support** - Cast to your TV seamlessly
- **MPV Player** - High-quality playback with hardware acceleration
- **VLC Integration** - Alternative player support
- **Subtitle Support** - Automatic subtitle downloading and loading

### 📚 Book Library
- **EPUB Downloads** - Download and read books
- **Z-Library Integration** - Access millions of books
- **Cover Art** - Beautiful library with cover images
- **Offline Reading** - Books saved locally

### 🎵 Music Features
- **Music Streaming** - Stream from various sources
- **Offline Downloads** - Save music for offline listening
- **Cover Art & Metadata** - Rich music library

### 🎮 Additional Features
- **Discord Rich Presence** - Show what you're watching
- **Auto-Updates** - Stay up to date automatically
- **Cache Management** - Control storage and cleanup
- **Custom Cache Location** - Choose where to store files
- **Dark Mode UI** - Beautiful, modern interface

## 🖥️ Platform Support

### ✅ Windows
- Windows 10/11
- NSIS Installer
- Full feature support

### ✅ macOS
- macOS 10.15+
- Intel & Apple Silicon (universal)
- DMG Installer
- Native .app support for players

### ✅ Linux
- AppImage & .deb packages
- Ubuntu, Debian, Fedora, Arch
- Full feature support

## 🚀 Quick Start

### For Windows Users
1. Download `PlayTorrio.installer.exe` from [Releases](https://github.com/ayman707-ux/PlayTorrio/releases)
2. Run the installer
3. Launch PlayTorrio from Start Menu or Desktop

### For macOS Users
1. Download `PlayTorrio-{version}-{arch}.dmg` from [Releases](https://github.com/ayman707-ux/PlayTorrio/releases)
   - Choose `x64` for Intel Macs
   - Choose `arm64` for Apple Silicon (M1/M2/M3)
2. Open the DMG and drag PlayTorrio to Applications
3. Right-click PlayTorrio → Open (first time only)

### For Linux Users
1. Download `PlayTorrio-{version}.AppImage` from [Releases](https://github.com/ayman707-ux/PlayTorrio/releases)
2. Open it






## 📦 Dependencies

### Media Players
PlayTorrio requires either MPV or VLC for video playback:

#### Windows
- Players are bundled in the installer

#### macOS
- Install system-wide: `brew install --cask mpv` or download from [mpv.io](https://mpv.io/)
- Alternative: [IINA](https://iina.io/) (modern MPV frontend)
- VLC: Download from [videolan.org](https://www.videolan.org/)

#### Linux
```bash
# MPV
sudo apt install mpv        # Debian/Ubuntu
sudo dnf install mpv        # Fedora
sudo pacman -S mpv          # Arch

# VLC
sudo apt install vlc        # Debian/Ubuntu
sudo dnf install vlc        # Fedora
sudo pacman -S vlc          # Arch
```

## 🔧 Configuration

### First Launch
1. **Optional**: Configure Jackett for torrent search
   - Settings → Jackett API Key
   - Enter your Jackett URL and API key

2. **Optional**: Set up Real-Debrid
   - Settings → Real-Debrid
   - Enter your API key for premium streaming

3. **Optional**: Choose cache location
   - Settings → Cache Location
   - Select where to store temporary files

### Media Player Selection
- Click the MPV/VLC toggle in the player controls
- Default: MPV (recommended for better performance)

## 📂 File Locations

### Windows
- Settings: `%APPDATA%\PlayTorrio\`
- Cache: `%LOCALAPPDATA%\PlayTorrio\`
- Books: `%APPDATA%\PlayTorrio\epub\`

### macOS
- Settings: `~/Library/Application Support/PlayTorrio/`
- Cache: `~/Library/Caches/PlayTorrio/`
- Books: `~/Library/Application Support/PlayTorrio/epub/`

### Linux
- Settings: `~/.config/PlayTorrio/`
- Cache: `~/.cache/PlayTorrio/`
- Books: `~/.config/PlayTorrio/epub/`

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

This project is licensed under the CUSTOM License - see the LICENSE file for details.

## 🐛 Issues & Support

Found a bug? Have a feature request?
- Open an issue on [GitHub](https://github.com/ayman707-ux/PlayTorrio/issues)
- Email: aymanisthedude1@gmail.com

## 🙏 Acknowledgments

- [Electron](https://www.electronjs.org/) - Cross-platform desktop framework
- [WebTorrent](https://webtorrent.io/) - Streaming torrent client
- [MPV](https://mpv.io/) - Media player
- [VLC](https://www.videolan.org/) - Alternative media player
- All the open-source libraries that make this possible

## ⭐ Star History

If you like PlayTorrio, please give it a star on GitHub!

---

Icon Made by Adnan ahmed
https://github.com/ddosintruders
https://adnan-ahmed.pages.dev/

**Made with ❤️ by Ayman**

[Download Latest Release](https://github.com/ayman707-ux/PlayTorrio/releases) | [Report Bug](https://github.com/ayman707-ux/PlayTorrio/issues) | [Request Feature](https://github.com/ayman707-ux/PlayTorrio/issues)
