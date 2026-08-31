#!/bin/bash
#
# Build script for Spotify Dashboard macOS app
# Compiles Swift sources into a .app bundle using swiftc (no Xcode project required)
#
# Prerequisites: Xcode Command Line Tools (xcode-select --install)
#
# Usage:
#   ./build.sh              # build + install to /Applications
#   ./build.sh --relaunch   # …then restart the app on THIS checkout, in the
#                           # background (never steals focus)
#
# --relaunch hands off to scripts/dashboard-open.sh rather than quitting and
# reopening the app itself: that script already waits for the process to exit
# AND for port 8888 to close before relaunching, and its stale-binary check
# (installed executable newer than the running app) is exactly the case a
# rebuild creates. Rolling our own here would be a second, worse copy of it.
#

set -e

RELAUNCH=0
for arg in "$@"; do
    case "$arg" in
        --relaunch) RELAUNCH=1 ;;
        *) echo "Unknown option: $arg (usage: $0 [--relaunch])" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCES_DIR="$SCRIPT_DIR/Sources"
RESOURCES_DIR="$SCRIPT_DIR/Resources"

# Resolve the main repo root so builds from a worktree still land in the
# canonical desktop/SpotifyDashboard/build/ outside the worktree.
# `git rev-parse --git-common-dir` returns the shared .git dir; its parent is
# the main working tree's root.
GIT_COMMON_DIR="$(git -C "$SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON_DIR" ]; then
    # --git-common-dir is printed relative to SCRIPT_DIR (git's -C dir), so resolve
    # it from there — not from the caller's cwd, which may be anywhere.
    GIT_COMMON_DIR="$(cd "$SCRIPT_DIR" && cd "$GIT_COMMON_DIR" && pwd)"
    MAIN_REPO_ROOT="$(dirname "$GIT_COMMON_DIR")"
    BUILD_DIR="$MAIN_REPO_ROOT/desktop/SpotifyDashboard/build"
else
    # Fallback: write next to the script
    BUILD_DIR="$SCRIPT_DIR/build"
fi

# The repo root the installed app should run app.py / serve static files from.
# Prefer the main working tree (so a worktree build still points at the canonical
# checkout); fall back to two levels up from this script (repo root).
if [ -n "$MAIN_REPO_ROOT" ]; then
    PROJECT_ROOT_STAMP="$MAIN_REPO_ROOT"
else
    PROJECT_ROOT_STAMP="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# The checkout this build was run FROM — a worktree here, unlike the stamp
# above, which is always main. --relaunch serves this one, so building in a
# branch and relaunching shows that branch's code.
CHECKOUT_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$CHECKOUT_ROOT" ] || CHECKOUT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

APP_NAME="Spotify Dashboard"
BUNDLE_NAME="SpotifyDashboard"
# Build into a staging dir, then install to /Applications (the canonical home).
APP_BUNDLE="$BUILD_DIR/${APP_NAME}.app"
INSTALL_DIR="/Applications"
INSTALLED_APP="$INSTALL_DIR/${APP_NAME}.app"

echo "=== Building ${APP_NAME} ==="
echo ""

# Clean previous build
rm -rf "$APP_BUNDLE"
mkdir -p "$BUILD_DIR"

# Create .app bundle structure
echo "[1/4] Creating app bundle structure..."
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Copy Info.plist
cp "$RESOURCES_DIR/Info.plist" "$APP_BUNDLE/Contents/"

# Stamp commit-derived version metadata into the bundle's Info.plist.
# CFBundleShortVersionString stays as-is (managed by the app-versioning skill).
# CFBundleVersion + SpotifyDashboardVersionDisplay + SpotifyDashboardVersionCommitURL
# are computed from the same commit (latest origin/main), so the timestamp, SHA,
# and link all agree.
GIT_REF=$(git -C "$SCRIPT_DIR" rev-parse --verify origin/main 2>/dev/null \
       || git -C "$SCRIPT_DIR" rev-parse --verify main 2>/dev/null \
       || git -C "$SCRIPT_DIR" rev-parse HEAD)
