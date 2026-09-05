-- Toggle Spotify Dashboard (old) visibility (Queue page)
-- If visible on Queue page -> hides
-- If hidden or on another page -> shows Queue page

tell application "Spotify Dashboard (old)"
    toggle page "queue"
end tell
