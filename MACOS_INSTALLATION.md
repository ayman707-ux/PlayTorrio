# macOS Installation Instructions

## "PlayTorrio is damaged" Error Fix

If you see **"PlayTorrio is damaged and can't be opened"**, this is macOS Gatekeeper blocking unsigned apps.

### Quick Fix (Run this command in Terminal):

```bash
xattr -cr /Applications/PlayTorrio.app
```

Or if the app is still in Downloads:

```bash
xattr -cr ~/Downloads/PlayTorrio.app
```

### Alternative Method:

1. **Right-click** (or Control+click) on PlayTorrio.app
2. Select **"Open"**
3. Click **"Open"** again in the dialog
4. The app will now run (you only need to do this once)

### What This Does:

- Removes the quarantine flag that macOS sets on downloaded apps
- This is safe - the app isn't actually damaged, just unsigned

### One-Time Bypass:

After installation, you may also need to run:

```bash
sudo spctl --master-disable
```

Then in **System Preferences → Security & Privacy**, select **"Anywhere"** under "Allow apps downloaded from".

**Note**: Remember to re-enable Gatekeeper after installing:

```bash
sudo spctl --master-enable
```

## Requirements

- macOS 10.12 (Sierra) or later
- MPV player (bundled in the app)

## Features

All features work on macOS:
- ✅ WebTorrent streaming
- ✅ MPV playback with hardware acceleration (VideoToolbox)
- ✅ Cache clearing
- ✅ Book/Music downloads
- ✅ Debrid integration
- ✅ Chromecast support
- ✅ Auto-updates
