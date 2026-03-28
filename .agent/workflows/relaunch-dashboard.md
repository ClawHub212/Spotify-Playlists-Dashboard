---
description: Relaunches the Spotify Dashboard desktop wrapper safely, clearing ghost instances.
---
# Relaunch Dashboard

Use this workflow to safely restart the Spotify Dashboard desktop application whenever backend (`app.py`), CSV databases, or internal configuration files are modified. 

The python backend often detaches into a ghost process if the macOS Swift application is killed unexpectedly. This workflow ensures the backend port `8888` is forcefully freed before launching the app again.

// turbo-all
1. Forcefully kill the Swift wrapper app.
```bash
killall "Spotify Dashboard"
```

2. Forcefully kill any ghost Python instances still bound to port `8888`.
```bash
lsof -i :8888 -t | xargs kill -9
```

3. Open the compiled Desktop application.
```bash
open "/Users/adriangrant/Dropbox/ClawHQ/Dev Work/Spotify-Playlists-Dashboard/desktop/SpotifyDashboard/build/Spotify Dashboard.app"
```
