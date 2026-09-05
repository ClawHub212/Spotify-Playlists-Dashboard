# Spotify Dashboard v2 — Rebuild Prompt

> **How to use:** open a fresh Claude Code session in `~/Development/Spotify Dashboard/`
> (the folder already exists and holds the design handoff) and paste everything below the
> line. The session should start with the `github-new-repo` skill (private, under
> `BoltHub973`, repo name `Spotify-Dashboard`). The old app stays untouched and runnable
> in `~/Development/Spotify Dashboard (old)` until v2 reaches parity.
>
> Written 09-04-26 from the v1 codebase, now retired as `~/Development/Spotify Dashboard (old)` (repo `BoltHub973/Spotify-Dashboard-old`, app `Spotify Dashboard (old).app`). The new app takes the plain `Spotify Dashboard` name, folder and `/Applications/Spotify Dashboard.app` path — the Keyboard Maestro launchers already point there.
>
> **Updated 09-05-26** with the final visual design: the **"Phosphor" Command Deck** handoff
> (`design_handoff_spotify_dashboard_v2/` — see § 🎨 Design). It replaces v1's look entirely
> and changes the Playlists page from a tile grid to a grouped chip deck.

---

## 🎯 What I want

Rebuild my **Spotify Dashboard** as a new app whose core design goal is:

> **One warm Spotify brain, many cheap clients.**
> Several git worktrees of this app must be able to run **at the same time**, each as its
> own window/app, without fighting over ports, files, or Spotify rate limits.

Feature parity with v1 is required (list below), but the *architecture* is the point —
v1 is a single Flask process + a single Swift wrapper that both assume "there is only ever
one of me", and that is exactly what v2 must not do.

The **look** is not up for interpretation: it is the high-fidelity handoff in
`design_handoff_spotify_dashboard_v2/` (§ 🎨 Design). Recreate it pixel-perfectly.

Load these skills before doing anything: `personal-software` (which pulls in
`NAGA-futuristic-design` + `app-versioning`), `url-mac-apps`, `mac-worktree-menu`,
`mac-app-icons`, `mac-app-rebuild-relaunch`, `spotify-web-api`, `keyboard-maestro`.
My global `~/.claude/CLAUDE.md` rules apply throughout (multi-window, window-like Settings,
background relaunch, no publishing, no auto-commit, build-report shape).
**Where the handoff and `NAGA-futuristic-design` disagree, the handoff wins** — NAGA only
fills the surfaces the mock doesn't show (Settings window, login screen, playlist editor,
⌘K action bar styling, toasts other than the follow toast).

---

## 🎨 Design — the "Phosphor" Command Deck handoff

**Read these first, in this order, before any UI code:**

1. `design_handoff_spotify_dashboard_v2/README.md` — the spec: every token, size, color,
   state and interaction, with exact values. Fidelity is **high**: colors, typography,
   spacing and states are final.
2. `design_handoff_spotify_dashboard_v2/Final.dc.html` — the three screens on one canvas
   (anchors `#5a` Playlists · `#5b` Tracker · `#5c` Queue). Open it in a browser with
   `support.js` beside it. Copy the inline SVG icon paths from here verbatim.
3. `support.js` — runtime for the design file only. Reference, never production code.

The files are **design references written in HTML**, not code to copy — recreate them in
the v2 stack. Keep the folder in the repo (`docs/design-handoff/` is fine) so the design
travels with the code. A second identical copy lives in
`~/Development/Spotify Dashboard (old)/design_handoff_spotify_dashboard_v2/`.

### The system in one paragraph
Dark base `#0b1410` with two radial accent washes; **per-page accent** — Playlists green
`#00ff88` (also the system color), Tracker purple `#b39bff`, Queue orange `#ff9a66`.
Fonts: **Chakra Petch** (wordmarks, H1/H2, group titles, buttons), **Rajdhani** (chips,
list rows, pills), **JetBrains Mono** (meta lines, timestamps, log text, small labels);
Manrope is a non-UI fallback only. Every page is the same skeleton: **header** (native
traffic lights → glowing page wordmark → spacer → page actions → repeat-one icon →
sidebar-eye icon; **no nav tabs, no theme toggle**) → **hero row** (album art · NOW PLAYING /
CURRENT ALBUM details · a wide **waveform that doubles as the progress bar**) → page
content → a one-line **LOG bar** at the bottom. Section titles sit **above** their cards in
the group's hue, cards are tinted gradient shells with a 30 % hue border, radius 15px. All
dates are **relative** ("2 min ago", "released 2 weeks ago"). Reference widths: Playlists
1400 · Tracker 1120 · Queue 1280 — use them as each page's default window width.