GIT_TS_UNIX=$(git -C "$SCRIPT_DIR" log -1 --format='%ct' "$GIT_REF")
GIT_SHA=$(git -C "$SCRIPT_DIR" rev-parse --short=7 "$GIT_REF")
GIT_FULL_SHA=$(git -C "$SCRIPT_DIR" rev-parse "$GIT_REF")
BUILD_NUMBER=$(date -r "$GIT_TS_UNIX" +"%Y%m%d.%H%M")
DISPLAY_VERSION="$(date -r "$GIT_TS_UNIX" +"%m-%d-%y %-I:%M %p") · $GIT_SHA"

# Commit URL for the About-panel hyperlink. Derive the repo's https web URL from the
# origin remote (handles git@, ssh://, and https forms), then append the commit SHA.
# Stays empty when there's no origin remote — the About panel then shows plain text.
COMMIT_URL=""
REMOTE_URL=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo "")
if [ -n "$REMOTE_URL" ]; then
    WEB_URL=$(printf '%s' "$REMOTE_URL" \
        | sed -E 's#^git@([^:]+):#https://\1/#; s#^ssh://git@#https://#; s#\.git$##')
    COMMIT_URL="$WEB_URL/commit/$GIT_FULL_SHA"
fi

PLIST="$APP_BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :SpotifyDashboardVersionDisplay" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :SpotifyDashboardVersionDisplay string $DISPLAY_VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :SpotifyDashboardVersionCommitURL" "$PLIST" 2>/dev/null || true
[ -n "$COMMIT_URL" ] && /usr/libexec/PlistBuddy -c "Add :SpotifyDashboardVersionCommitURL string $COMMIT_URL" "$PLIST"

# Stamp the project root so the app can find app.py / static/ even when launched
# from /Applications (where the bundle-relative path no longer resolves to the repo).
# BackendManager reads this as a fallback after the SPOTIFY_DASHBOARD_PATH env var.
/usr/libexec/PlistBuddy -c "Delete :SpotifyDashboardProjectRoot" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :SpotifyDashboardProjectRoot string $PROJECT_ROOT_STAMP" "$PLIST"

# Copy AppleScript dictionary
cp "$RESOURCES_DIR/SpotifyDashboard.sdef" "$APP_BUNDLE/Contents/Resources/"

# Copy app icon
if [ -f "$RESOURCES_DIR/AppIcon.icns" ]; then
    cp "$RESOURCES_DIR/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/"
fi

# Create PkgInfo
echo -n "APPLSPDH" > "$APP_BUNDLE/Contents/PkgInfo"

# Compile Swift sources
echo "[2/4] Compiling Swift sources..."
SWIFT_FILES=(
    "$SOURCES_DIR/main.swift"
    "$SOURCES_DIR/AppDelegate.swift"
    "$SOURCES_DIR/MainWindowController.swift"
    "$SOURCES_DIR/BackendManager.swift"
    "$SOURCES_DIR/LoadingViewController.swift"
    "$SOURCES_DIR/MissingFilesViewController.swift"
    "$SOURCES_DIR/AuthRequiredViewController.swift"
    "$SOURCES_DIR/StatusBarController.swift"
    "$SOURCES_DIR/HotkeyManager.swift"
    "$SOURCES_DIR/ShortcutRecorderView.swift"
    "$SOURCES_DIR/SettingsWindowController.swift"
    "$SOURCES_DIR/VersionMenuController.swift"
    "$SOURCES_DIR/AppleScriptCommands.swift"
)

swiftc \
    -o "$APP_BUNDLE/Contents/MacOS/$BUNDLE_NAME" \
    -module-name "$BUNDLE_NAME" \
    -framework Cocoa \
    -framework WebKit \
    -framework Carbon \
    -target "$(uname -m)-apple-macosx11.0" \
    -O \
    "${SWIFT_FILES[@]}"

# Native macOS 26 icon fallback (compiled car) — see ~/.claude/skills/mac-app-icons
_icon_ensure="$HOME/.claude/skills/mac-app-icons/scripts/ensure-native-icon.sh"
[ -x "$_icon_ensure" ] && "$_icon_ensure" "$RESOURCES_DIR" "$APP_BUNDLE" || true

