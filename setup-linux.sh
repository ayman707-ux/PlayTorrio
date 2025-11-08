#!/bin/bash
# Quick Linux Setup for PlayTorrio
# Run this after downloading: bash setup-linux.sh

echo "=========================================="
echo "PlayTorrio Linux Setup"
echo "=========================================="
echo ""

# Find AppImage in current directory
APPIMAGE=$(ls PlayTorrio*.AppImage 2>/dev/null | head -n 1)

if [ -z "$APPIMAGE" ]; then
    echo "❌ PlayTorrio.AppImage not found in current directory!"
    echo ""
    echo "Please download PlayTorrio.AppImage first:"
    echo "https://github.com/ayman707-ux/PlayTorrio/releases/latest"
    exit 1
fi

echo "Found: $APPIMAGE"
echo ""

# Make executable
echo "Making AppImage executable..."
chmod +x "$APPIMAGE"

if [ -x "$APPIMAGE" ]; then
    echo "✅ $APPIMAGE is now executable"
else
    echo "❌ Failed to make executable. Try manually:"
    echo "   chmod +x $APPIMAGE"
    exit 1
fi

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Launch PlayTorrio with:"
echo "   ./$APPIMAGE"
echo ""
echo "Or double-click the file in your file manager"
echo ""

# Ask if user wants to launch now
read -p "Launch PlayTorrio now? (y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Starting PlayTorrio..."
    "./$APPIMAGE" &
    echo "PlayTorrio launched!"
fi
