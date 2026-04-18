import os
import json
import time
import threading
from flask import Flask, jsonify, request, send_from_directory, redirect, session
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv
from PIL import Image
import requests
from io import BytesIO

load_dotenv()

app = Flask(__name__, static_folder='static')

# Configuration
CONFIG_FILE = "config.json"
SCOPE = "user-read-playback-state user-modify-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-recently-played"

# Spotify Auth Manager
def get_auth_manager():
    return SpotifyOAuth(scope=SCOPE, open_browser=False)

sp = spotipy.Spotify(auth_manager=get_auth_manager(), requests_timeout=10, status_retries=0, retries=0)

# Global state populated from config.json
app_config = {}                  # The loaded config dict
page_playlists = {}              # page_id -> list of resolved playlist dicts
playlist_tracks_cache = {}       # Playlist ID -> Set of Track URIs

# Backward-compat aliases (populated after config load)
dashboard_playlists = []
tracker_playlists = []
queue_playlists = []

# Loading state: tracks whether initial playlist load is still in progress
loading_state = "loading"


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
        # Handle dividers
        if item.get('type') == 'divider':
            resolved.append({
                'name': 'DIVIDER',
                'spotify_name': 'DIVIDER',
                'id': 'DIVIDER',
                'is_divider': True
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

        # Ensure cache slot exists
        if pid not in playlist_tracks_cache:
            playlist_tracks_cache[pid] = set()

        resolved.append({
            'name': d_name,
            'spotify_name': s_name,
            'id': pid,
            'is_divider': False
        })
        seen_names.add(d_name)

    return resolved


def populate_page_cache(page_id, playlists, label=None):
    """Background cache population for a single page's playlists."""
    global playlist_tracks_cache
    tag = label or page_id
    print(f"Starting background cache ({tag})...")
    count = 0
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
            count += 1
            time.sleep(2)  # Respect rate limits
        except Exception as e:
            print(f"Error caching {tag} playlist {sname}: {e}")
    print(f"{tag} cache complete. Cached {count}/{len([p for p in playlists if not p.get('is_divider')])} playlists.")


def fetch_all_user_playlists():
    """Fetch all user playlists from Spotify once. Returns list of playlist dicts or None on error."""
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
    return spotify_playlists


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
        threading.Thread(
            target=populate_page_cache,
            args=(page_id, resolved, page.get('label', page_id)),
            daemon=True
        ).start()

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

        auth_manager = get_auth_manager()
        token = auth_manager.get_cached_token()
        if token:
            print(f"Token found. Loading playlists... (expires: {token.get('expires_at', 'unknown')})")
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

# Initial Load Attempt — run in background so Flask starts serving immediately
threading.Thread(target=safe_load_playlists, daemon=True).start()

# ─────────────────────────────────────────────
# Health check endpoint (fast, no auth required)
# ─────────────────────────────────────────────
@app.route('/health')
def health():
    if loading_state == "done":
        return 'ok', 200
    else:
        return 'loading', 503

# ─────────────────────────────────────────────
# Generic page route — works for any page defined in config.json
# e.g. /page/playlists, /page/tracker, /page/queue, /page/my-new-page
# ─────────────────────────────────────────────
@app.route('/page/<page_id>')
def serve_page(page_id):
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
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

# ─────────────────────────────────────────────
# Backward-compat aliases — your existing local URLs keep working
# ─────────────────────────────────────────────
@app.route('/')
def index():
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return redirect('/login')
    response = send_from_directory('static', 'playlists.html')
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
        auth_manager.get_access_token(code)
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

@app.route('/api/current-track')
def get_current_track():
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return jsonify({"error": "Not authenticated"}), 401

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
                    return jsonify(None)
        
        # Check if liked
        # current_user_saved_tracks_contains returns list of bools
        is_liked = sp.current_user_saved_tracks_contains([track['id']])[0]
        
        popularity = track.get('popularity', 0)
        
        # Get album info
        album_name = track['album']['name'] if track.get('album') else 'Unknown Album'
        album_cover = track['album']['images'][0]['url'] if track.get('album') and track['album'].get('images') else None
        album_id = track['album']['id'] if track.get('album') else None
        
        return jsonify({
            "id": track['id'],
            "name": track['name'],
            "artist": ", ".join([artist['name'] for artist in track['artists']]),
            "album": album_name,
            "album_id": album_id,
            "album_cover": album_cover,
            "is_liked": is_liked,
            "is_playing": is_playing,
            "repeat_state": repeat_state,
            "popularity": popularity,
            "uri": track['uri']
        })

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

    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return jsonify({"error": "Not authenticated"}), 401

    # Standardize to URI
    if not track_uri.startswith('spotify:track:'):
        track_uri = f'spotify:track:{track_uri}'

    active_ids = []
    playlists_to_check_live = []

    # Combine dashboard, tracker, and queue playlists for checking
    all_playlists = dashboard_playlists + [p for p in tracker_playlists if not p.get('is_divider')] + [p for p in queue_playlists if not p.get('is_divider')]

    # First check cache
    for pl in all_playlists:
        pid = pl['id']
        # If cache exists for this playlist, use it
        if pid in playlist_tracks_cache:
            if track_uri in playlist_tracks_cache[pid]:
                active_ids.append(pid)
        else:
            # Cache not ready for this playlist, need to check live
            playlists_to_check_live.append((pid, pl['spotify_name']))

    # For playlists not in cache, do a live check
    if playlists_to_check_live:
        print(f"Cache incomplete, checking {len(playlists_to_check_live)} playlists live...")
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

    return jsonify(active_ids)


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


@app.route('/api/toggle-repeat', methods=['POST'])
def toggle_repeat():
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return jsonify({"error": "Not authenticated"}), 401
    
    data = request.json
    state = data.get('state') # 'track' or 'off'
    
    if not state:
        return jsonify({"error": "Missing state"}), 400
        
    try:
        sp.repeat(state)
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error toggling repeat: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/playlist/toggle', methods=['POST'])
def toggle_playlist():
    data = request.json
    playlist_id = data.get('playlist_id')
    track_uri = data.get('track_uri')
    action = data.get('action') # 'add' or 'remove'
    
    if not all([playlist_id, track_uri, action]):
        return jsonify({"error": "Missing data"}), 400

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

        return jsonify({"success": True, "message": message})

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

    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
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
            return jsonify({"error": "No albums or EPs found for this artist"}), 404
        
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


@app.route('/api/check-album-library')
def check_album_library():
    """Check if an album is saved in the user's library"""
    album_id = request.args.get('album_id')
    if not album_id:
        return jsonify({"error": "Missing album_id"}), 400

    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
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

    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
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
    app.run(port=8888, debug=False)
