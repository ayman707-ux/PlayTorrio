#!/bin/bash
# PlayTorrio Launcher Script for Linux
# This script ensures the AppImage is executable and launches it with proper flags

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE_PATH="$SCRIPT_DIR/PlayTorrio.AppImage"

# Make AppImage executable if it isn't already
if [ ! -x "$APPIMAGE_PATH" ]; then
    echo "Making PlayTorrio.AppImage executable..."
    chmod +x "$APPIMAGE_PATH"
fi

# Launch with proper flags for Linux compatibility
exec "$APPIMAGE_PATH" --no-sandbox --disable-gpu-sandbox "$@"
