-- Toggle Spotify Dashboard (old) visibility (Playlists page)
-- If visible on Playlists page -> hides
-- If hidden or on another page -> shows Playlists page

tell application "Spotify Dashboard (old)"
    toggle page "playlist"
end tell
