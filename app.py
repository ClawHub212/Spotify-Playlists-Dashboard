import os
import re
import json
import time
import subprocess
import threading
from flask import Flask, jsonify, request, send_from_directory, redirect, session
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from spotipy.exceptions import SpotifyOauthError
from dotenv import load_dotenv
from PIL import Image
import requests
from io import BytesIO

load_dotenv()

# ─────────────────────────────────────────────
# Parent-death watchdog
# ─────────────────────────────────────────────
# When the desktop app that spawned us dies without cleanup (SIGKILL, crash),
# this process gets reparented to launchd (ppid 1) and would otherwise keep
# port 8888 with stale code, hijacking the next app launch. Exit instead.
# Guarded on the *initial* ppid so a backend deliberately launched by launchd
# would not immediately kill itself.
_initial_ppid = os.getppid()

def _watch_parent():
    while True:
        time.sleep(3)
        if os.getppid() == 1 and _initial_ppid != 1:
            print("Parent process died; shutting down backend to free port 8888.")
            os._exit(0)

threading.Thread(target=_watch_parent, daemon=True).start()

app = Flask(__name__, static_folder='static')

# Configuration
CONFIG_FILE = "config.json"
SCOPE = "user-read-playback-state user-modify-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-recently-played user-follow-read user-follow-modify"

# Spotify Auth Manager
def get_auth_manager():
    return SpotifyOAuth(scope=SCOPE, open_browser=False, show_dialog=True)

sp = spotipy.Spotify(auth_manager=get_auth_manager(), requests_timeout=10, status_retries=0, retries=0)


def clear_cached_token():
    """Discard the cached Spotify token so the next request forces a fresh login."""
    try:
        cache_path = get_auth_manager().cache_handler.cache_path
        if os.path.exists(cache_path):
            os.remove(cache_path)
            print(f"Cleared cached Spotify token at {cache_path}.")
    except Exception as e:
        print(f"Warning: could not clear cached token: {e}")


def is_authenticated():
    """Return True if a valid Spotify token is available (refreshing if needed).

    As of Spotify's 6-month refresh-token expiration (enforced for existing apps
    on 2026-07-20), a refresh token can expire and the token endpoint returns
    400 invalid_grant, which spotipy raises as SpotifyOauthError. Per Spotify's
    guidance we catch it, do NOT retry, discard the dead token, and report
    unauthenticated so callers can send the user back through the login flow.
    """
    auth_manager = get_auth_manager()
    try:
        return bool(auth_manager.validate_token(auth_manager.get_cached_token()))
    except SpotifyOauthError as e:
        reason = getattr(e, 'error', None) or e
        print(f"Spotify refresh token expired/invalid ({reason}); clearing token for re-login.")
        clear_cached_token()
        return False


# Global state populated from config.json
app_config = {}                  # The loaded config dict
page_playlists = {}              # page_id -> list of resolved playlist dicts
playlist_tracks_cache = {}       # Playlist ID -> Set of Track URIs
user_spotify_playlists = []      # Cached list of the user's Spotify playlists (for the editor picker)
config_lock = threading.Lock()   # Guards config.json read-modify-write cycles

# Backward-compat aliases (populated after config load)
dashboard_playlists = []
tracker_playlists = []
queue_playlists = []

# Loading state: tracks whether initial playlist load is still in progress
loading_state = "loading"

# ─────────────────────────────────────────────
# Playlist-track cache persistence
# ─────────────────────────────────────────────
# The background warm-up re-fetches every playlist at ~2s each, so a fresh
# launch would otherwise spend minutes unable to say which playlists contain
# the current track. The cache is persisted across restarts: loaded at startup
# (instantly warm, at worst slightly stale) and rewritten as the warm-up
# re-fetches each playlist and as tiles are toggled.
PLAYLIST_CACHE_FILE = "playlist_cache.json"
playlist_cache_file_lock = threading.Lock()

# Number of background cache-fill workers still running. While > 0 (or the
# initial page load hasn't finished), disk-loaded entries may be stale and
# new playlists may be missing — /api/check-playlists reports this via the
# X-Cache-State header so the frontend keeps re-checking until data is fresh.
cache_fill_pending = 0
cache_fill_lock = threading.Lock()