### Per-screen structure (values in the README)
- 📀 **Playlists (5a)** — header carries two extra buttons: **NEXT SHOW** (solid green,
  filled play triangle) and **NEXT SHOW PACK** (outlined, pistol icon). Hero: 184px art,
  `● NOW PLAYING 1:12 / 3:12` → H1 title → H2 artist → `SINGLE · released 2 weeks ago`
  → 84-bar waveform. Then the full-width **IN THIS TRACK** strip: one solid-green pill per
  playlist containing the track, each ending in a deep-red `✕` (click = remove). Then the
  **deck**: 3-column masonry (`column-count:3`) of **groups** — title in the group hue above
  a card holding a 54px **cover/mood image strip** and wrapped chips; groups alphabetical,
  no counts, no hints, no grid lines. Selected chip = tinted bg + accent border + white text
  + ` ✓`. Mock groups and hues: BEST ROTATION `#ffd166` · CLUB #OBFH `#ff5cb8` · DX
  `#4de3ff` · LATE NIGHT `#b39bff` · SHOW PACK `#ff9a66` · THE STACKS `#00ff88`.
  Hidden until summoned: **⌘K action bar** (search field with **no placeholder**, just a
  caret, plus NEW / EDIT / SPOTIFY buttons), `/` search, `L` log toggle.
- 🎯 **Tracker (5b)** — purple accent, 132px art, content column max-width 780 centered.
  Groups are **list cards** with an icon in the title (UNSIGNED = radar, accent-tinted card;
  MAJOR = trending-up, muted title `#8f86ab`, neutral card). Rows are Rajdhani 19px with a
  trailing `+`; the active row reads `TRACKED ✓`. A **follow toast** (user-check icon,
  "Now following <artist>", purple border + glow) floats bottom-right over content. The LOG
  bar gets a purple-tinted `+ followed <artist>` pill after the save pills.
- 📚 **Queue (5c)** — orange accent; hero reads **CURRENT ALBUM** with
  `ALBUM · released 3 years ago · 14 tracks · 49 min`. Content is a `1fr / 420px` grid:
  left a **2×2 group grid** (MALE person icon · FEMALE dress-figure · MISC asterisk · R&B
  music-note; inactive rows end `+ ALBUM`, the active one `14/14 IN ✓`); right an
  **always-visible TRACKLIST card** — outlined SAVE TO LIBRARY button, `# TITLE / TIME`
  header, numbered rows, the playing row highlighted orange with three animated EQ bars,
  a `··· 8 MORE` footer that expands. The tracklist is a fixed column here, **not** a
  slide-in sidebar. LOG bar: `<artist> <ALBUM> → <pill>`.

### Rules the mock encodes (don't "improve" them)
- **Card tint rule:** a group card is accent-tinted when it contains an active chip/row
  (UNSIGNED, MALE); otherwise neutral `rgba(255,255,255,.02)`. A group may be flagged
  `muted` in config to draw its title in the page's muted color (MAJOR, MISC, R&B).
- **Waveform = progress.** 84 bars, `flex:1` each, gap 2px, heights 10–60px from a fixed
  pseudo-random curve per track (the mock uses `|sin(i·1.7) + .6·sin(i·.53+2)|`); bars
  before the play head are bright accent with glow, the rest `rgba(255,255,255,.15)`.
  Interpolate the play head between 10s polls from `progress_ms` + a local clock; freeze
  it when paused.
- **Animation is mandatory:** NOW PLAYING dot pulses (2.4s, opacity 1→.35); EQ bars
  `scaleY(.25→1)` at .7 / .9 / 1.05s with negative delays. **Do not add a
  `prefers-reduced-motion` fallback** — I run macOS Reduce Motion globally and want this
  UI animated anyway.
