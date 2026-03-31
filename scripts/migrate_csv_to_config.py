#!/usr/bin/env python3
"""
Migrate legacy CSV playlist configurations to config.json.

Reads the 3 CSV files (Playlists, Tracker, Queue) and any hardcoded
playlist ID overrides from the original app.py, then outputs a unified
config.json file.

Usage:
    python scripts/migrate_csv_to_config.py
"""
import csv
import json
import os

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYLISTS_CSV = os.path.join(PROJECT_ROOT, "data/csv/Playlists to Display.csv")
TRACKER_CSV = os.path.join(PROJECT_ROOT, "data/csv/Tracker to Display.csv")
QUEUE_CSV = os.path.join(PROJECT_ROOT, "data/csv/Queue to Display.csv")
CONFIG_OUTPUT = os.path.join(PROJECT_ROOT, "config.json")

# Hardcoded overrides that were baked into app.py — these get migrated
# into spotify_id fields so the new generic loader handles them cleanly.
PLAYLIST_EXPLICIT_IDS = {
    "Cruise Control 🚘 NEW 2026 R&B to ride to 🚗 💨": "6PaI7gZiVU0wlBusCwYyh9",
    "BEST NEW 2026 Conscious Hip-Hop": "593KXjedxJrSCjf6jC2RUq",
    "NEW 2026 S3XY DRILL NO DIDDY 🍑🍆🔫 FIYAH SEXY R&B Hip-Hop Rap 💥 (updated weekly)": "4sThCBzRZyO0DY507WACHD",
    "New Hip Hop & Rap with a Retro 2000s sound": "1c3VxlMSXinIq6NE1afSw4"
}

TRACKER_EXPLICIT_IDS = {
    "A&R - Unsigned Male Rappers to Track [2026]": "6kpKC8PtXItyBnt9ZmD2m6",
    "A&R - Rappers to Track - Male (200K - 500k) [2026]": "0s18ZTUYR2bgO8lgIQ1z3W",
    "A&R - SIGNED Rappers to Track [2026]": "0y22gj9CjSOk6kiJX48f3e",
    "A&R - SIGNED Rappers to Track - Female [2026]": "444aXdKo8VqB5sGcJ19PRi",
    "A&R - Unsigned R&B Singers to Track [2026]": "1Ab0pjOxVGlzz6OsFFSqqZ",
    "A&R - SIGNED R&B Singers to Track [2026]": "0u3S5gh8gSOrOT1NMP94dw"
}


def read_playlists_csv():
    items = []
    with open(PLAYLISTS_CSV, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            d_name = row.get("Dashboard Name", "").strip()
            s_name = row.get("Spotify Playlist Name", "").strip()
            if d_name and s_name:
                entry = {"display_name": d_name, "spotify_name": s_name}
                if s_name in PLAYLIST_EXPLICIT_IDS:
                    entry["spotify_id"] = PLAYLIST_EXPLICIT_IDS[s_name]
                items.append(entry)
    return items


def read_tracker_csv():
    items = []
    with open(TRACKER_CSV, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            d_name = row.get("Dashboard Name", "").strip()
            s_name = row.get("Spotify Playlist Name", "").strip()
            if d_name == "DIVIDER":
                items.append({"type": "divider"})
                continue
            if d_name and s_name:
                entry = {"display_name": d_name, "spotify_name": s_name}
                if s_name in TRACKER_EXPLICIT_IDS:
                    entry["spotify_id"] = TRACKER_EXPLICIT_IDS[s_name]
                items.append(entry)
    return items


def read_queue_csv():
    items = []
    with open(QUEUE_CSV, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            d_name = row.get("Name", "").strip()
            s_name = row.get("Spotify Playlist Name", "").strip()
            if d_name == "LINE BREAK":
                items.append({"type": "divider"})
                continue
            if d_name and s_name:
                items.append({"display_name": d_name, "spotify_name": s_name})
    return items


def main():
    config = {
        "pages": [
            {
                "id": "playlists",
                "label": "PLAYLISTS",
                "type": "grid",
                "route": "/",
                "html": "playlists.html",
                "playlists": read_playlists_csv()
            },
            {
                "id": "tracker",
                "label": "TRACKER",
                "type": "list",
                "route": "/tracker",
                "html": "tracker.html",
                "playlists": read_tracker_csv()
            },
            {
                "id": "queue",
                "label": "QUEUE",
                "type": "album-list",
                "route": "/queue",
                "html": "queue.html",
                "playlists": read_queue_csv()
            }
        ],
        "sidebar": {
            "exclude_patterns": ["deluxe"],
            "queue_page_id": "queue"
        }
    }

    with open(CONFIG_OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    total = sum(
        len([p for p in page['playlists'] if p.get('type') != 'divider'])
        for page in config['pages']
    )
    print(f"✅ Generated {CONFIG_OUTPUT}")
    print(f"   {len(config['pages'])} pages, {total} playlists total")


if __name__ == "__main__":
    main()
