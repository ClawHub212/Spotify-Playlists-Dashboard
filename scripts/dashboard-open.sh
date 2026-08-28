#!/bin/zsh
#
# dashboard-open.sh — open Spotify Dashboard on the checkout you're actually
# working in, worktrees included.
#
# Why this exists: the installed app resolves its project root from the
# SpotifyDashboardProjectRoot stamped into Info.plist, which build.sh always
# points at the MAIN checkout — so branch work in a worktree stayed invisible
# until it merged. BackendManager checks SPOTIFY_DASHBOARD_PATH first, so
# launching the app with that variable set makes it serve any checkout. This
# script picks the checkout, makes it runnable, and relaunches the app against
# it only when the target actually changed (a relaunch costs a Flask restart
# and a fresh playlist-cache warm-up, so it isn't done for free).
#
# Usage:
#   dashboard-open.sh                 # the checkout touched most recently
#   dashboard-open.sh main            # force the main checkout
#   dashboard-open.sh <branch>        # force the worktree on that branch
#   dashboard-open.sh <folder-name>   # force the worktree by folder name
#   dashboard-open.sh /abs/path       # force an explicit checkout
#
# Add --background (anywhere in the arguments) to relaunch without stealing
# focus — the app orders its window in behind whatever you're working in.
#
# Prints one line describing what's now live — the Keyboard Maestro macro
# ("Playlist") shows it as a notification so the active branch is never a guess.

set -u
restart_reason=""

# Keyboard Maestro / launchd hand us a minimal environment.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"

MAIN_ROOT="${SPOTIFY_DASHBOARD_MAIN:-$HOME/Development/Spotify Dashboard}"
APP_BUNDLE="/Applications/Spotify Dashboard.app"
PORT=8888
APP_PROC="Spotify Dashboard.app/Contents/MacOS/SpotifyDashboard"

# Gitignored files that live only in the main checkout — credentials, the
# Spotify token, the playlist config, the persisted playlist-track cache, and
# the venv with the deps. A worktree can't run without them, and they're
# deliberately SHARED (one token, one config, one cache) rather than copied.
RUNTIME_FILES=(.env config.json .cache .venv playlist_cache.json)

die() { print -r -- "$1" >&2; exit 1 }

[[ -d "$MAIN_ROOT" ]] || die "Main checkout not found: $MAIN_ROOT"

# Prefer the installed app; fall back to a staging build if an install failed.
if [[ ! -d "$APP_BUNDLE" ]]; then
    APP_BUNDLE="$MAIN_ROOT/desktop/SpotifyDashboard/build/Spotify Dashboard.app"
    [[ -d "$APP_BUNDLE" ]] || die "No Spotify Dashboard build found — run desktop/SpotifyDashboard/build.sh"
fi

# ── 1. Which checkout? ───────────────────────────────────────────────────────

checkouts=()
while IFS= read -r line; do
    [[ "$line" == worktree\ * ]] && checkouts+=("${line#worktree }")
