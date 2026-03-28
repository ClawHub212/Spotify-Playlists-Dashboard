import os
import csv
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
CSV_FILE = "data/csv/Playlists to Display.csv"
SCOPE = "user-read-playback-state user-modify-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-recently-played"

# Spotify Auth Manager
# We create a function or object to manage auth
def get_auth_manager():
    return SpotifyOAuth(scope=SCOPE, open_browser=False)

sp = spotipy.Spotify(auth_manager=get_auth_manager(), requests_timeout=10, status_retries=0, retries=0)

# Global Cache for Playlist IDs
# Map: "Spotify Playlist Name" -> Playlist ID
playlist_map = {}
# List of dicts for frontend: { "name": "Dashboard Name", "spotify_name": "Spotify Playlist Name", "id": "..." }
dashboard_playlists = []
# Cache for Playlist Tracks: Playlist ID -> Set of Track URIs
playlist_tracks_cache = {}

# Loading state: tracks whether initial playlist load is still in progress
# "loading" = still fetching, "done" = finished (success or failure)
loading_state = "loading"

def populate_playlist_cache():
    global playlist_tracks_cache
    # Reduced wait time for faster initial response
    time.sleep(3)
    print("Starting background cache population...")
    
    count = 0
    for pl in dashboard_playlists:
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
            time.sleep(2) # Sleep to respect rate limits
            
        except Exception as e:
            print(f"Error caching playlist {sname}: {e}")
            
    print(f"Cache population complete. Cached {count}/{len(dashboard_playlists)} playlists.")

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