- **Traffic lights are native.** The mock draws them inline; in the app use a transparent
  titlebar + full-size content view and pad the web header's left edge so the wordmark sits
  after the real buttons. Nothing in the web layer may draw fake ones.
- **Dynamic background:** the two radial washes may take the album art's dominant color
  (cached per track) instead of the fixed accent — keep the accent for text/borders.
- **Icons:** inline SVG, 24×24 viewBox, stroke-width 2, paths copied from the mock
  (play, pistol, repeat-1, eye, radar, trending-up, person, dress-figure, asterisk, music
  note, list, user-check, bookmark). No icon font, no emoji as icons.
- **Group cover images** are user-supplied 54px strips (real images in production, the
  mock's striped placeholders only until one is set). They are per-instance assets
  referenced from `config.json`, gitignored, never symlinked.

---

## 🧠 Architecture — non-negotiable

### 1. Daemon + thin UIs
- 🛰️ **One long-running daemon** owns: Spotify auth, the playback poll loop, the playlist
  membership cache, the save/follow **log**, and all Spotify writes. It runs once, on a
  **fixed** port, managed by a `launchd` agent. It survives UI relaunches.
- 🪟 **Each UI instance** (one per worktree) is a thin native shell + web UI that
  **subscribes** to the daemon. It never talks to Spotify directly.
- 📬 **Push, not poll:** the daemon broadcasts state (track changed, progress, membership
  changed, cache warming/ready, rate-limited, log event, auth_required) over a local
  socket / WebSocket. Clients render what they're told.
- 🔁 **Version handshake** on connect. A worktree that changes the daemon's protocol runs
  its own daemon instance on a derived port for testing; the stable daemon is never broken
  by an experiment.

### 2. Identity is derived from the checkout — never a constant
- 🔌 **UI port** = deterministic hash of the checkout path into a private range
  (e.g. 8900–8999). `main` gets a stable well-known port.
- 🏷️ **Bundle ID + app name** carry a per-worktree suffix at build time
  (`…dashboard.tracker-artist-follow`), so LaunchServices, AppleScript quit-by-id, and the
  Dock treat each worktree as a distinct app. Never two bundles with one ID.
- 🎨 **Visual identity per instance:** window title + menu-bar item labeled with the
  worktree's human name, so I always know which one I'm looking at. (The page wordmark in
  the header stays the page name — the instance name lives in the title bar and menu bar.)
- ⎇ **Worktree menu** (`mac-worktree-menu` skill) is in from day one: branch, path, code
  age, stale-binary warning, Open in Claude Code deep link
  (`claude://claude.ai/epitaxy/local_<id>`).

### 3. State split by ownership
| State | Owner | Lives in |
|---|---|---|
| 🔑 Spotify token (`.cache`) | daemon | daemon's app-support dir — **one** copy |
| 🧊 playlist membership cache | daemon | daemon's app-support dir, persisted across restarts |
| 💿 album tracklist cache, dominant-color cache | daemon | daemon's app-support dir |
| 🧾 LOG (last save/follow event per page) | daemon | daemon's app-support dir; broadcast to every client |
| ⚙️ `config.json` (pages, groups, playlists, show buttons) | UI instance | the checkout (gitignored), editable live from the UI |
| 🖼️ group cover/mood images | UI instance | the checkout (gitignored), paths in `config.json` |
| 🪟 window frames, theme, shortcuts, log visibility, Settings | UI instance | per-bundle-ID defaults / localStorage |
| 🧪 experiments | UI instance | a worktree may point at a *copy* of config to try breaking changes |

No file is ever symlinked from `main` into a worktree. No two processes write the same file.

### 4. OAuth exactly once
- Only the daemon has a Spotify redirect URI. New worktrees never require a change in the
  Spotify developer dashboard.
- Refresh tokens expire ~6 months (2026-07-20 policy). A dead token → daemon reports
  `auth_required`; every client shows a login screen that hands off to the daemon's login.

---

## ✨ Feature parity with v1 (must all exist) — in the new design

### Pages (one window, ⌘1 / ⌘2 / ⌘3 switch; each also has a route and a Keyboard Maestro launcher)
- 📀 **PLAYLISTS** — the grouped chip deck (§ Design 5a). Clicking a chip or an
  IN-THIS-TRACK `✕` toggles the current track in/out of that playlist (add also Likes the
  song; remove also un-Likes it if it's in no other dashboard playlist); the playlist's
  Spotify name is copied to the clipboard on add. ⌘-click (or a click while SPOTIFY mode is
  armed) opens the playlist in the Spotify desktop app. **NEXT SHOW / NEXT SHOW PACK**
  header buttons are one-click toggles of the current track into the two show playlists
  named in `config.json › show_buttons` (v1's holographic "NAGA NEXT SHOW" tiles; they also
  appear as normal chips in their group) — the solid button is lit while the track is in
  that playlist. NEW / EDIT / SPOTIFY / CANCEL live in the **⌘K action bar** with
  rebindable single-key shortcuts (N/E/S/C, Esc always cancels) that act while the bar is
  open; **live text filter** opens with `/`, F (rebindable) or ⌘F and filters chips across
  every group.
- 🎯 **TRACKER** — list cards per group (§ Design 5b). Adding here **also follows the
  track's main artist**; the toast says "Now following X" or **"Already following X"**
  (checked first — never claim a fresh follow), and the LOG bar shows the
  `+ followed X` pill only on a real follow.
- 📚 **QUEUE** — operates on the **whole current album** (§ Design 5c): rows add/remove
  every track of the album; the active row shows `n/n IN ✓` (a partial album shows the real
  fraction, e.g. `9/14 IN`). Hero shows album name, artist, `ALBUM · released <relative> ·
  <n> tracks · <m> min`. Add copies the playlist's Spotify name to the clipboard.

### Header (every page)
- Native traffic lights · page wordmark in the page accent with glow · page actions
  (Playlists only: NEXT SHOW, NEXT SHOW PACK) · **repeat-one toggle** with optimistic lock ·
  **sidebar auto-reveal eye**. No nav tabs, no theme toggle, no shortcut hints.

### Hero row (every page)
- Album art (184px on Playlists, 132px elsewhere) · pulsing status dot · title / artist ·
  relative-date meta line · the **waveform progress bar**. Nothing playing → art slot shows
  the last-known track dimmed, dot stops, waveform all-dim, meta reads `PAUSED · <relative>`
  from recently-played.

### IN THIS TRACK strip (Playlists)
- Full-width green panel listing every dashboard playlist that contains the track as a
  solid pill with a red `✕`. Empty state: the panel stays with the label and
  `— not saved anywhere` in mono muted; it never collapses (layout must not jump).

### LOG bar (every page, bottom, one line)
- `LOG · <relative time> · <artist, muted> <TRACK or ALBUM, bold> → <muted pill per target>`
  for the last save on that page; Tracker appends the follow pill. Toggle with `L`
  (persisted per instance). Overflow clips (`white-space:nowrap; overflow:hidden`), never
  wraps. Fed by the daemon's log event so every open window shows the same last action.

### Sidebars
- 🎤 **Artist sidebar** (Playlists + Tracker; right edge, slide-in, edge handle + ⌘S,
  pushes content): the artist's latest album/EP/single (excluding deluxe/remaster/live/
  anniversary by configurable patterns), release date, Follow / Unfollow, Save-to-Library,
  and an **ADD TO QUEUE** list of the Queue page's playlists (toggle the whole release
  in/out). Style it as a page-accent card in the handoff language.
