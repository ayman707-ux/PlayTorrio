# PlayTorrio - Linux Installation Guide

## Quick Start (AppImage)

### Method 1: Make Executable & Run
```bash
chmod +x PlayTorrio.AppImage
./PlayTorrio.AppImage
```

### Method 2: Use Launch Script
```bash
chmod +x launch-linux.sh
./launch-linux.sh
```

### Method 3: Direct Launch with Flags (if double-click doesn't work)
```bash
chmod +x PlayTorrio.AppImage
./PlayTorrio.AppImage --no-sandbox
```

## Troubleshooting

### AppImage won't launch
If you get a "FUSE not found" error:
```bash
# Ubuntu/Debian
sudo apt install libfuse2

# Fedora/RHEL
sudo dnf install fuse-libs

# Arch Linux
sudo pacman -S fuse2
```

### Alternative: Extract and Run
If FUSE is unavailable:
```bash
./PlayTorrio.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Integrate with Desktop
Right-click PlayTorrio.AppImage → "Integrate and run" (on some file managers)

Or manually:
```bash
./PlayTorrio.AppImage --appimage-integrate
```

## Installation via DEB Package

```bash
sudo dpkg -i PlayTorrio.deb
sudo apt-get install -f  # Fix dependencies if needed
```

Then launch from Applications menu or run:
```bash
playtorrio
```

## System Requirements
- Ubuntu 20.04+ / Debian 10+ / Fedora 32+ / Arch Linux (recent)
- 4GB RAM minimum
- Internet connection for streaming

## Support
For issues, visit: https://github.com/ayman707-ux/PlayTorrio/issues
