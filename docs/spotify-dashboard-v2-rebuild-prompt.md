# Spotify Dashboard v2 — Rebuild Prompt

> **How to use:** paste everything below the line into a fresh Claude Code session.
> If this is a brand-new repo, the session should start with the `github-new-repo` skill
> (private, under `BoltHub973`). If it lives beside the current app, keep the old app
> untouched and runnable until v2 reaches parity.
>
> Written 09-04-26 from the v1 codebase, now retired as `~/Development/Spotify Dashboard (old)` (repo `BoltHub973/Spotify-Dashboard-old`, app `Spotify Dashboard (old).app`). The new app takes the plain `Spotify Dashboard` name, folder and `/Applications/Spotify Dashboard.app` path — the Keyboard Maestro launchers already point there.

---

## 🎯 What I want

Rebuild my **Spotify Dashboard** as a new app whose core design goal is:

> **One warm Spotify brain, many cheap clients.**
> Several git worktrees of this app must be able to run **at the same time**, each as its
> own window/app, without fighting over ports, files, or Spotify rate limits.

Feature parity with v1 is required (list below), but the *architecture* is the point —
v1 is a single Flask process + a single Swift wrapper that both assume "there is only ever
one of me", and that is exactly what v2 must not do.

Load these skills before doing anything: `personal-software` (which pulls in
`NAGA-futuristic-design` + `app-versioning`), `url-mac-apps`, `mac-worktree-menu`,
`mac-app-icons`, `mac-app-rebuild-relaunch`, `spotify-web-api`, `keyboard-maestro`.
My global `~/.claude/CLAUDE.md` rules apply throughout (multi-window, window-like Settings,
background relaunch, no publishing, no auto-commit, build-report shape).

---

## 🧠 Architecture — non-negotiable

### 1. Daemon + thin UIs
- 🛰️ **One long-running daemon** owns: Spotify auth, the playback poll loop, the playlist
  membership cache, and all Spotify writes. It runs once, on a **fixed** port, managed by
  a `launchd` agent. It survives UI relaunches.
- 🪟 **Each UI instance** (one per worktree) is a thin native shell + web UI that
  **subscribes** to the daemon. It never talks to Spotify directly.
- 📬 **Push, not poll:** the daemon broadcasts state (track changed, membership changed,
  cache warming/ready, rate-limited) over a local socket / WebSocket. Clients render what
  they're told.
- 🔁 **Version handshake** on connect. A worktree that changes the daemon's protocol runs
  its own daemon instance on a derived port for testing; the stable daemon is never broken
  by an experiment.

### 2. Identity is derived from the checkout — never a constant
- 🔌 **UI port** = deterministic hash of the checkout path into a private range
  (e.g. 8900–8999). `main` gets a stable well-known port.
- 🏷️ **Bundle ID + app name** carry a per-worktree suffix at build time
  (`…dashboard.tracker-artist-follow`), so LaunchServices, AppleScript quit-by-id, and the
  Dock treat each worktree as a distinct app. Never two bundles with one ID.
- 🎨 **Visual identity per instance:** window title + menu-bar item tinted / labeled with
  the worktree's human name, so I always know which one I'm looking at.
- ⎇ **Worktree menu** (`mac-worktree-menu` skill) is in from day one: branch, path, code
  age, stale-binary warning, Open in Claude Code deep link
  (`claude://claude.ai/epitaxy/local_<id>`).

### 3. State split by ownership
| State | Owner | Lives in |
|---|---|---|
| 🔑 Spotify token (`.cache`) | daemon | daemon's app-support dir — **one** copy |
| 🧊 playlist membership cache | daemon | daemon's app-support dir, persisted across restarts |
| ⚙️ `config.json` (pages + playlists) | UI instance | the checkout (gitignored), editable live from the UI |
| 🪟 window frames, theme, shortcuts, Settings | UI instance | per-bundle-ID defaults / localStorage |
| 🧪 experiments | UI instance | a worktree may point at a *copy* of config to try breaking changes |

No file is ever symlinked from `main` into a worktree. No two processes write the same file.

### 4. OAuth exactly once
- Only the daemon has a Spotify redirect URI. New worktrees never require a change in the
  Spotify developer dashboard.
- Refresh tokens expire ~6 months (2026-07-20 policy). A dead token → daemon reports
  `auth_required`; every client shows a login screen that hands off to the daemon's login.

---

## ✨ Feature parity with v1 (must all exist)

### Pages (each a full window view, switchable; each has a Keyboard Maestro launcher)
- 📀 **PLAYLISTS** — grid of my curated playlists; tiles light up when the current track is in
  them; click toggles add/remove (add also Likes the song; remove also un-Likes it if it's in
  no other dashboard playlist). Live text filter (F, `/`, ⌘F). NEW / EDIT / SPOTIFY-mode /
  CANCEL actions with rebindable single-key shortcuts (N/E/S/C, Esc always cancels).
  ⌘-click or Spotify-mode click opens the playlist in the Spotify desktop app.