- 💿 **Tracklist card** (Queue): the fixed 420px column from the mock — art is already in
  the hero, so the card is SAVE TO LIBRARY + the list. Playing track lit orange with the
  EQ bars (static when paused), auto-scrolled into view; hover ▶ / double-click plays that
  track in album context; disc headers for multi-disc albums; `··· n MORE` expands.
- 👁️ **Auto-reveal switch** (persisted): governs whether the artist sidebar opens *itself*
  on an add. Manual open always works. Every new auto-open path goes through the same
  guard. It shows on all three headers per the mock; on Queue it is inert until Queue has a
  slide-in surface (see the questions below).

### Playlist editor (in-app, writes config live)
- Add / edit / remove **groups** (name, hue, icon, muted flag, cover image, order) and
  **playlists** inside them; picker of my Spotify playlists with search; display name may
  differ from the Spotify name; `spotify_id` resolves duplicate names. Set the two show
  buttons. Config format — v2 groups replace v1's flat lists + dividers:

```json
{
  "pages": [
    { "id": "playlists", "label": "PLAYLISTS", "type": "deck", "route": "/", "accent": "#00ff88",
      "groups": [
        { "name": "BEST ROTATION", "hue": "#ffd166", "cover": "covers/best-rotation.jpg",
          "playlists": [
            { "display_name": "Best R&B 🏆 Faves", "spotify_name": "Exact Spotify Name" },
            { "display_name": "Workout", "spotify_name": "Dup Name", "spotify_id": "…" }
          ] }
      ] },
    { "id": "tracker", "label": "TRACKER", "type": "list", "route": "/tracker", "accent": "#b39bff",
      "groups": [
        { "name": "UNSIGNED", "icon": "radar", "playlists": [ { "…": "…" } ] },
        { "name": "MAJOR", "icon": "trending-up", "muted": true, "playlists": [ { "…": "…" } ] }
      ] },
    { "id": "queue", "label": "QUEUE", "type": "album-list", "route": "/queue", "accent": "#ff9a66",
      "groups": [
        { "name": "MALE", "icon": "person", "playlists": [ { "…": "…" } ] },
        { "name": "MISC", "icon": "asterisk", "muted": true, "playlists": [ { "…": "…" } ] }
      ] }
  ],
  "show_buttons": { "next_show": "NAGA NEXT SHOW ▶️", "next_show_pack": "NAGA NEXT SHOW - PACK" },
  "sidebar": { "exclude_patterns": ["deluxe","remaster","live","anniversary"],
               "queue_page_id": "queue" }
}
```

