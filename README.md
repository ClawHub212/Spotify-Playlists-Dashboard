# 🎵📋 Spotify Playlist Dashboard

> A configurable local web dashboard and native macOS app to manage, queue, and track any of your Spotify playlists — fully customizable around your own music taste.

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)]()
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/ClawHub212/Spotify-Playlists-Dashboard/pulls)
[![Python](https://img.shields.io/badge/Python-3.9+-yellow.svg)](https://python.org)

Built for anyone who curates Spotify playlists seriously — whether that's music for work, genre catalogues, A&R tracking, DJ sets, or anything else. Point it at your playlists and it becomes your control center.

---

## ✨ Features

- 🟢 **Playlist Grid** — See which of your configured playlists contain the currently playing track. Toggle any playlist with a single click; active ones glow at the top of the grid.
- 🎨 **Dynamic Backgrounds** — The interface extracts the dominant color from the current album art and applies it as a live background gradient.
- 🕵🏾 **Artist Sidebar** — Press `⌘S` to pull up the currently playing artist's latest release (albums and EPs), skipping deluxe or remaster editions. Configurable exclusion patterns.
- 💿 **Album-Level Queueing** — Add or remove entire albums to any of your "Queue" playlists in a single action from the sidebar.
- 📊 **Tracker Page** — A list-style view supporting dividers, designed for monitoring playlists over time (e.g., artist rosters, watchlists).
- 🔄 **Smart Polling** — Stays in sync with Spotify playback with graceful rate-limit handling and tab visibility awareness.
- ⚙️ **Fully Config-Driven** — All pages and playlists are defined in a single `config.json`. No code changes needed to add, remove, or rename a page.
- 🤝 **Follow Artist** — Instantly follow or unfollow the currently playing artist directly from the sidebar.
- 🖥️ **Native macOS Wrapper** — A Swift-based desktop app (`/desktop`) with zoom controls, a system-menu relaunch shortcut, and no browser chrome.

---

## 📋 Prerequisites

- **Python** 3.9+ — [Install here](https://www.python.org/downloads/)
- **Spotify Developer Account** — Needed to obtain a Client ID and Secret. [Create an app here](https://developer.spotify.com/dashboard).
- **macOS** *(optional)* — Required only if you want to build the native desktop wrapper.

---

## 🚀 Getting Started

### 1. Clone and install

```bash
git clone https://github.com/ClawHub212/Spotify-Playlists-Dashboard.git
cd Spotify-Playlists-Dashboard

pip install -r requirements.txt
```

### 2. Set up your Spotify credentials

```bash
cp .env.example .env
```

Open `.env` and fill in your credentials:

```env
SPOTIPY_CLIENT_ID=your_client_id_here
SPOTIPY_CLIENT_SECRET=your_client_secret_here
SPOTIPY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

> In your [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), add `http://127.0.0.1:8888/callback` as a Redirect URI for your app.

### 3. Configure your playlists

```bash
cp config.example.json config.json
```

Edit `config.json` to map your own Spotify playlists to the dashboard. Each **page** is a view (Playlists grid, Tracker list, Queue list) and each **playlist entry** maps a short display name to an exact Spotify playlist name:

```json
{
  "pages": [
    {
      "id": "playlists",
      "label": "PLAYLISTS",
      "type": "grid",
      "route": "/",
      "html": "playlists.html",
      "playlists": [
        { "display_name": "My Favorites", "spotify_name": "Your Exact Spotify Playlist Name" },
        { "display_name": "Chill Vibes",  "spotify_name": "Another Playlist Name" }
      ]
    }
  ],
  "sidebar": {
    "exclude_patterns": ["deluxe", "remaster"],
    "queue_page_id": "queue"
  }
}
```

See [`config.example.json`](config.example.json) for a full example with all three page types.

> **`config.json` is gitignored** — your playlist configuration stays private on your machine. Only `config.example.json` is tracked by git.

### 4. Launch

```bash
python3 app.py
```

Open `http://127.0.0.1:8888` in your browser. On first run you'll be redirected to Spotify to authorize the app.

| **Platform** | **Command** | **Notes** |
| ------------ | ----------- | --------- |
| Web | `python3 app.py` | Open `http://127.0.0.1:8888` |
| macOS wrapper | `open "desktop/SpotifyDashboard/build/Spotify Dashboard.app"` | Build the Xcode project first |

---

## ⚙️ Configuration Reference

### `config.json` structure

| **Field** | **Description** | **Required** |
| --------- | --------------- | ------------ |
| `pages` | Array of page definitions | ✅ |
| `pages[].id` | Unique page identifier used in routes (`/page/<id>`) | ✅ |
| `pages[].label` | Display label shown in the page header | ✅ |
| `pages[].type` | `"grid"` (Playlists), `"list"` (Tracker), or `"album-list"` (Queue) | ✅ |
| `pages[].html` | HTML file from `static/` to serve for this page | ✅ |
| `pages[].playlists` | Array of playlist entries (see below) | ✅ |
| `sidebar.exclude_patterns` | Release name substrings to ignore in the artist sidebar (case-insensitive) | ❌ |
| `sidebar.queue_page_id` | Which page ID to use as the sidebar's "Add to Queue" target | ❌ |

### Playlist entry fields

| **Field** | **Description** | **Required** |
| --------- | --------------- | ------------ |
| `display_name` | Label shown on the dashboard tile | ✅ |
| `spotify_name` | Exact name of the playlist in your Spotify library | ✅ |
| `spotify_id` | Explicit playlist ID — use this if you have duplicate playlist names | ❌ |
| `type: "divider"` | Inserts a visual separator (Tracker and Queue pages only) | ❌ |

### Environment variables

| **Variable** | **Description** | **Default** | **Required** |
| ------------ | --------------- | ----------- | ------------ |
| `SPOTIPY_CLIENT_ID` | Your Spotify app's Client ID | — | ✅ |
| `SPOTIPY_CLIENT_SECRET` | Your Spotify app's Client Secret | — | ✅ |
| `SPOTIPY_REDIRECT_URI` | OAuth callback URI | `http://127.0.0.1:8888/callback` | ✅ |

### Dynamic routes

Once the app is running, every page in your `config.json` is available at:

```
/page/<page_id>               → serves the page
/api/page/<page_id>/playlists → returns the playlist data as JSON
```

The legacy shortcuts `/`, `/tracker`, and `/queue` remain available as aliases for the default three-page layout.

---

## 💡 Usage Examples

### Toggling a playlist while listening

```
While a track is playing, click any playlist tile on the Playlists page.
```

The dashboard will:
- Add (or remove) the current track to that playlist via the Spotify API.
- Auto-like the track to your library on first add.
- Update the tile instantly without a page reload.
- Copy the playlist name to your clipboard.

### Checking an artist's latest release

```
Press ⌘S (or click the sidebar toggle) while any track is playing.
```

The sidebar will:
- Fetch the currently playing artist's discography.
- Skip releases matching your configured `exclude_patterns` (e.g. "deluxe", "remaster").
- Display the artist's most recent true album or EP with artwork and release date.
- Offer one-click library save or album queue add.

### Adding a new page to the dashboard

Add a new entry to `config.json` under `"pages"`, then visit `/page/<your-new-id>`:

```json
{
  "id": "workout",
  "label": "WORKOUT",
  "type": "grid",
  "route": "/workout",
  "html": "playlists.html",
  "playlists": [
    { "display_name": "Running", "spotify_name": "My Running Playlist" },
    { "display_name": "Lifting", "spotify_name": "My Lifting Playlist" }
  ]
}
```

No code changes — restart the server and your new page is live at `/page/workout`.

---

## 🤝 Contributing

Contributions are welcome! Whether you're fixing bugs, adding features, or improving documentation — your help makes this project better for everyone 🙌🏾

```bash
# Fork and clone the repository
git clone https://github.com/ClawHub212/Spotify-Playlists-Dashboard.git
cd Spotify-Playlists-Dashboard

# Create a feature branch
git checkout -b feature/your-feature-name

# Make your changes, then commit
git commit -m "Add: description of your changes"
git push origin feature/your-feature-name

# Open a Pull Request on GitHub
```

When contributing, note that `config.json` and `data/csv/` are gitignored — only `config.example.json` should be modified to illustrate schema changes.

---

## 📚 Additional Resources

- **[Spotipy Documentation](https://spotipy.readthedocs.io/)** — Python library for the Spotify Web API
- **[Spotify Developer Dashboard](https://developer.spotify.com/dashboard)** — Create and manage your Spotify app credentials
- **[Spotify Web API Reference](https://developer.spotify.com/documentation/web-api/)** — Full endpoint documentation

---

## 🐛 Issues & Support

Encountered a problem or have a suggestion?

- **Bug Reports & Feature Requests**: [Open an issue](https://github.com/ClawHub212/Spotify-Playlists-Dashboard/issues)

---

<div align="center">
  <sub>Built with ❤️ for music curators everywhere ✌🏾</sub>
</div>