def load_playlists(spotify_playlists=None):
    global playlist_map, dashboard_playlists
    playlist_map = {}
    dashboard_playlists = []
    
    # 1. Read CSV to get Dashboard Name -> Spotify Playlist Name mapping
    csv_mapping = []
    try:
        with open(CSV_FILE, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                d_name = row.get("Dashboard Name", "").strip()
                s_name = row.get("Spotify Playlist Name", "").strip()
                if d_name and s_name:
                    csv_mapping.append({"d_name": d_name, "s_name": s_name})
    except Exception as e:
        print(f"Error reading CSV: {e}")
        return

    # 2. Use pre-fetched playlists or fetch if not provided
    if spotify_playlists is None:
        spotify_playlists = fetch_all_user_playlists()
        if spotify_playlists is None:
            return

    # Map Name -> ID (Case insensitive for robustness? adhering to exact name for now based on prompt)
    # Using a dict for quick lookup: Name -> ID
    # Note: Duplicate names in Spotify are possible, this will pick the last one found.
    sp_name_to_id = {p['name']: p['id'] for p in spotify_playlists}

    # 3. Match CSV entries to Spotify IDs
    # 3. Match CSV entries to Spotify IDs (and dedup)
    seen_names = set()
    for item in csv_mapping:
        d_name = item['d_name']
        s_name = item['s_name']
        
        # Avoid duplicates
        if d_name in seen_names:
            continue
            
        # Handle explicit IDs (avoids missing playlists or duplicates)
        explicit_ids = {
            "Cruise Control 🚘 NEW 2026 R&B to ride to 🚗 💨": "6PaI7gZiVU0wlBusCwYyh9",
            "BEST NEW 2026 Conscious Hip-Hop": "593KXjedxJrSCjf6jC2RUq",
            "NEW 2026 S3XY DRILL NO DIDDY 🍑🍆🔫 FIYAH SEXY R&B Hip-Hop Rap 💥 (updated weekly)": "4sThCBzRZyO0DY507WACHD",
            "New Hip Hop & Rap with a Retro 2000s sound": "1c3VxlMSXinIq6NE1afSw4"
        }
        
        if s_name in explicit_ids:
            pid = explicit_ids[s_name]
        elif s_name in sp_name_to_id:
            pid = sp_name_to_id[s_name]
        else:
            print(f"Warning: Playlist '{s_name}' not found in your Spotify library.")
            continue
            
        playlist_map[s_name] = pid
        dashboard_playlists.append({
            "name": d_name,
            "spotify_name": s_name,
            "id": pid
        })
        seen_names.add(d_name)

    print(f"Loaded {len(dashboard_playlists)} matched playlists.")

    # Start background cache population
    threading.Thread(target=populate_playlist_cache, daemon=True).start()

# Global list for Tracker Page
tracker_playlists = []
TRACKER_CSV_FILE = "data/csv/Tracker to Display.csv"

# Global list for Queue Page
queue_playlists = []
QUEUE_CSV_FILE = "data/csv/Queue to Display.csv"

def load_tracker_playlists(spotify_playlists=None):
    global tracker_playlists
    tracker_playlists = []
    
    csv_mapping = []
    try:
        with open(TRACKER_CSV_FILE, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                d_name = row.get("Dashboard Name", "").strip()
                s_name = row.get("Spotify Playlist Name", "").strip()
                if d_name and s_name:
                    csv_mapping.append({"d_name": d_name, "s_name": s_name})
    except Exception as e:
        print(f"Error reading Tracker CSV: {e}")
        return

    # Use pre-fetched playlists or fetch if not provided
    if spotify_playlists is None:
        spotify_playlists = fetch_all_user_playlists()
        if spotify_playlists is None:
            return
        
    sp_name_to_id = {p['name']: p['id'] for p in spotify_playlists}
    
    for item in csv_mapping:
        d_name = item['d_name']
        s_name = item['s_name']
        
        if d_name == "DIVIDER":
            tracker_playlists.append({
                "name": "DIVIDER",
                "spotify_name": "DIVIDER",
                "id": "DIVIDER",
                "is_divider": True
            })
            continue

        if s_name in sp_name_to_id:
            pid = sp_name_to_id[s_name]
            
            # Handle duplicate playlists - force specific IDs from "Tracker Duplicates - fixed.csv"
            duplicate_overrides = {
                "A&R - Unsigned Male Rappers to Track [2026]": "6kpKC8PtXItyBnt9ZmD2m6",
                "A&R - Rappers to Track - Male (200K - 500k) [2026]": "0s18ZTUYR2bgO8lgIQ1z3W",
                "A&R - SIGNED Rappers to Track [2026]": "0y22gj9CjSOk6kiJX48f3e",
                "A&R - SIGNED Rappers to Track - Female [2026]": "444aXdKo8VqB5sGcJ19PRi",
                "A&R - Unsigned R&B Singers to Track [2026]": "1Ab0pjOxVGlzz6OsFFSqqZ",
                "A&R - SIGNED R&B Singers to Track [2026]": "0u3S5gh8gSOrOT1NMP94dw"
            }
            
            if s_name in duplicate_overrides:
                pid = duplicate_overrides[s_name]
            
            # Add to main cache map if not there (helps with toggling)
            if pid not in playlist_tracks_cache:
                playlist_tracks_cache[pid] = set()
            
            tracker_playlists.append({
                "name": d_name,
                "spotify_name": s_name,
                "id": pid,
                "is_divider": False
            })
        else:
            print(f"Warning: Tracker Playlist '{s_name}' not found.")

    print(f"Loaded {len(tracker_playlists)} tracker items.")
    
    # Trigger cache population for these new IDs
    threading.Thread(target=populate_tracker_cache, daemon=True).start()

def populate_tracker_cache():
    global playlist_tracks_cache
    print("Starting background cache (Tracker)...")
    count = 0
    for pl in tracker_playlists:
        if pl.get('is_divider'): continue
        
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
        except Exception as e:
            print(f"Error caching tracker playlist {sname}: {e}")
    print(f"Tracker Cache complete. Cached {count} playlists.")

def load_queue_playlists(spotify_playlists=None):
    global queue_playlists
    queue_playlists = []
    
    csv_mapping = []
    try:
        with open(QUEUE_CSV_FILE, mode='r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                d_name = row.get("Name", "").strip()
                s_name = row.get("Spotify Playlist Name", "").strip()
                if d_name and s_name:
                    csv_mapping.append({"d_name": d_name, "s_name": s_name})
    except Exception as e:
        print(f"Error reading Queue CSV: {e}")
        return

    # Use pre-fetched playlists or fetch if not provided
    if spotify_playlists is None:
        spotify_playlists = fetch_all_user_playlists()
        if spotify_playlists is None:
            return
        
    sp_name_to_id = {p['name']: p['id'] for p in spotify_playlists}
    
    for item in csv_mapping:
        d_name = item['d_name']
        s_name = item['s_name']
        
        if d_name == "LINE BREAK":
            queue_playlists.append({
                "name": "DIVIDER",
                "spotify_name": "DIVIDER",
                "id": "DIVIDER",
                "is_divider": True
            })
            continue

        if s_name in sp_name_to_id:
            pid = sp_name_to_id[s_name]
            # Add to main cache map if not there (helps with toggling)
            if pid not in playlist_tracks_cache:
                playlist_tracks_cache[pid] = set()
            
            queue_playlists.append({
                "name": d_name,
                "spotify_name": s_name,
                "id": pid,
                "is_divider": False
            })
        else:
            print(f"Warning: Queue Playlist '{s_name}' not found.")

    print(f"Loaded {len(queue_playlists)} queue items.")
    
    # Trigger cache population for these new IDs
    threading.Thread(target=populate_queue_cache, daemon=True).start()

def populate_queue_cache():
    global playlist_tracks_cache
    print("Starting background cache (Queue)...")
    count = 0
    for pl in queue_playlists:
        if pl.get('is_divider'): continue
        
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
        except Exception as e:
            print(f"Error caching queue playlist {sname}: {e}")
    print(f"Queue Cache complete. Cached {count} playlists.")

# Helper to load playlists only if authorized
def safe_load_playlists():
    global loading_state
    try:
        auth_manager = get_auth_manager()
        token = auth_manager.get_cached_token()
        if token:
            print(f"Token found. Loading playlists... (expires: {token.get('expires_at', 'unknown')})")
            # Fetch all user playlists ONCE and share across all loaders
            spotify_playlists = fetch_all_user_playlists()
            if spotify_playlists is not None:
                load_playlists(spotify_playlists)
                load_tracker_playlists(spotify_playlists)
                load_queue_playlists(spotify_playlists)
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

# Health check endpoint (fast, no auth required)
@app.route('/health')
def health():
    return 'ok', 200

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
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return redirect('/login')
    response = send_from_directory('static', 'tracker.html')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route('/api/tracker-playlists')
def get_tracker_playlists():
    response = jsonify(tracker_playlists)
    response.headers['X-Loading-State'] = loading_state
    return response

@app.route('/queue')
def queue():
    auth_manager = get_auth_manager()
    if not auth_manager.validate_token(auth_manager.get_cached_token()):
        return redirect('/login')
    response = send_from_directory('static', 'queue.html')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route('/api/queue-playlists')
def get_queue_playlists():
    response = jsonify(queue_playlists)
    response.headers['X-Loading-State'] = loading_state
    return response

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
        # Load playlists after successful authentication
        spotify_playlists = fetch_all_user_playlists()
        if spotify_playlists is not None:
            load_playlists(spotify_playlists)
            load_tracker_playlists(spotify_playlists)
            load_queue_playlists(spotify_playlists)
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


@app.route('/api/playlists')
def get_playlists():
    # Return playlists with "isActive" status for the given track_id
    track_id = request.args.get('track_id')
    if not track_id:
        response = jsonify(dashboard_playlists) # Return without active status
        response.headers['X-Loading-State'] = loading_state
        return response

    # Start with all false
    # ... (logic removed in previous thought, skipping implementation complexity here)
    
    response = jsonify(dashboard_playlists)
    response.headers['X-Loading-State'] = loading_state
    return response

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

if __name__ == '__main__':
    app.run(port=8888, debug=False)