- 🎯 **TRACKER** — same grid model in list form with optional **labeled dividers** that render
  as vertical section rails. Adding here **also follows the track's main artist**, and the
  toast says "Now following X" or **"Already following X"** (checked first — never claim a
  fresh follow).
- 📚 **QUEUE** — operates on the **whole current album**: tiles add/remove every track of the
  album. Header shows album name, release date, track count. Add copies the playlist's
  Spotify name to the clipboard.

### Header (every page)
- Current track art, title, artist (Queue: album + meta), animated waveform visualizer
  (playing / paused / hidden), dominant-color dynamic background extracted from the art
  (cached per track), **repeat-one toggle** with optimistic lock, theme toggle,
  sidebar auto-reveal eye toggle.

### Sidebars (right edge, slide-in, edge handle + ⌘S, pushes the grid)
- 🎤 **Artist sidebar** (Playlists + Tracker): the artist's latest album/EP/single
  (excluding deluxe/remaster/live/anniversary by configurable patterns), release date,
  Follow / Unfollow, Save-to-Library, and an **ADD TO QUEUE** list of the Queue page's
  playlists (toggle the whole release in/out).
- 💿 **Album sidebar** (Queue): the current album's art, badge (ALBUM / EP / SINGLE), name,
  artist, Spotify's own stats line ("2026 • 28 songs, 49 min 47 sec"), Save-to-Library, and
  the **full tracklist** with the playing track lit (animated equalizer in the page accent,
  static when paused, auto-scrolled into view), hover ▶ / double-click plays that track in
  album context, disc headers for multi-disc albums.
- 👁️ **Auto-reveal switch** (persisted): governs whether a sidebar opens *itself* (on an
  add; Queue also once on load). Manual open always works. Every new auto-open path goes
  through the same guard.

### Playlist editor (in-app, writes config live)
- Add / edit / remove tiles; picker of my Spotify playlists with search; display name may
  differ from the Spotify name; `spotify_id` resolves duplicate names; dividers with
  optional labels. Config format — keep v1-compatible so I can import my existing file:

```json
{
  "pages": [
    { "id": "playlists", "label": "PLAYLISTS", "type": "grid", "route": "/",
      "playlists": [
        { "display_name": "My Favorites", "spotify_name": "Exact Spotify Name" },
        { "display_name": "Workout", "spotify_name": "Dup Name", "spotify_id": "…" }
      ] },
    { "id": "tracker", "label": "TRACKER", "type": "list", "route": "/tracker",
      "playlists": [ { "type": "divider", "label": "SECTION" }, { "…": "…" } ] },
    { "id": "queue", "label": "QUEUE", "type": "album-list", "route": "/queue",
      "playlists": [ { "type": "divider" }, { "…": "…" } ] }
  ],
  "sidebar": { "exclude_patterns": ["deluxe","remaster","live","anniversary"],
               "queue_page_id": "queue" }
}
```

