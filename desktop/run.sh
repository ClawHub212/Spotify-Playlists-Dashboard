#!/bin/bash
#
# Launch script for Spotify Dashboard (old)
# Builds (if needed) and launches the macOS app
#
# Usage: ./run.sh [--rebuild]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# build.sh installs the app here (the canonical, permanent location).
APP_BUNDLE="/Applications/Spotify Dashboard (old).app"

# Export project root so the app can find app.py
export SPOTIFY_DASHBOARD_PATH="$PROJECT_ROOT"

# Build if app doesn't exist or --rebuild flag is passed
if [ ! -d "$APP_BUNDLE" ] || [ "$1" = "--rebuild" ]; then
    echo "Building Spotify Dashboard (old)..."
    chmod +x "$SCRIPT_DIR/SpotifyDashboard/build.sh"
    "$SCRIPT_DIR/SpotifyDashboard/build.sh"
    echo ""
fi

echo "Launching Spotify Dashboard (old)..."
echo "Project root: $PROJECT_ROOT"
echo ""

# Launch the app (it manages the Flask backend internally)
open "$APP_BUNDLE" --env SPOTIFY_DASHBOARD_PATH="$PROJECT_ROOT"
