# Spotify Playlist Dashboard — App Overview

## What It Does

This app runs as a local web dashboard that connects to your Spotify account. It detects whatever track you're currently playing (or most recently played) and shows you **which of your playlists already contain that track**.

You can then add or remove the track from any playlist with a single click — no need to switch between Spotify tabs or search through playlists manually.

---

## The Three Pages

### 🟢 Playlists Page (`/`)

Your main sorting workspace. All of your configured playlists are displayed in a **3-column grid**, organized into two sections separated by a glowing blue divider line:

#### ⬆️ Above the Line — **Active Playlists**

These are the playlists that **already contain** the currently playing track. They appear:

- At the **top** of the page
- With a **green glowing border**
- With a **pulsing checkmark** (✓) on the right side
- Sorted **alphabetically**

This tells you at a glance: _"This song is already saved in these playlists."_

#### ⬇️ Below the Line — **Inactive Playlists**

These are all your other playlists that **do not contain** the current track. They appear:

- **Below** the blue divider
- With a **subtle, muted appearance**
- Also sorted **alphabetically** across 3 columns

This tells you: _"You could add this song to any of these playlists."_

#### Clicking a Playlist

- **Click an inactive playlist** → adds the track to that playlist **and** likes the song
- **Click an active playlist** → removes the track from that playlist
  - If the track is **not in any other playlists** on any page → **unlikes the song** automatically
  - If the track **exists in other playlists** → keeps the song liked
- Either action also copies the Spotify playlist name to your clipboard

---

### 🟣 Tracker Page (`/tracker`)

A separate page for **monitoring artists** rather than sorting music. The Tracker uses a **single-column vertical layout** with a fixed order (not sorted alphabetically). Green divider lines separate logical sections.

Where the Playlists page answers _"Which playlists is this song in?"_, the Tracker page answers _"Is this artist already being tracked in my A&R playlists?"_

#### Clicking a Playlist

- **Click an inactive playlist** → adds the track to that playlist **and** likes the song
- **Click an active playlist** → removes the track from that playlist
  - If the track is **not in any other playlists** on any page → **unlikes the song** automatically
  - If the track **exists in other playlists** → keeps the song liked

---

### 🟠 Queue Page (`/queue`)

An **album-based** playlist management page. Instead of showing the currently playing track, this page displays the **currently playing album** with its cover art.

The Queue page uses a **single-column vertical layout** similar to the Tracker page, with divider lines separating sections.

#### Album-Based Operations

- **Click an inactive playlist** → adds **all tracks from the current album** to that playlist
  - Tracks are added but **NOT automatically liked** (unlike the other pages)
- **Click an active playlist** → removes **all tracks from the current album** from that playlist
  - Tracks are removed but **NOT automatically unliked**

This page is designed for bulk operations when you want to add or remove entire albums at once.

---

## The Header

All three pages share a compact header bar at the top that shows:

| Element                | Meaning                                                       |
| ---------------------- | ------------------------------------------------------------- |
| **Track/Album title**  | The song or album currently playing (or most recently played) |
| **Artist name**        | Below the track/album title                                   |
| **Album cover**        | Displayed in top-left corner on all pages                     |
| **Animated bars**      | Five small bars animate when music is actively playing        |
| **"Nothing Playing…"** | Shown when Spotify is paused or idle                          |

The dashboard automatically polls Spotify every **10 seconds** for track changes (slows to 60s when the browser tab is in the background).

---

## Dynamic Theming

The app features a **responsive design that adapts to the currently playing music**:

- **Real-time Color Extraction**: The app analyzes the album artwork of the current track to extract its dominant color.
- **Dynamic Backgrounds**: The entire background of the app shifts to a radial gradient based on the album's color palette, creating an immersive, glassmorphic aesthetic.
- **Visual Consistency**: High-resolution album artwork is displayed consistently in the top-left header across the Dashboard, Tracker, and Queue pages.

---

## Smart Unliking Behavior

The app intelligently manages your Liked Songs to keep them in sync with your playlists:

**When adding a track** (Playlists & Tracker pages only):

- ✅ Track is added to the selected playlist
- ✅ Track is automatically liked in Spotify

**When removing a track** (Playlists & Tracker pages only):

- ✅ Track is removed from the selected playlist
- 🔍 App checks if the track exists in **any other playlists** across all three pages
- If **NOT in any playlists** → ❌ Track is automatically unliked
- If **still in other playlists** → ✅ Track remains liked

**Queue page** (album operations):

- ➕ Adding albums: Tracks are added but **NOT liked**
- ➖ Removing albums: Tracks are removed but **NOT unliked**

---

## Configuration

Playlists are configured via CSV files in `data/csv/`:

| File                       | Controls            | Format                                               |
| -------------------------- | ------------------- | ---------------------------------------------------- |
| `Playlists to Display.csv` | Playlists page grid | `Dashboard Name, Spotify Playlist Name`              |
| `Tracker to Display.csv`   | Tracker page list   | Same format, with `DIVIDER` rows for section breaks  |
| `Queue to Display.csv`     | Queue page list     | `Name, Spotify Playlist Name` with `LINE BREAK` rows |

The **Dashboard Name** (or **Name**) is the short label shown in the UI. The **Spotify Playlist Name** must exactly match the playlist name in your Spotify library.

---

## Native Desktop App (v1.0.1)

The app is now wrapped as a native macOS application (`Spotify Dashboard (old).app`) for better integration:

- 🖥️ **Dock & App Switcher Support**: Proper app icon and process management.
- ⌨️ **Global Hotkeys**: Supports system-wide shortcuts.
- 🍎 **AppleScript Control**: Full automation support.

### Running the App

**Option 1: Native App (Recommended)**
Double-click `Spotify Dashboard (old).app` in the `desktop/SpotifyDashboard/build/` folder, or run:

```bash
./desktop/run.sh
```

**Option 2: Python Direct (Dev Mode)**

```bash
python3 app.py
```

Then open **http://127.0.0.1:8888** in your browser (if using Option 2).

On first run, you'll be redirected to Spotify to log in. After that, the auth token is cached locally.

---

## Automation & AppleScript Support

The app behaves like a native Mac app and supports AppleScript commands for advanced control and automation (e.g., via Raycast, Alfred, or Keyboard Maestro).

### Toggle Commands

Each command works as a smart toggle:

- If the app is **hidden**, it shows and navigates to that page.
- If the app is **already visible** on that page, it hides the app.
- If the app is **visible on a different page**, it navigates to the requested page without hiding.

**Toggle Playlists Page**

```applescript
tell application "Spotify Dashboard (old)" to toggle page "playlist"
```

**Toggle Tracker Page**

```applescript
tell application "Spotify Dashboard (old)" to toggle page "tracker"
```

**Toggle Queue Page**

```applescript
tell application "Spotify Dashboard (old)" to toggle page "queue"
```

### Explicit Control

You can also use `show page` and `hide app` separately if you want explicit control:

```applescript
-- Show only (never hides)
tell application "Spotify Dashboard (old)" to show page "playlist"

-- Hide only (never shows)
tell application "Spotify Dashboard (old)" to hide app
```