### Settings — ONE surface, window-like (my global standard)
- Most-of-screen by default, resizable, frame persisted, ⌘, opens, ⌘` toggles,
  ⌃G / ⌃A / ⌃S jump to General / Appearance / Shortcuts — all rebindable.
- Sections: **General** (app mode: regular vs menu-bar-only, float on top, global hotkeys
  per page), **Appearance** (theme grids — see below), **Shortcuts** (grid actions, sidebar
  toggle, section jumps, theme toggle ⌘⇧L — every one a recorder row with a live badge).
- No About section — About is the native panel, rendered
  `Version <semver> (<MM-DD-YY h:MM AM/PM · short-SHA>)` with the SHA linked to GitHub
  (`app-versioning` skill).

### Themes
- Dark default ("Phosphor") + light ("Daybreak"), all colors from one token sheet, per-page
  accent (Playlists green, Tracker purple, Queue orange). Themes surface in **two** places:
  a flat menu-bar Themes list with ☀/☾ glyphs and ✓, and Settings › Appearance swatch grids
  painted in each theme's colors. NAGA design language (`NAGA-futuristic-design`), larger
  readability-first type, Orbitron / Rajdhani / JetBrains Mono.

### Native app behaviors
- 🪟 Multi-window from day one (⌘⇧N, red close never quits).
- 🚀 **Instant launch:** because the daemon is already warm, a new window shows real data
  immediately — no loading screen gated on readiness flags, no warm-up wait.
- 🎹 Hand-built menu bar with a real Edit menu (⌘X/C/V/A, emoji palette) — text editing in
  the web view depends on it.
- 🌙 **Background relaunch** honored: `open -g` + env var → skip activate and `orderBack`
  windows; user-initiated opens still front the window.
- 🔁 `/toggle-repeat` also fires the Keyboard Maestro **Repeat Toggle** macro
  (`91EEA4DF-857F-415B-93D8-4584BCD4E92B`, group "Spotify Dashboard - External") with
  `-p On|Off`.
- 🎛️ Three KM launchers (Playlist `03C502E9-…`, Tracker `60457DEF-…`, Queue `5317C887-…`)
  are **one surface** — any launch-behavior change goes into all three. In v2 they should
  target a **specific instance** (by bundle ID / worktree) and report which went live.
- 🖼️ Icon via the automated `mac-app-icons` pipeline (Grok neon-HUD artwork exists in v1
  `Resources/`).

---

## 🛠️ Stack — decide with me before scaffolding

**Recommended default** (least new risk, all my skills apply):
- 🍎 **UI shell:** Swift / AppKit + WKWebView, no Xcode project, pure `build.sh`
  (`url-mac-apps` patterns). Web UI in vanilla JS/TS + CSS (no build step preferred;
  a tiny bundler is acceptable if TypeScript is used).
- 🛰️ **Daemon:** Swift Package CLI (single language, no venv / system-Python path issues,
  easy `launchd` agent, `Codable` protocol shared with the shell). Talks to Spotify Web API
  directly with `URLSession` — no `spotipy`.
- 📡 **Protocol:** JSON over a local WebSocket (one socket per client) + a small HTTP surface
  for one-shot commands. Versioned. Documented in the repo.

**Acceptable alternatives** if I say so: Tauri/Rust shell with a Rust daemon; or keep a
Python daemon (spotipy) behind the same protocol. Electron only if there's a concrete reason.

Ask me these **before** writing code:
1. New repo, or a `v2/` tree beside v1?
2. Swift daemon (recommended) or keep Python for the daemon?
3. App name + bundle-ID prefix for v2 (v1 is `com.spotifydashboard.app`,
   now installed as `/Applications/Spotify Dashboard (old).app` — v2 takes `/Applications/Spotify Dashboard.app` and needs its own bundle ID, or v1's must change).

---

## 📡 Spotify facts to build against (from v1 scars)
- Scopes: playback read/modify, library read/modify, playlist read (private+collab) /
  modify (public+private), recently-played, follow read/modify.
- Poll playback every **10s**; on **429** honor `Retry-After` (+ buffer) and show a countdown;
  back off exponentially on other errors (cap 30s). Fallback chain: current playback →
  currently-playing → recently-played (paused).
- Playlist membership cache: warm **2s per playlist** in the background, **persist to disk
  per playlist as it lands**, report `warming | ready`. **Cache membership means real data**
  — never pre-seed an empty set (that silently kills the live fallback and reports the track
  as "saved nowhere").
- Album tracklists are immutable → cache per album. Play-count is not in the API — show
  durations instead.
- No active device → `start_playback` 404s; surface "start playback in Spotify first".
- "Latest release" = newest of albums + singles, EP = single with ≥4 tracks, market US,
  exclusion patterns from config.

---

## 🧪 Development experience (must-haves)
- 🧷 **Rebuild + relaunch in the background** from any worktree with one script; first
  install from a worktree reveals the bundle in Finder once; the app posts its own
  notification only when the launcher key is *newly* tied to that checkout.
- 🔄 Frontend edits = window reload; daemon edits = `daemonctl restart` (never "quit the app").
- 🎭 **Mock daemon** mode: canned Spotify state (nothing playing, rate-limited, 28-track
  album, warming cache) for UI work with no account traffic. Optional record/replay.
- 🧾 Loader / connection events logged to a gitignored file in the checkout — read it before
  guessing at startup bugs.
- 🔍 The worktree-menu check runs on every build, **above** any `exec` tail in `build.sh`.

---

## 📦 Phases & definition of done
1. **Daemon** — auth, poll, cache, protocol, `launchd` agent, `daemonctl` (start/stop/
   restart/status/logs). Done when two terminal clients can subscribe simultaneously and
   see the same track change once.
2. **Shell + one page** — Playlists grid, header, themes, Settings window, worktree menu,
   multi-window, background relaunch. Done when **two worktrees run side by side**, each
   its own app, both live against the one daemon, with no shared mutable files.
3. **Parity** — Tracker, Queue, both sidebars, editor, filter, shortcuts, KM hooks, icon,
   versioned About panel. Done when my v1 `config.json` imports unchanged and every v1
   behavior above is checked off.
4. **Cutover** — KM launchers retargeted, v1 left installed but dormant until I say remove.

Report each build in my approved shape (🏗️ line, launcher → worktree "label • age (clock)"
line, the bundle **folder** path alone in a code block). Never commit, merge, push, or
publish unless I ask — end with "ready to ship".
