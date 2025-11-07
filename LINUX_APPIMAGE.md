# AppImage Installation Guide for Linux

## Quick Start

1. Download `PlayTorrio-*.AppImage` from releases
2. Make it executable: `chmod +x PlayTorrio-*.AppImage`
3. Run it: `./PlayTorrio-*.AppImage`

## Troubleshooting: AppImage Won't Start

### Make Sure It's Executable
```bash
chmod +x PlayTorrio-*.AppImage
```

### Install FUSE (Required for AppImage)
**Ubuntu/Debian:**
```bash
sudo apt install libfuse2
```

**Fedora:**
```bash
sudo dnf install fuse fuse-libs
```

**Arch:**
```bash
sudo pacman -S fuse2
```

### Try Running from Terminal (to see errors)
```bash
./PlayTorrio-*.AppImage
```

### Extract and Run Directly (if FUSE unavailable)
```bash
./PlayTorrio-*.AppImage --appimage-extract
cd squashfs-root
./playtorrio
```

## Alternative: Use .deb Package

If AppImage still doesn't work, use the `.deb` package instead:

```bash
sudo dpkg -i PlayTorrio-*.deb
sudo apt-get install -f  # Fix dependencies if needed
```

Then launch from applications menu or run:
```bash
playtorrio
```

## Install MPV (Recommended for Best Playback)

```bash
# Ubuntu/Debian
sudo apt install mpv

# Fedora
sudo dnf install mpv

# Arch
sudo pacman -S mpv
```

## Common Issues

**"Permission denied"**
- Solution: `chmod +x PlayTorrio-*.AppImage`

**"No such file or directory" when running**
- Solution: Install FUSE: `sudo apt install libfuse2`

**Nothing happens, no error**
- Solution: Install FUSE or use the `.deb` package instead

**Missing libraries**
- Solution: Use `.deb` package which handles dependencies automatically