- **v1 import** (one command, run once): each labeled divider becomes a group with that
  name; playlists before the first divider go into an `UNGROUPED` group; a page with no
  dividers becomes one group; hues cycle the mock's six; icons/covers empty. I then regroup
  in the editor. The importer must accept my v1 file unchanged.

### Settings — ONE surface, window-like (my global standard)
- Most-of-screen by default, resizable, frame persisted, ⌘, opens, ⌘` toggles,
  ⌃G / ⌃A / ⌃S jump to General / Appearance / Shortcuts — all rebindable.
- Sections: **General** (app mode: regular vs menu-bar-only, float on top, global hotkeys
  per page, log bar visible), **Appearance** (theme grids — see below, group cover images),
  **Shortcuts** (⌘1/2/3 pages, ⌘K bar, `/` search, `L` log, N/E/S/C, sidebar toggle,
  section jumps, theme toggle ⌘⇧L — every one a recorder row with a live badge).
- No About section — About is the native panel, rendered
  `Version <semver> (<MM-DD-YY h:MM AM/PM · short-SHA>)` with the SHA linked to GitHub
  (`app-versioning` skill).

### Themes
- **Phosphor** (the handoff, dark) is the default and the only designed theme. Keep a
  **Daybreak** light theme derived from the same token sheet (all colors flow from one
  sheet; per-page accents unchanged; light surfaces replace the dark base and washes) so my
  two-surface rule still holds: a flat menu-bar Themes list with ☀/☾ glyphs and ✓, and
  Settings › Appearance swatch grids painted in each theme's colors. **The header carries no
  theme toggle** — switching is the menu bar, Settings, or ⌘⇧L. Fonts are the handoff's
  Chakra Petch / Rajdhani / JetBrains Mono (not Orbitron), bundled with the app so nothing
  loads from Google Fonts at runtime.

### Native app behaviors
- 🪟 Multi-window from day one (⌘⇧N, red close never quits). Each new window opens at its
  page's reference width.
- 🚀 **Instant launch:** because the daemon is already warm, a new window shows real data
  immediately — no loading screen gated on readiness flags, no warm-up wait.
- 🎹 Hand-built menu bar with a real Edit menu (⌘X/C/V/A, emoji palette) — text editing in
  the web view depends on it. The View menu carries Playlists ⌘1 / Tracker ⌘2 / Queue ⌘3,
  Toggle Log L, Action Bar ⌘K.
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
  a tiny bundler is acceptable if TypeScript is used). One token sheet, one skeleton
  template for the three pages, page accent set by a class on `body`.
- 🛰️ **Daemon:** Swift Package CLI (single language, no venv / system-Python path issues,
  easy `launchd` agent, `Codable` protocol shared with the shell). Talks to Spotify Web API
  directly with `URLSession` — no `spotipy`.
- 📡 **Protocol:** JSON over a local WebSocket (one socket per client) + a small HTTP surface
  for one-shot commands. Versioned. Documented in the repo.

**Acceptable alternatives** if I say so: Tauri/Rust shell with a Rust daemon; or keep a
Python daemon (spotipy) behind the same protocol. Electron only if there's a concrete reason.

**Decided:** new repo at `~/Development/Spotify Dashboard/` (already created, holds the
handoff), GitHub `BoltHub973/Spotify-Dashboard`, app `/Applications/Spotify Dashboard.app`.

Ask me these **before** writing code:
1. Swift daemon (recommended) or keep Python for the daemon?
2. Bundle-ID prefix for v2 (v1 is `com.spotifydashboard.app` and keeps it as
   `Spotify Dashboard (old).app` — v2 needs its own, e.g. `com.naga.spotify-dashboard`).
3. Confirm the NEXT SHOW / NEXT SHOW PACK header buttons are one-click toggles into the
   two show playlists (my reading of the mock) and which two playlists they are.
4. Queue's tracklist is a fixed column in the mock; does Queue also keep a slide-in artist
   sidebar (so the eye toggle does something there), or is the eye inert on Queue?
5. Show me the v1 → v2 config import result (groups per page) before the editor exists,
   so I can confirm the grouping matches the mock's six Playlists groups.

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
  durations instead. Album type for the badge/meta: `album` / `single` / `compilation`, and
  EP = single with ≥4 tracks.
- No active device → `start_playback` 404s; surface "start playback in Spotify first".
- "Latest release" = newest of albums + singles, market US, exclusion patterns from config.
- Follow state: check `following/contains` **before** following so the toast/log can say
  "Already following".

---

## 🧪 Development experience (must-haves)
- 🧷 **Rebuild + relaunch in the background** from any worktree with one script; first
  install from a worktree reveals the bundle in Finder once; the app posts its own
  notification only when the launcher key is *newly* tied to that checkout.
- 🔄 Frontend edits = window reload; daemon edits = `daemonctl restart` (never "quit the app").
- 🎭 **Mock daemon** mode: canned Spotify state (nothing playing, rate-limited, 28-track
  album, warming cache, the mock's own track "RUN THE WORLD" / album "LARGER THAN LIFE"
  so a screenshot can be diffed against `Final.dc.html`) for UI work with no account
  traffic. Optional record/replay.
- 📐 **Design check:** a headless render of each page in mock mode at its reference width,
  written to a gitignored `design-check/` folder, so I can compare against the handoff.
- 🧾 Loader / connection events logged to a gitignored file in the checkout — read it before
  guessing at startup bugs.
- 🔍 The worktree-menu check runs on every build, **above** any `exec` tail in `build.sh`.

---

## 📦 Phases & definition of done
1. **Daemon** — auth, poll, cache, log, protocol, `launchd` agent, `daemonctl` (start/stop/
   restart/status/logs). Done when two terminal clients can subscribe simultaneously and
   see the same track change once.
2. **Shell + Playlists** — the 5a screen pixel-perfect in mock mode (header buttons,
   hero + waveform, IN THIS TRACK, grouped deck, LOG bar, ⌘K bar), themes, Settings
   window, worktree menu, multi-window, background relaunch. Done when **two worktrees run
   side by side**, each its own app, both live against the one daemon, with no shared
   mutable files, and the Playlists render matches `Final.dc.html#5a`.
3. **Parity** — Tracker (5b) and Queue (5c) pixel-perfect, artist sidebar, tracklist card,
   editor, filter, shortcuts, KM hooks, icon, versioned About panel. Done when my v1
   `config.json` imports through the importer and every v1 behavior above is checked off.
4. **Cutover** — KM launchers retargeted, v1 left installed but dormant until I say remove.

Report each build in my approved shape (🏗️ line, launcher → worktree "label • age (clock)"
line, the bundle **folder** path alone in a code block). Never commit, merge, push, or
publish unless I ask — end with "ready to ship".
