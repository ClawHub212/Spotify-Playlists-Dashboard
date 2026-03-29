# 🎵📊 Spotify Playlist Dashboard

![Spotify Playlist Dashboard Banner](docs/mockups/banner.png)

> A high-fidelity, local web dashboard and native macOS wrapper to seamlessly manage Spotify playlists, queue albums, and track your favorite artists.

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build Status](https://img.shields.io/badge/Build-Passing-brightgreen.svg)]()
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Transform your music management workflow with real-time tracking, dynamic aesthetics, and batch playlist operations.

---

## ✨ Features

- 🟢 **Playlists Management** — Instantly see which playlists contain your current track and toggle them with a click. Active playlists glow green at the top of the grid.
- 🎨 **Dynamic Aesthetics** — The interface automatically extracts the dominant color from the current track's album art to generate a beautiful, dynamic background gradient.
- 🕵🏾‍♂️ **Artist Tracking & Sidebar** — An expandable artist sidebar (⌘S) instantly fetches and displays the currently playing artist's latest main release (skipping deluxe editions).
- 💿 **Smart Queueing** — Manage your music by the album. Add or remove entire albums to specific 'Queue' playlists in a single action.
- 🔄 **Real-time Synchronization** — Uses smart polling to stay in sync with your Spotify playback, gracefully handling rate limits and tab visibility.
- 🖥️ **Native macOS Desktop App** — A dedicated Swift-based wrapper (`/desktop`) with built-in zoom controls and safe relaunch capabilities.

---

## 📋 Prerequisites

- **Python** 3.9+ — [Install here](https://www.python.org/downloads/)
- **Spotify Developer Account** — You need a valid Client ID and Secret
- **macOS** *(Optional)* — Required only if building the native desktop wrapper

---

## 🚀 Installation

### Quick Start

```bash
# Clone the repository
git clone https://github.com/<USERNAME>/<REPO>.git
cd <REPO>

# Install Python dependencies
pip install -r requirements.txt

# Create your environment variables file
cp .env.example .env

# Run the server
python app.py
```

| **Platform** | **Command** | **Notes** |
| ------------ | ----------- | --------- |
| Web | `python app.py` | Open `http://127.0.0.1:8888` |
| macOS | `open "desktop/SpotifyDashboard/build/Spotify Dashboard.app"` | Requires building the Xcode project first |

---

## 💡 Usage Examples

### Managing Playlists

```
"Click on a playlist name in the grid while a track is playing"
```

The tool will:
- Add the current track to the selected playlist via the Spotify API.
- Automatically save (Like) the track to your library.
- Copy the playlist's name to your clipboard for easy reference.
- Immediately update the UI to show the playlist as 'active'.

### Exploring an Artist's Latest Work

```
"Press ⌘S or click the Sidebar Toggle to open the Artist Sidebar"
```

The tool will:
- Query the Spotify API for the currently playing artist.
- Filter out any 'Deluxe' editions.
- Display the artist's true latest Album or EP, complete with release date and artwork.
- Show options to instantly queue the release or add it to your library.

---

## ⚙️ Configuration

Configure which playlists appear on the dashboard by editing the CSV files in `data/csv/`. Format: `Dashboard Name,Spotify Playlist Name`.

| **Variable** | **Description** | **Default** | **Required** |
| ------------ | --------------- | ----------- | ------------ |
| `SPOTIPY_CLIENT_ID` | Your Spotify developer Client ID | — | ✅ |
| `SPOTIPY_CLIENT_SECRET`| Your Spotify developer Client Secret | — | ✅ |
| `SPOTIPY_REDIRECT_URI` | Re-direct URI for OAuth flow | `http://127.0.0.1:8888/callback` | ✅ |

---

## 🤝 Contributing

Contributions are welcome! Whether you're fixing bugs, adding features, or improving documentation — your help makes this project better for everyone 🙌🏾

**Quick Start for Contributors:**

```bash
# Fork and clone the repository
git clone https://github.com/<USERNAME>/<REPO>.git
cd <REPO>

# Create a feature branch
git checkout -b feature/your-feature-name

# Make your changes and test them

# Commit and push
git commit -m "Add: description of your changes"
git push origin feature/your-feature-name

# Open a Pull Request on GitHub
```

---

## 📚 Additional Resources

- **[Python Spotipy Docs](https://spotipy.readthedocs.io/)** — Spotify Web API Python library
- **[Spotify Web API](https://developer.spotify.com/documentation/web-api/)** — Official reference

---

## 🐛 Issues & Support

Encountered a problem or have a suggestion?

- **Bug Reports**: [Open an issue](https://github.com/<USERNAME>/<REPO>/issues/new?template=bug_report.md)
- **Feature Requests**: [Request a feature](https://github.com/<USERNAME>/<REPO>/issues/new?template=feature_request.md)

---

<div align="center">
  <sub>Built with ❤️ for the music curator community & stay organized ✌🏾</sub>
</div>