done < <(git -C "$MAIN_ROOT" worktree list --porcelain 2>/dev/null)
(( ${#checkouts} )) || checkouts=("$MAIN_ROOT")

# Newest mtime among a checkout's source files. Runtime state is excluded —
# the running backend rewrites .cache/config.json in whatever root it serves,
# which would otherwise make that checkout look permanently "most recent".
newest_touch() {
    find "$1" \
        \( -name .git -o -name .venv -o -name .claude -o -name __pycache__ \
           -o -name build -o -name node_modules -o -name data \) -prune -o \
        -type f ! -name .env ! -name .cache ! -name config.json \
        ! -name playlist_cache.json ! -name '*.log' \
        -print0 2>/dev/null \
    | xargs -0 stat -f '%m' 2>/dev/null | sort -rn | head -1
}

branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null }

background=0
args=()
for a in "$@"; do
    if [[ "$a" == "--background" ]]; then background=1; else args+=("$a"); fi
done
set -- "${args[@]:-}"

target=""
case "${1:-}" in
    "")            ;;
    main|MAIN)     target="$MAIN_ROOT" ;;
    /*)            target="$1" ;;
    *)  for c in $checkouts; do
            [[ "$(branch_of $c)" == "$1" || "${c:t}" == "$1" ]] && target="$c"
        done
        [[ -n "$target" ]] || die "No checkout matches '$1'" ;;
esac

if [[ -z "$target" ]]; then
    best=0
    for c in $checkouts; do
        t="$(newest_touch $c)"
        [[ -n "$t" ]] || continue
        if (( t > best )); then best=$t; target="$c"; fi
    done
    [[ -n "$target" ]] || target="$MAIN_ROOT"
fi
[[ -f "$target/app.py" ]] || die "Not a dashboard checkout: $target"

# ── 2. Make that checkout runnable ───────────────────────────────────────────

linked=()
if [[ "$target" != "$MAIN_ROOT" ]]; then
    for f in $RUNTIME_FILES; do
        [[ -e "$target/$f" ]] && continue
        [[ -e "$MAIN_ROOT/$f" ]] || continue
        ln -s "$MAIN_ROOT/$f" "$target/$f" 2>/dev/null && linked+=("$f")
    done
fi

# ── 3. Relaunch only if the app isn't already serving that checkout ──────────

app_pid="$(pgrep -f "$APP_PROC" | head -1)"
serving=""
backend_pid="$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null | head -1)"
[[ -n "$backend_pid" ]] && \
    serving="$(lsof -a -p $backend_pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"

# A running instance that predates the installed binary is showing an old build
# (build.sh installs while the app runs) — restart it so "latest" stays true.
stale_binary=0
if [[ -n "$app_pid" ]]; then
    started="$(ps -p $app_pid -o lstart= 2>/dev/null)"
    started_epoch="$(date -j -f '%a %b %e %H:%M:%S %Y' "${started## }" +%s 2>/dev/null)"
    exe_epoch="$(stat -f '%m' "$APP_BUNDLE/Contents/MacOS/SpotifyDashboard" 2>/dev/null)"
    if [[ -n "$started_epoch" && -n "$exe_epoch" ]] && (( exe_epoch > started_epoch )); then
        stale_binary=1
    fi
fi

if [[ -n "$app_pid" && "$serving" == "$target" && $stale_binary -eq 0 ]]; then
    (( background )) || /usr/bin/open "$APP_BUNDLE"
    action="already live"
else
    (( stale_binary )) && restart_reason=" (new build)"
    if [[ -n "$app_pid" ]]; then
        # Quit gracefully so the app takes its Flask child down with it.
        /usr/bin/osascript -e 'tell application id "com.spotifydashboard.app" to quit' >/dev/null 2>&1
        for _ in {1..40}; do
            pgrep -f "$APP_PROC" >/dev/null || break
            sleep 0.25
        done
    fi
    # Wait for the socket to close; a survivor gets reaped by the app itself
    # (BackendManager.reapOrphanedBackend) on the next launch.
    for _ in {1..20}; do
        lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
        sleep 0.25
    done
    if (( background )); then
        /usr/bin/open -g -a "$APP_BUNDLE" \
            --env "SPOTIFY_DASHBOARD_PATH=$target" \
            --env "SPOTIFY_DASHBOARD_BACKGROUND_LAUNCH=1"
    else
        /usr/bin/open -a "$APP_BUNDLE" --env "SPOTIFY_DASHBOARD_PATH=$target"
    fi
    action="relaunched${restart_reason:-}"
fi

# ── 4. Report ────────────────────────────────────────────────────────────────

if [[ "$target" == "$MAIN_ROOT" ]]; then where="main"; else where="worktree ${target:t}"; fi
label="$(branch_of $target)"
[[ -n "$label" ]] || label="(detached)"

note=""
(( ${#linked} )) && note+=" · linked ${(j:, :)linked}"

# The web UI comes from the checkout, but Swift changes only ship through a
# build — say so rather than let a stale binary read as "the current version".
exe="$APP_BUNDLE/Contents/MacOS/SpotifyDashboard"
if [[ -x "$exe" ]]; then
    src="$(find "$target/desktop/SpotifyDashboard" -type f \( -name '*.swift' -o -name 'Info.plist' \) \
           -print0 2>/dev/null | xargs -0 stat -f '%m' 2>/dev/null | sort -rn | head -1)"
    built="$(stat -f '%m' "$exe")"
    (( ${src:-0} > built )) && note+=" · native code newer than the installed build — run build.sh"
fi

print -r -- "$label ($where) · $action$note"