def load_playlist_cache_from_disk():
    try:
        with open(PLAYLIST_CACHE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for pid, uris in data.items():
            playlist_tracks_cache[pid] = set(uris)
        print(f"Loaded persisted track cache for {len(data)} playlists.")
    except FileNotFoundError:
        print("No persisted playlist cache yet (first run).")
    except Exception as e:
        print(f"Ignoring unreadable playlist cache: {e}")


def save_playlist_cache_to_disk():
    try:
        with playlist_cache_file_lock:
            snapshot = {pid: list(uris) for pid, uris in list(playlist_tracks_cache.items())}
            # Worktrees share main's cache via a symlink; resolve it first and
            # replace the real file atomically so the link itself survives.
            real = os.path.realpath(PLAYLIST_CACHE_FILE)
            tmp = real + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(snapshot, f)
            os.replace(tmp, real)
    except Exception as e:
        print(f"Warning: could not persist playlist cache: {e}")


def start_cache_fill_thread(page_id, playlists, tag):
    # Bump the pending counter here, not in the thread, so a check-playlists
    # request between spawn and thread start still sees "warming".
    global cache_fill_pending
    with cache_fill_lock:
        cache_fill_pending += 1
    threading.Thread(target=populate_page_cache,
                     args=(page_id, playlists, tag),
                     daemon=True).start()


def load_config():
    """Load config.json. Returns the parsed dict or empty dict on error."""
    global app_config
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            app_config = json.load(f)
        print(f"Loaded config from {CONFIG_FILE} ({len(app_config.get('pages', []))} pages)")
    except FileNotFoundError:
        print(f"ERROR: {CONFIG_FILE} not found. Copy config.example.json to config.json and configure your playlists.")
        app_config = {}
    except Exception as e:
        print(f"ERROR reading {CONFIG_FILE}: {e}")
        app_config = {}
    return app_config


def load_page_playlists(page_config, sp_name_to_id):
    """Resolve a single page's playlists from config against Spotify data.
    Returns a list of playlist dicts ready for the frontend."""
    resolved = []
    seen_names = set()

    for item in page_config.get('playlists', []):
        # Handle dividers. An optional "label" names the section that follows
        # (rendered as a vertical rail on the Tracker/Queue pages); without one
        # the divider renders as a plain separator line.
        if item.get('type') == 'divider':
            resolved.append({
                'name': 'DIVIDER',
                'spotify_name': 'DIVIDER',
                'id': 'DIVIDER',
                'is_divider': True,
                'label': (item.get('label') or '').strip() or None
            })
            continue

        d_name = item.get('display_name', '').strip()
        s_name = item.get('spotify_name', '').strip()
        if not d_name or not s_name:
            continue

        # Dedup
        if d_name in seen_names:
            continue

        # Resolve ID: explicit from config takes priority, then lookup by name
        pid = item.get('spotify_id') or sp_name_to_id.get(s_name)

        if not pid:
            print(f"Warning: Playlist '{s_name}' not found in your Spotify library.")
            continue

        # NOTE: no cache slot is pre-seeded here. Membership in
        # playlist_tracks_cache means "we have real data for this playlist"
        # (from the warm-up or the persisted cache) — an empty placeholder
        # would make /api/check-playlists trust it and answer "not saved
        # anywhere" for the whole warm-up (the 08-28-26 launch bug).

        resolved.append({
            'name': d_name,
            'spotify_name': s_name,
            'id': pid,
            'is_divider': False
        })
        seen_names.add(d_name)

    return resolved


def populate_page_cache(page_id, playlists, label=None):
    """Background cache population for a single page's playlists.

    Always run via start_cache_fill_thread (which bumps cache_fill_pending);
    the counter is decremented here when the fill finishes."""
    global playlist_tracks_cache, cache_fill_pending
    tag = label or page_id
    print(f"Starting background cache ({tag})...")
    count = 0
    try:
        for pl in playlists:
            if pl.get('is_divider'):
                continue
            pid = pl['id']
            sname = pl['spotify_name']
            try:
                track_uris = set()
                results = sp.playlist_items(pid, additional_types=['track'], limit=100, fields='next,items(track(uri))')
                def add_items(items):
                    for item in items:
                        if item.get('track') and item['track'].get('uri'):
                            track_uris.add(item['track']['uri'])
                add_items(results['items'])
                while results['next']:
                    results = sp.next(results)
                    add_items(results['items'])
                playlist_tracks_cache[pid] = track_uris
                # Persist per playlist so a mid-warm-up quit still leaves the
                # next launch mostly warm.
                save_playlist_cache_to_disk()
                count += 1
                time.sleep(2)  # Respect rate limits
            except Exception as e:
                print(f"Error caching {tag} playlist {sname}: {e}")
    finally:
        with cache_fill_lock:
            cache_fill_pending -= 1
    print(f"{tag} cache complete. Cached {count}/{len([p for p in playlists if not p.get('is_divider')])} playlists.")


def fetch_all_user_playlists():
    """Fetch all user playlists from Spotify once. Returns list of playlist dicts or None on error."""
    global user_spotify_playlists
    print("Fetching user playlists from Spotify...")
    spotify_playlists = []
    try:
        results = sp.current_user_playlists(limit=50)
        spotify_playlists.extend(results['items'])
        while results['next']:
            results = sp.next(results)
            spotify_playlists.extend(results['items'])
    except Exception as e:
        print(f"Error fetching playlists: {e}")
        return None
    print(f"Fetched {len(spotify_playlists)} user playlists from Spotify.")
    user_spotify_playlists = spotify_playlists
    return spotify_playlists


def save_config():
    """Persist app_config back to config.json (emoji-safe, pretty-printed)."""
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(app_config, f, indent=2, ensure_ascii=False)
        f.write('\n')


def get_page_config(page_id):
    return next((p for p in app_config.get('pages', []) if p['id'] == page_id), None)


def resolve_spotify_playlist(spotify_name, spotify_id):
    """Resolve a Spotify playlist reference to (id, name).

    An explicit id wins; otherwise the name is looked up in the cached user
    playlists, refreshing the cache once on a miss."""
    if spotify_id:
        cached = next((p for p in user_spotify_playlists if p['id'] == spotify_id), None)
        return spotify_id, (cached['name'] if cached else spotify_name) or spotify_id
    pid = next((p['id'] for p in user_spotify_playlists if p['name'] == spotify_name), None)
    if not pid:
        fetch_all_user_playlists()
        pid = next((p['id'] for p in user_spotify_playlists if p['name'] == spotify_name), None)
    return pid, spotify_name


def load_all_pages(spotify_playlists):
    """Load and resolve playlists for every page defined in config.json."""
    global page_playlists, dashboard_playlists, tracker_playlists, queue_playlists

    sp_name_to_id = {p['name']: p['id'] for p in spotify_playlists}

    for page in app_config.get('pages', []):
        page_id = page['id']
        resolved = load_page_playlists(page, sp_name_to_id)
        page_playlists[page_id] = resolved
        print(f"Loaded {len([p for p in resolved if not p.get('is_divider')])} playlists for page '{page_id}'.")

        # Start background cache population per page
        start_cache_fill_thread(page_id, resolved, page.get('label', page_id))

    # Backward-compat aliases for existing API endpoints & frontend JS
    dashboard_playlists = page_playlists.get('playlists', [])
    tracker_playlists = page_playlists.get('tracker', [])
    queue_playlists = page_playlists.get('queue', [])


# Helper to load playlists only if authorized
def safe_load_playlists():
    global loading_state
    try:
        load_config()
        if not app_config.get('pages'):
            print("No pages defined in config. Nothing to load.")
            return

        if is_authenticated():
            print("Valid token found. Loading playlists...")
            spotify_playlists = fetch_all_user_playlists()
            if spotify_playlists is not None:
                load_all_pages(spotify_playlists)
            else:
                print("Failed to fetch user playlists from Spotify.")
        else:
            print("No valid token found. Skipping initial playlist load.")
    except Exception as e:
        print(f"Error checking token/loading playlists: {e}")
        import traceback
        traceback.print_exc()
    finally:
        loading_state = "done"
        print(f"Loading state set to: {loading_state}")

# Initial Load Attempt — run in background so Flask starts serving immediately.
# The persisted cache loads first (synchronously — it's a local file read) so
# the very first /api/check-playlists already knows what's saved where.
load_playlist_cache_from_disk()
threading.Thread(target=safe_load_playlists, daemon=True).start()

# ─────────────────────────────────────────────
# Health check endpoint (fast, no auth required)
# ─────────────────────────────────────────────
@app.route('/health')
def health():
    # Flask serving at all means the app can load: /api/current-track works the
    # moment auth is valid, and the playlist endpoints report their own warm-up
    # via the X-Loading-State header. Holding /health at 503 until every
    # playlist was fetched made the desktop loading screen wait on the slowest
    # part of startup before the current track could even be requested.
    return jsonify({"status": "ok", "playlists": loading_state}), 200

# Auth status endpoint — lets the desktop app check whether the user has a
# valid Spotify token before trying to load the dashboard in the WebView.
@app.route('/api/auth-status')
def auth_status():
    try:
        return jsonify({"authenticated": is_authenticated()})
    except Exception as e:
        return jsonify({"authenticated": False, "error": str(e)}), 200

# ─────────────────────────────────────────────
# Generic page route — works for any page defined in config.json
# e.g. /page/playlists, /page/tracker, /page/queue, /page/my-new-page
# ─────────────────────────────────────────────
@app.route('/page/<page_id>')
def serve_page(page_id):
    if not is_authenticated():
        return redirect('/login')
    # Look up the HTML file for this page from config
    page_cfg = next((p for p in app_config.get('pages', []) if p['id'] == page_id), None)
    if not page_cfg:
        return jsonify({"error": f"Page '{page_id}' not found in config"}), 404
    html_file = page_cfg.get('html', f'{page_id}.html')
    response = send_from_directory('static', html_file)
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

# Generic playlist API — works for any page_id in config.json
@app.route('/api/page/<page_id>/playlists')
def get_page_playlists_api(page_id):
    playlists = page_playlists.get(page_id, [])
    response = jsonify(playlists)
    response.headers['X-Loading-State'] = loading_state
    return response


@app.route('/api/spotify-playlists')
def get_spotify_playlists():
    """The user's Spotify playlists (name + id), for the playlist-editor picker."""
    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401
    if request.args.get('refresh') == '1' or not user_spotify_playlists:
        fetch_all_user_playlists()
    items = [{'name': p['name'], 'id': p['id']} for p in user_spotify_playlists]
    items.sort(key=lambda p: p['name'].lower())
    return jsonify(items)


@app.route('/api/page/<page_id>/playlists', methods=['POST', 'PUT', 'DELETE'])
def edit_page_playlists(page_id):
    """Create, update, or delete a playlist item on a page.

    POST   {display_name, spotify_name, spotify_id}
    PUT    {original_display_name, display_name, spotify_name, spotify_id}
    DELETE {display_name}

    Persists to config.json and updates the in-memory resolved lists so the
    change is live immediately (no restart needed). Only the dashboard config
    is touched — the Spotify playlists themselves are never modified here.
    """
    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    data = request.json or {}

    with config_lock:
        page_cfg = get_page_config(page_id)
        if not page_cfg:
            return jsonify({"error": f"Page '{page_id}' not found in config"}), 404
        items = page_cfg.setdefault('playlists', [])
        resolved_list = page_playlists.get(page_id)

        def find_item(name):
            return next((i for i in items if i.get('type') != 'divider'
                         and i.get('display_name', '').strip() == name), None)

        if request.method == 'DELETE':
            display_name = (data.get('display_name') or '').strip()
            item = find_item(display_name)
            if not item:
                return jsonify({"error": f"'{display_name}' not found on this page"}), 404
            items.remove(item)
            if resolved_list is not None:
                entry = next((e for e in resolved_list if e['name'] == display_name), None)
                if entry:
                    resolved_list.remove(entry)
            save_config()
            return jsonify({"success": True})

        display_name = (data.get('display_name') or '').strip()
        spotify_name = (data.get('spotify_name') or '').strip()
        spotify_id = (data.get('spotify_id') or '').strip()
        if not display_name:
            return jsonify({"error": "Display name is required"}), 400
        if not (spotify_name or spotify_id):
            return jsonify({"error": "A Spotify playlist is required"}), 400

        pid, resolved_name = resolve_spotify_playlist(spotify_name, spotify_id)
        if not pid:
            return jsonify({"error": f"Playlist '{spotify_name}' not found in your Spotify library"}), 404

        def start_cache_fill(entry, tag):
            # No empty pre-seed: until the fill lands, check-playlists falls
            # back to a live check for this one playlist.
            start_cache_fill_thread(page_id, [entry], tag)

        if request.method == 'POST':
            if find_item(display_name):
                return jsonify({"error": f"'{display_name}' already exists on this page"}), 409
            items.append({'display_name': display_name,
                          'spotify_name': resolved_name,
                          'spotify_id': pid})
            if resolved_list is not None:
                new_entry = {'name': display_name, 'spotify_name': resolved_name,
                             'id': pid, 'is_divider': False}
                resolved_list.append(new_entry)
                start_cache_fill(new_entry, f"{page_id}:new")
            save_config()
            return jsonify({"success": True})

        # PUT
        original = (data.get('original_display_name') or '').strip()
        item = find_item(original)
        if not item:
            return jsonify({"error": f"'{original}' not found on this page"}), 404
        dup = find_item(display_name)
        if dup is not None and dup is not item:
            return jsonify({"error": f"'{display_name}' already exists on this page"}), 409
        item['display_name'] = display_name
        item['spotify_name'] = resolved_name
        item['spotify_id'] = pid
        if resolved_list is not None:
            entry = next((e for e in resolved_list if e['name'] == original), None)
            if entry:
                id_changed = entry['id'] != pid
                entry.update({'name': display_name, 'spotify_name': resolved_name, 'id': pid})
                if id_changed:
                    start_cache_fill(entry, f"{page_id}:edit")
        save_config()
        return jsonify({"success": True})

# ─────────────────────────────────────────────
# Backward-compat aliases — your existing local URLs keep working
# ─────────────────────────────────────────────
@app.route('/')
def index():
    if not is_authenticated():
        return redirect('/login')
    response = send_from_directory('static', 'playlists.html')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route('/settings')
def settings_page():
    # Preferences (shortcuts, appearance, app mode) — hosted by the native
    # Settings window and openable in a browser tab. Needs no Spotify auth.
    response = send_from_directory('static', 'settings.html')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route('/tracker')
def tracker():
    return serve_page('tracker')

@app.route('/api/tracker-playlists')
def get_tracker_playlists():
    return get_page_playlists_api('tracker')

@app.route('/queue')
def queue():
    return serve_page('queue')

@app.route('/api/queue-playlists')
def get_queue_playlists():
    return get_page_playlists_api('queue')

@app.route('/api/playlists')
def get_playlists():
    return get_page_playlists_api('playlists')

@app.route('/login')
def login():
    auth_manager = get_auth_manager()
    auth_url = auth_manager.get_authorize_url()
    return redirect(auth_url)

@app.route('/callback')
def callback():
    auth_manager = get_auth_manager()
    code = request.args.get('code')
    if code:
        try:
            auth_manager.get_access_token(code)
        except SpotifyOauthError as e:
            # Bad/expired authorization code — clear any stale token and re-login.
            print(f"Authorization code exchange failed ({getattr(e, 'error', None) or e}); redirecting to login.")
            clear_cached_token()
            return redirect('/login')
        # Reload playlists after successful authentication
        load_config()
        spotify_playlists = fetch_all_user_playlists()
        if spotify_playlists is not None:
            load_all_pages(spotify_playlists)
    return redirect('/')

@app.route('/<path:path>')
def serve_static(path):
    response = send_from_directory('static', path)
    # Prevent WKWebView from caching stale JS/CSS/HTML files
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

# Short-lived cache of the current-track payload. Every page is a full
# document load that polls this endpoint on arrival, and each uncached hit
# costs two Spotify round-trips — so switching pages felt like the track had
# to be "re-recognized". Within the TTL, page switches are served instantly.
current_track_cache = {"payload": None, "ts": 0.0}
CURRENT_TRACK_TTL = 5.0  # seconds


def invalidate_current_track_cache():
    current_track_cache["ts"] = 0.0


@app.route('/api/current-track')
def get_current_track():
    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    if time.time() - current_track_cache["ts"] < CURRENT_TRACK_TTL:
        return jsonify(current_track_cache["payload"])

    try:
        current = sp.current_playback()
        if current and current.get('item'):
            track = current['item']
            is_playing = current['is_playing']
            repeat_state = current.get('repeat_state', 'off')
        else:
            # Fallback to current_user_playing_track
            current_track = sp.current_user_playing_track()
            if current_track and current_track.get('item'):
                track = current_track['item']
                is_playing = current_track['is_playing']
                repeat_state = 'off'
            else:
                # Fallback to recently played
                recent = sp.current_user_recently_played(limit=1)
                if recent and recent['items']:
                    track = recent['items'][0]['track']
                    is_playing = False
                    repeat_state = 'off'
                else:
                    current_track_cache["payload"] = None
                    current_track_cache["ts"] = time.time()
                    return jsonify(None)
        
        # Check if liked
        # current_user_saved_tracks_contains returns list of bools
        is_liked = sp.current_user_saved_tracks_contains([track['id']])[0]

        # Get album info
        album = track.get('album') or {}
        album_name = album.get('name', 'Unknown Album')
        album_cover = album['images'][0]['url'] if album.get('images') else None
        album_id = album.get('id')
        album_total_tracks = album.get('total_tracks')
        album_release_date = album.get('release_date')

        payload = {
            "id": track['id'],
            "name": track['name'],
            "artist": ", ".join([artist['name'] for artist in track['artists']]),
            "artist_id": track['artists'][0]['id'] if track.get('artists') else None,
            "album": album_name,
            "album_id": album_id,
            "album_cover": album_cover,
            "album_total_tracks": album_total_tracks,
            "album_release_date": album_release_date,
            "is_liked": is_liked,
            "is_playing": is_playing,
            "repeat_state": repeat_state,
            "uri": track['uri']
        }
        current_track_cache["payload"] = payload
        current_track_cache["ts"] = time.time()
        return jsonify(payload)

    except spotipy.exceptions.SpotifyException as e:
        if e.http_status == 429:
            print(f"Rate limit hit: {e}")
            retry_after = int(e.headers.get('Retry-After', 5))
            return jsonify({"error": "Rate limit", "retry_after": retry_after}), 429
        print(f"Spotify error getting current track: {e}")
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        print(f"Error getting current track: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/check-playlists')
def check_playlists():
    track_uri = request.args.get('track_uri') # Using URI or ID
    if not track_uri:
        return jsonify([])

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    # Standardize to URI
    if not track_uri.startswith('spotify:track:'):
        track_uri = f'spotify:track:{track_uri}'

    active_ids = []
    playlists_to_check_live = []

    # Combine dashboard, tracker, and queue playlists for checking
    all_playlists = dashboard_playlists + [p for p in tracker_playlists if not p.get('is_divider')] + [p for p in queue_playlists if not p.get('is_divider')]

    # In the first seconds after launch the page lists may not be resolved yet
    # (safe_load_playlists still fetching from Spotify) — but the persisted
    # track cache is already loaded. Answer from it directly so the very first
    # check knows what's saved where; ids for playlists no longer configured
    # are harmless (the frontend matches ids against rendered tiles).
    if not all_playlists:
        active = [pid for pid, uris in list(playlist_tracks_cache.items()) if track_uri in uris]
        response = jsonify(active)
        response.headers['X-Cache-State'] = 'warming'
        return response

    # First check cache. Cache membership means real data (warm-up fetch or
    # the persisted cache file) — playlists without an entry get a live check.
    seen_pids = set()
    for pl in all_playlists:
        pid = pl['id']
        if pid in seen_pids:  # a playlist can appear on several pages
            continue
        seen_pids.add(pid)
        if pid in playlist_tracks_cache:
            if track_uri in playlist_tracks_cache[pid]:
                active_ids.append(pid)
        else:
            # Cache not ready for this playlist, need to check live
            playlists_to_check_live.append((pid, pl['spotify_name']))

    # For playlists not in cache, do a live check — but bounded: on a
    # first-ever run nothing is cached yet and live-checking all ~80
    # playlists would hammer the API. Anything beyond the cap is skipped;
    # the "warming" X-Cache-State below makes the frontend re-check as the
    # background warm-up progressively fills the cache.
    MAX_LIVE_CHECKS = 8
    skipped_live = max(0, len(playlists_to_check_live) - MAX_LIVE_CHECKS)
    playlists_to_check_live = playlists_to_check_live[:MAX_LIVE_CHECKS]
    if playlists_to_check_live:
        print(f"Cache incomplete, checking {len(playlists_to_check_live)} playlists live ({skipped_live} deferred to warm-up)...")
        for pid, sname in playlists_to_check_live:
            try:
                # Check if track is in this playlist
                results = sp.playlist_items(pid, additional_types=['track'], limit=100, fields='items(track(uri))')

                # Check first page
                for item in results['items']:
                    if item.get('track') and item['track'].get('uri') == track_uri:
                        active_ids.append(pid)
                        break
                else:
                    # Check remaining pages if not found
                    while results.get('next') and pid not in active_ids:
                        results = sp.next(results)
                        for item in results['items']:
                            if item.get('track') and item['track'].get('uri') == track_uri:
                                active_ids.append(pid)
                                break
            except Exception as e:
                print(f"Error checking playlist {sname} live: {e}")

    response = jsonify(active_ids)
    warming = loading_state != "done" or cache_fill_pending > 0 or skipped_live > 0
    response.headers['X-Cache-State'] = 'warming' if warming else 'ready'
    return response


@app.route('/api/extract-color')
def get_extracted_color():
    url = request.args.get('url')
    if not url:
        return jsonify({'r': 0, 'g': 0, 'b': 0, 'error': 'No URL provided'})

    try:
        # Add User-Agent to avoid blocking
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
        }
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
             return jsonify({'r': 0, 'g': 0, 'b': 0, 'error': f"Failed to fetch image: {response.status_code}"})

        img = Image.open(BytesIO(response.content))
        # Resize to 1x1 to get average color
        img = img.resize((1, 1)).convert('RGB')
        color = img.getpixel((0, 0))
        # Log success
        print(f"Extracted color for {url}: {color}")
        return jsonify({'r': color[0], 'g': color[1], 'b': color[2]})
    except Exception as e:
        print(f"Error extracting color: {e}")
        return jsonify({'r': 0, 'g': 0, 'b': 0, 'error': str(e)})


@app.route('/api/open-in-spotify', methods=['POST'])
def open_in_spotify():
    """Open a playlist in the Spotify desktop app.

    The Flask server always runs on the same Mac as the browser/WebView, so a
    local `open spotify:playlist:<id>` reliably reaches the desktop app from
    both the native wrapper and a regular browser tab.
    """
    data = request.json or {}
    playlist_id = (data.get('playlist_id') or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9]+', playlist_id):
        return jsonify({"error": "Invalid playlist id"}), 400
    try:
        subprocess.run(['open', f'spotify:playlist:{playlist_id}'],
                       check=True, timeout=10)
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error opening playlist in Spotify: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/toggle-repeat', methods=['POST'])
def toggle_repeat():
    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401
    
    data = request.json
    state = data.get('state') # 'track' or 'off'
    
    if not state:
        return jsonify({"error": "Missing state"}), 400
        
    try:
        sp.repeat(state)
        invalidate_current_track_cache()
        # The repeat icon is also a Keyboard Maestro trigger: the "Repeat
        # Toggle" macro mirrors the state into xbar / KM variables.
        fire_repeat_macro("On" if state == "track" else "Off")
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error toggling repeat: {e}")
        return jsonify({"error": str(e)}), 500


# Keyboard Maestro "Repeat Toggle" (group: Spotify Dashboard - External). It
# branches on %TriggerValue% — "On" or "Off" — so it must be triggered WITH a
# parameter, which is why this goes through the keyboardmaestro CLI (-p) and
# not `open kmtrigger://`. The CLI also fails loudly (exit 8 + message) when
# the macro is disabled or gone, where AppleScript's `do script` fails silently.
REPEAT_MACRO_UUID = os.environ.get(
    "SPOTIFY_DASHBOARD_REPEAT_MACRO", "91EEA4DF-857F-415B-93D8-4584BCD4E92B")
KM_CLI = "/Applications/Keyboard Maestro.app/Contents/MacOS/keyboardmaestro"


def fire_repeat_macro(value):
    """Trigger the Repeat Toggle macro with "On"/"Off", off the request thread."""
    if not os.path.exists(KM_CLI):
        print(f"[repeat-macro] Keyboard Maestro CLI not found at {KM_CLI}; skipping")
        return

    def run():
        try:
            result = subprocess.run(
                [KM_CLI, "-a", "-p", value, REPEAT_MACRO_UUID],
                capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                print(f"[repeat-macro] exit {result.returncode}: "
                      f"{(result.stderr or result.stdout).strip()}")
        except Exception as e:
            print(f"[repeat-macro] failed to trigger: {e}")

    threading.Thread(target=run, daemon=True).start()

@app.route('/api/playlist/toggle', methods=['POST'])
def toggle_playlist():
    data = request.json
    playlist_id = data.get('playlist_id')
    track_uri = data.get('track_uri')
    action = data.get('action') # 'add' or 'remove'
    follow_artist = data.get('follow_artist', False) # Tracker page: auto-follow main artist on add
    artist_id = data.get('artist_id')

    if not all([playlist_id, track_uri, action]):
        return jsonify({"error": "Missing data"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    artist_followed = False

    try:
        if action == 'add':
            # 1. Add to Playlist
            sp.playlist_add_items(playlist_id, [track_uri])
            
            # Update Cache
            if playlist_id in playlist_tracks_cache:
                playlist_tracks_cache[playlist_id].add(track_uri)
                
            # 2. Like the Song (Save to Library)
            track_id = track_uri.replace('spotify:track:', '')
            sp.current_user_saved_tracks_add([track_id])
            message = "Added to playlist and Liked Songs."

            # 3. Follow the track's main artist (Tracker page only).
            # Following is idempotent, so no need to check state first.
            # A follow failure shouldn't undo a successful add — log and continue.
            if follow_artist:
                try:
                    if not artist_id:
                        track = sp.track(track_id)
                        artist_id = track['artists'][0]['id'] if track.get('artists') else None
                    if artist_id:
                        sp.user_follow_artists([artist_id])
                        artist_followed = True
                        message = "Added to playlist, Liked Songs, and followed artist."
                except Exception as e:
                    print(f"Error auto-following artist {artist_id}: {e}")
        
        elif action == 'remove':
            # 1. Remove from Playlist
            sp.playlist_remove_all_occurrences_of_items(playlist_id, [track_uri])
            
            # Update Cache
            if playlist_id in playlist_tracks_cache:
                if track_uri in playlist_tracks_cache[playlist_id]:
                    playlist_tracks_cache[playlist_id].remove(track_uri)
            
            # 2. Check if track exists in ANY other playlists on this page
            # Combine all playlists (dashboard, tracker, queue)
            all_playlists = dashboard_playlists + [p for p in tracker_playlists if not p.get('is_divider')] + [p for p in queue_playlists if not p.get('is_divider')]
            
            track_exists_elsewhere = False
            for pl in all_playlists:
                pid = pl['id']
                # Skip the playlist we just removed from
                if pid == playlist_id:
                    continue
                # Check if track exists in this playlist's cache
                if pid in playlist_tracks_cache and track_uri in playlist_tracks_cache[pid]:
                    track_exists_elsewhere = True
                    break
            
            # If track doesn't exist in any other playlists, unlike it
            if not track_exists_elsewhere:
                track_id = track_uri.replace('spotify:track:', '')
                sp.current_user_saved_tracks_delete([track_id])
                message = "Removed from playlist and unliked (not in any other playlists)."
            else:
                message = "Removed from playlist."
            
        else:
            return jsonify({"error": "Invalid action"}), 400

        save_playlist_cache_to_disk()
        invalidate_current_track_cache()  # is_liked may have changed
        return jsonify({"success": True, "message": message, "artist_followed": artist_followed})

    except Exception as e:
        print(f"Error toggling playlist: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/playlist/toggle-album', methods=['POST'])
def toggle_album_playlist():
    """Toggle all tracks from an album in a playlist (queue page only)"""
    data = request.json
    playlist_id = data.get('playlist_id')
    album_id = data.get('album_id')
    action = data.get('action')  # 'add' or 'remove'

    if not all([playlist_id, album_id, action]):
        return jsonify({"error": "Missing data"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    try:
        # Get all tracks from the album
        album_tracks = []
        results = sp.album_tracks(album_id, limit=50)
        album_tracks.extend(results['items'])
        
        while results['next']:
            results = sp.next(results)
            album_tracks.extend(results['items'])
        
        # Extract track URIs
        track_uris = [track['uri'] for track in album_tracks if track and track.get('uri')]
        
        if not track_uris:
            return jsonify({"error": "No tracks found in album"}), 404
        
        if action == 'add':
            # Add all tracks to playlist
            # Spotify API limits to 100 tracks per request
            for i in range(0, len(track_uris), 100):
                batch = track_uris[i:i+100]
                sp.playlist_add_items(playlist_id, batch)
            
            # Update cache
            if playlist_id in playlist_tracks_cache:
                playlist_tracks_cache[playlist_id].update(track_uris)
            
            message = f"Added {len(track_uris)} tracks from album to playlist."
        
        elif action == 'remove':
            # Remove all tracks from playlist
            # Spotify API limits to 100 tracks per request
            for i in range(0, len(track_uris), 100):
                batch = track_uris[i:i+100]
                sp.playlist_remove_all_occurrences_of_items(playlist_id, batch)
            
            # Update cache
            if playlist_id in playlist_tracks_cache:
                for uri in track_uris:
                    playlist_tracks_cache[playlist_id].discard(uri)
            
            message = f"Removed {len(track_uris)} tracks from album from playlist."
        
        else:
            return jsonify({"error": "Invalid action"}), 400

        save_playlist_cache_to_disk()
        return jsonify({"success": True, "message": message, "track_count": len(track_uris)})

    except Exception as e:
        print(f"Error toggling album in playlist: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/artist-latest-release')
def get_artist_latest_release():
    """Get the most recent Album or EP from an artist.
    Query param: artist_name - the name of the artist (used to search for their Spotify ID)
    Returns the most recent album_group='album' or 'single' (which includes EPs) release.
    """
    artist_name = request.args.get('artist_name')
    if not artist_name:
        return jsonify({"error": "Missing artist_name"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    try:
        # Search for the artist to get their Spotify ID
        search_results = sp.search(q=f'artist:"{artist_name}"', type='artist', limit=5)
        artists = search_results.get('artists', {}).get('items', [])
        
        if not artists:
            return jsonify({"error": f"Artist '{artist_name}' not found"}), 404
        
        # Find exact match or best match
        artist_id = None
        for a in artists:
            if a['name'].lower() == artist_name.lower():
                artist_id = a['id']
                break
        if not artist_id:
            artist_id = artists[0]['id']  # fallback to top result
        
        # Fetch albums (album_type=album includes full albums)
        albums_result = sp.artist_albums(artist_id, album_type='album', limit=10, country='US')
        albums = albums_result.get('items', [])
        
        # Fetch singles/EPs (album_type=single includes EPs and singles)
        singles_result = sp.artist_albums(artist_id, album_type='single', limit=10, country='US')
        singles = singles_result.get('items', [])
        
        # Filter: only keep actual EPs (total_tracks > 3) or albums
        # We need to fetch full details to get total_tracks for singles
        ep_candidates = []
        for s in singles:
            # Spotify marks EPs as 'single' album_type, but they typically have more tracks
            # We'll fetch the full album details to check total_tracks
            try:
                full_album = sp.album(s['id'])
                if full_album.get('total_tracks', 0) >= 4 or full_album.get('album_type') == 'ep':
                    ep_candidates.append(full_album)
            except:
                pass
        
        # Combine albums and EPs, sort by release date descending
        # Filter out releases matching exclude patterns from config (e.g. "deluxe", "remaster")
        exclude_patterns = app_config.get('sidebar', {}).get('exclude_patterns', ['deluxe'])
        
        def is_excluded(name):
            name_lower = name.lower()
            return any(pattern.lower() in name_lower for pattern in exclude_patterns)
        
        all_releases = []
        
        for album in albums:
            if is_excluded(album.get('name', '')):
                continue
            release_date = album.get('release_date', '1900-01-01')
            all_releases.append({
                'id': album['id'],
                'name': album['name'],
                'type': 'Album',
                'release_date': release_date,
                'artwork': album['images'][0]['url'] if album.get('images') else None,
                'total_tracks': album.get('total_tracks', 0),
                'uri': album.get('uri', '')
            })
        
        for ep in ep_candidates:
            if is_excluded(ep.get('name', '')):
                continue
            release_date = ep.get('release_date', '1900-01-01')
            all_releases.append({
                'id': ep['id'],
                'name': ep['name'],
                'type': 'EP',
                'release_date': release_date,
                'artwork': ep['images'][0]['url'] if ep.get('images') else None,
                'total_tracks': ep.get('total_tracks', 0),
                'uri': ep.get('uri', '')
            })
        
        if not all_releases:
            following_status = False
            try:
                following = sp.current_user_following_artists([artist_id])
                following_status = following[0] if following else False
            except Exception:
                pass
            return jsonify({
                "error": "No albums or EPs found for this artist",
                "artist_id": artist_id,
                "is_following": following_status
            }), 404
        
        # Sort by release date descending (most recent first)
        all_releases.sort(key=lambda x: x['release_date'], reverse=True)
        
        latest = all_releases[0]
        
        # Format release_date to MM-DD-YY
        raw_date = latest['release_date']
        try:
            if len(raw_date) == 10:  # YYYY-MM-DD
                parts = raw_date.split('-')
                formatted_date = f"{parts[1]}-{parts[2]}-{parts[0][2:]}"
            elif len(raw_date) == 7:  # YYYY-MM
                parts = raw_date.split('-')
                formatted_date = f"{parts[1]}-01-{parts[0][2:]}"
            else:  # YYYY
                formatted_date = f"01-01-{raw_date[2:]}"
        except:
            formatted_date = raw_date
        
        latest['formatted_date'] = formatted_date
        latest['artist_name'] = artist_name
        latest['artist_id'] = artist_id
        
        # Check if following artist
        try:
            following = sp.current_user_following_artists([artist_id])
            latest['is_following'] = following[0] if following else False
        except Exception as e:
            print(f"Error checking artist follow status: {e}")
            latest['is_following'] = False
        
        return jsonify(latest)

    except spotipy.exceptions.SpotifyException as e:
        if e.http_status == 429:
            retry_after = int(e.headers.get('Retry-After', 5))
            return jsonify({"error": "Rate limit", "retry_after": retry_after}), 429
        print(f"Spotify error getting artist releases: {e}")
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        print(f"Error getting artist latest release: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/toggle-artist-follow', methods=['POST'])
def toggle_artist_follow():
    """Follow or unfollow an artist"""
    data = request.json
    artist_id = data.get('artist_id')
    action = data.get('action')  # 'add' or 'remove'
    
    if not all([artist_id, action]):
        return jsonify({"error": "Missing data"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    try:
        if action == 'add':
            sp.user_follow_artists([artist_id])
            return jsonify({"success": True, "message": "Following artist"})
        elif action == 'remove':
            sp.user_unfollow_artists([artist_id])
            return jsonify({"success": True, "message": "Unfollowed artist"})
        else:
            return jsonify({"error": "Invalid action"}), 400
    except Exception as e:
        print(f"Error toggling artist follow state: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/check-album-library')
def check_album_library():
    """Check if an album is saved in the user's library"""
    album_id = request.args.get('album_id')
    if not album_id:
        return jsonify({"error": "Missing album_id"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    try:
        result = sp.current_user_saved_albums_contains([album_id])
        return jsonify({"is_saved": result[0] if result else False})
    except Exception as e:
        print(f"Error checking album library status: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/album-library', methods=['POST'])
def toggle_album_library():
    """Add or remove an album from the user's library"""
    data = request.json
    album_id = data.get('album_id')
    action = data.get('action')  # 'add' or 'remove'
    
    if not all([album_id, action]):
        return jsonify({"error": "Missing data"}), 400

    if not is_authenticated():
        return jsonify({"error": "Not authenticated"}), 401

    try:
        if action == 'add':
            sp.current_user_saved_albums_add([album_id])
            return jsonify({"success": True, "message": "Album added to library"})
        elif action == 'remove':
            sp.current_user_saved_albums_delete([album_id])
            return jsonify({"success": True, "message": "Album removed from library"})
        else:
            return jsonify({"error": "Invalid action"}), 400
    except Exception as e:
        print(f"Error toggling album library: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    # threaded=True is load-bearing: Werkzeug is single-threaded by default, so
    # every request queues behind the slowest one in flight. During cache
    # warm-up a live /api/check-playlists pass can hold the worker for seconds,
    # which delayed queued /api/open-in-spotify calls — Spotify then opened
    # seconds after an unrelated later click (reported 07-29-26).
    app.run(port=8888, debug=False, threaded=True)