# Ad-hoc code sign
echo "[3/5] Code signing..."
codesign --force --sign - "$APP_BUNDLE"

# Install into /Applications (the canonical, permanent location).
# Replacing a running bundle is safe — the live process keeps its open files and
# the new copy is used on next launch.
echo "[4/5] Installing to ${INSTALL_DIR}..."
if rm -rf "$INSTALLED_APP" 2>/dev/null && ditto "$APP_BUNDLE" "$INSTALLED_APP" 2>/dev/null; then
    codesign --force --sign - "$INSTALLED_APP" 2>/dev/null || true
    # Leave exactly ONE "Spotify Dashboard.app" on disk. The staging copy is a
    # second bundle carrying the same identifier, so LaunchServices (and anything
    # that resolves the app by name — AppleScript, Keyboard Maestro, Spotlight,
    # Raycast) can pick it and launch a stale build. Drop it, then re-register the
    # installed copy so every launcher resolves to this build.
    rm -rf "$APP_BUNDLE"
    LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$INSTALLED_APP" >/dev/null 2>&1 || true
    # Finder icon: stamp the repo's chosen style (Resources/.icon-style = dering) on
    # the INSTALLED bundle — macOS's own icon slab always paints a light edge ring,
    # and custom icons render literally. Stamped after install/signing so the bit
    # lands on the final bundle; Assets.car stays as the stamp-missing fallback.
    [ -x "$_icon_ensure" ] && "$_icon_ensure" --stamp "$RESOURCES_DIR" "$INSTALLED_APP" || true
    echo "Installed: $INSTALLED_APP  (staging copy removed — /Applications is the only bundle)"
    FINAL_APP="$INSTALLED_APP"
else
    echo "WARNING: could not write to ${INSTALL_DIR} (admin rights may be required)."
    echo "         The built app is available at: $APP_BUNDLE"
    echo "         To install manually: sudo ditto \"$APP_BUNDLE\" \"$INSTALLED_APP\""
    FINAL_APP="$APP_BUNDLE"
fi

echo "[5/5] Build complete!"
echo ""
echo "App bundle: $FINAL_APP"
echo "Size: $(du -sh "$FINAL_APP" | cut -f1)"
echo ""
echo "To run: open \"$FINAL_APP\""
echo "Or use: ./run.sh (from the desktop/ directory)"

# Debug worktree menu item — standard on every Mac app.
# Prints nothing once the menu is installed. See ~/.claude/skills/mac-worktree-menu.
_wtm_check="$HOME/.claude/skills/mac-worktree-menu/check.sh"
[ -x "$_wtm_check" ] && "$_wtm_check" "$(dirname "$0")" || true


# ── Optional relaunch ────────────────────────────────────────────────────────
# Delegated to dashboard-open.sh (see the header note). Prefer this checkout's
# copy so a branch that changes the launcher tests its own version; fall back to
# main's for branches that predate the script.
if [ "$RELAUNCH" -eq 1 ]; then
    if [ "$FINAL_APP" != "$INSTALLED_APP" ]; then
        echo "" >&2
        echo "ERROR: --relaunch skipped — the build never reached ${INSTALL_DIR}," >&2
        echo "       so relaunching would just start the old installed build." >&2
        exit 1
    fi

    LAUNCHER="$CHECKOUT_ROOT/scripts/dashboard-open.sh"
    [ -x "$LAUNCHER" ] || LAUNCHER="${MAIN_REPO_ROOT:-$CHECKOUT_ROOT}/scripts/dashboard-open.sh"
    if [ ! -x "$LAUNCHER" ]; then
        echo "" >&2
        echo "ERROR: --relaunch needs scripts/dashboard-open.sh, not found at:" >&2
        echo "       $LAUNCHER" >&2
        exit 1
    fi

    echo ""
    echo "Relaunching (background) on: $CHECKOUT_ROOT"
    # exec so the launcher's exit status is this script's — a failed relaunch
    # fails the build command, instead of reporting a success that didn't happen.
    exec "$LAUNCHER" "$CHECKOUT_ROOT" --background
fi
