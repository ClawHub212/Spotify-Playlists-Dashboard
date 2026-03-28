// State
let currentTrack = null;
let allPlaylists = [];
let activePlaylistsMap = new Set(); // Set of Playlist IDs that contain the current track
let colorCache = {}; // Cache extracted colors by track ID

// Load color cache from localStorage
try {
  const cached = localStorage.getItem("albumColorCache");
  if (cached) colorCache = JSON.parse(cached);
} catch (e) {
  console.warn("Failed to load color cache:", e);
}

document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  generateWaveformBars();
  init();
});

/**
 * Generate waveform bars dynamically in the .visualizer container
 */
function generateWaveformBars() {
  const visualizer = document.querySelector(".visualizer");
  if (!visualizer) return;

  // Remove any existing static bars
  visualizer.querySelectorAll(".bar").forEach((b) => b.remove());

  const nothingPlaying = document.getElementById("nothing-playing");
  const barCount = 35;
  for (let i = 0; i < barCount; i++) {
    const bar = document.createElement("div");
    bar.className = "bar";

    // Randomize animation properties for organic look
    const minH = 2 + Math.random() * 3; // 2-5px minimum
    const maxH = 10 + Math.random() * 18; // 10-28px maximum
    const duration = 0.4 + Math.random() * 0.6; // 0.4-1.0s
    const delay = Math.random() * -1.0; // stagger start

    bar.style.setProperty("--bar-min", `${minH}px`);
    bar.style.setProperty("--bar-max", `${maxH}px`);
    bar.style.height = `${minH}px`;
    bar.style.animationDuration = `${duration}s`;
    bar.style.animationDelay = `${delay}s`;

    // Insert bars before the "Nothing Playing" message
    visualizer.insertBefore(bar, nothingPlaying);
  }

  // Start in hidden state
  visualizer.classList.add("is-hidden");
}

function handleVisibilityChange() {
  if (document.hidden) {
    console.log("Tab hidden, slowing down polling to 60s");
    pollInterval = 60000;
  } else {
    console.log("Tab visible, restoring polling to 10s");
    pollInterval = 10000;
    // Optional: Trigger immediate update if needed, but let's just let the next poll cycle handle it or rely on the shorter interval
    // pollCurrentTrack(); // Careful not to create double loops
  }
}

let playlistRetryCount = 0;
const MAX_PLAYLIST_RETRIES = 30;

async function init() {
  // 1. Fetch initial Playlists (Static info)
  await fetchPlaylists();

  // 2. Start Polling for Current Track
  pollCurrentTrack();
}

async function fetchPlaylists() {
  try {
    const isTracker = document.body.classList.contains("tracker-page");
    const isQueue = document.body.classList.contains("queue-page");
    const endpoint = isTracker
      ? "/api/tracker-playlists"
      : isQueue
        ? "/api/queue-playlists"
        : "/api/playlists";

    const res = await fetch(endpoint);

    if (res.status === 429) {
      console.warn("Playlists fetch rate limited, retrying in 5s...");
      document.getElementById("playlist-grid").innerHTML =
        '<div style="color:white; padding:20px;">Spotify is rate limiting us... waiting 5s to retry.</div>';
      setTimeout(fetchPlaylists, 5000);
      return;
    }

    if (!res.ok) throw new Error(`Failed to fetch playlists: ${res.status}`);

    allPlaylists = await res.json();

    // Check if backend is still loading playlists
    const loadingState = res.headers.get("X-Loading-State");
    const backendStillLoading = loadingState === "loading";

    if (allPlaylists.length === 0) {
      if (backendStillLoading) {
        // Backend is still loading — keep retrying without counting toward limit
        console.log("Backend still loading playlists, retrying in 2s...");
        document.getElementById("playlist-grid").innerHTML =
          '<div style="color:rgba(255,255,255,0.4); padding:20px; font-family: var(--font-body); text-align:center;">Loading playlists…</div>';
        setTimeout(fetchPlaylists, 2000);
      } else {
        // Backend finished loading but returned 0 — count retries
        playlistRetryCount++;
        if (playlistRetryCount <= MAX_PLAYLIST_RETRIES) {
          console.log(`Playlists not ready yet, retrying in 2s... (attempt ${playlistRetryCount}/${MAX_PLAYLIST_RETRIES})`);
          document.getElementById("playlist-grid").innerHTML =
            '<div style="color:rgba(255,255,255,0.4); padding:20px; font-family: var(--font-body); text-align:center;">Loading playlists…</div>';
          setTimeout(fetchPlaylists, 2000);
        } else {
          console.warn("Warning: Received 0 playlists after all retries");
          document.getElementById("playlist-grid").innerHTML =
            '<div style="color:white; padding:20px;">No playlists found. Check backend logs.</div>';
        }
      }
    } else {
      playlistRetryCount = 0;
      // Render immediately (all inactive initially) for speed
      renderPlaylists();
    }
  } catch (e) {
    console.error("Error in fetchPlaylists:", e);
    document.getElementById("artist-name").textContent =
      "Error loading playlists: " + e.message;
  }
}

/**
 * Extract dominant color from album artwork
 * @param {string} imageUrl - URL of the album cover
 * @param {string} trackId - Track ID for caching
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
async function extractDominantColor(imageUrl, trackId) {
  // Check cache first
  if (colorCache[trackId]) {
    return colorCache[trackId];
  }

  try {
    const res = await fetch(
      `/api/extract-color?url=${encodeURIComponent(imageUrl)}`,
    );
    if (!res.ok) throw new Error("Network response was not ok");

    const color = await res.json();
    if (color.error) throw new Error(color.error);

    // Cache the result
    colorCache[trackId] = color;

    // Save to localStorage (limit cache size to 100 entries)
    try {
      const cacheKeys = Object.keys(colorCache);
      if (cacheKeys.length > 100) {
        // Remove oldest entries
        cacheKeys
          .slice(0, cacheKeys.length - 100)
          .forEach((key) => delete colorCache[key]);
      }
      localStorage.setItem("albumColorCache", JSON.stringify(colorCache));
    } catch (e) {
      console.warn("Failed to save color cache:", e);
    }

    return color;
  } catch (e) {
    console.error("Error extracting color from backend:", e);
    // Fallback to default color (Dark Blue/Green)
    return { r: 0, g: 100, b: 200 };
  }
}

/**
 * Apply dynamic background gradient based on album colors
 * @param {{r: number, g: number, b: number}} color - Dominant color
 */
function applyDynamicBackground(color) {
  const { r, g, b } = color;

  // Create beautiful gradient with the dominant color
  const gradient = `
        radial-gradient(
            ellipse at 20% 30%,
            rgba(${r}, ${g}, ${b}, 0.5) 0%,
            rgba(${r}, ${g}, ${b}, 0.3) 40%,
            transparent 70%
        ),
        radial-gradient(
            ellipse at 80% 70%,
            rgba(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.7)}, 0.4) 0%,
            rgba(${Math.floor(r * 0.5)}, ${Math.floor(g * 0.5)}, ${Math.floor(b * 0.5)}, 0.2) 50%,
            transparent 80%
        ),
        #000000
    `;

  document.body.style.background = gradient;
  document.body.style.transition = "background 1.5s ease";
}

let pollInterval = 10000;
let consecutiveErrors = 0;

async function pollCurrentTrack() {
  try {
    const res = await fetch("/api/current-track");

    if (res.status === 429) {
      const data = await res.json();
      const retryAfter = data.retry_after || 5;

      console.warn(`Rate limited, Retry-After: ${retryAfter}s`);
      const trackTitleEl =
        document.getElementById("track-title") ||
        document.getElementById("track-name");
      if (trackTitleEl) trackTitleEl.textContent = "Spotify Rate Limited";

      // Start Countdown
      let timeLeft = retryAfter;
      document.getElementById("artist-name").textContent =
        `Retrying in ${timeLeft}s...`;

      const countdownInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
          document.getElementById("artist-name").textContent =
            `Retrying in ${timeLeft}s...`;
        } else {
          clearInterval(countdownInterval);
        }
      }, 1000);

      // Set next poll
      pollInterval = retryAfter * 1000 + 500; // Add buffer
    } else if (res.status === 200) {
      consecutiveErrors = 0;
      pollInterval = 10000; // Reset to 10s

      const track = await res.json();
      if (track) {
        const idChanged = !currentTrack || currentTrack.id !== track.id;
        const statusChanged =
          !currentTrack ||
          currentTrack.is_playing !== track.is_playing ||
          currentTrack.repeat_state !== track.repeat_state;

        if (idChanged || statusChanged) {
          currentTrack = track;
          updateTrackInfo(track);
          if (idChanged) {
            try {
              // Optimistically render to ensure headers/visuals are right,
              // checks will come later
              renderPlaylists();
              await checkPlaylists(track.uri);
            } catch (err) {
              console.error("Error checking playlists:", err);
            }
          }
        }
      } else {
        updateTrackInfo(null);
      }
    } else {
      // Other errors (500, etc)
      consecutiveErrors++;
      pollInterval = Math.min(pollInterval * 1.5, 30000);
    }
  } catch (e) {
    console.error("Polling error:", e);
    consecutiveErrors++;
    pollInterval = Math.min(pollInterval * 1.5, 30000);
  }

  setTimeout(pollCurrentTrack, pollInterval);
}

async function checkPlaylists(trackUri) {
  try {
    const res = await fetch(
      `/api/check-playlists?track_uri=${encodeURIComponent(trackUri)}`,
    );
    if (res.ok) {
      const activeIds = await res.json();
      activePlaylistsMap = new Set(activeIds);
      renderPlaylists();
    }
  } catch (e) {
    console.error("Error checking playlists:", e);
  }
}

function updateTrackInfo(track) {
  const isQueue = document.body.classList.contains("queue-page");

  // Get elements based on page type
  const title =
    document.getElementById("track-title") ||
    document.getElementById("album-name");
  const artist = document.getElementById("artist-name");
  const albumCover = document.getElementById("album-cover");
  const visualizer = document.querySelector(".visualizer");
  const nothingPlayingMsg = document.getElementById("nothing-playing");
  const repeatIcon = document.getElementById("repeat-icon");
  const playCount = document.getElementById("play-count");

  if (track) {
    // Universal: Update Album Cover
    if (albumCover && track.album_cover) {
      albumCover.src = track.album_cover;
      albumCover.style.display = "block";
    }

    if (isQueue) {
      // Queue page: show album name
      if (title) title.textContent = track.album || "Unknown Album";
    } else {
      // Other pages: show track title, artist, and play count
      if (title) title.textContent = track.name;
      if (artist) artist.textContent = track.artist;

      if (playCount) {
        if (track.popularity !== undefined) {
          playCount.textContent = track.popularity;
          playCount.style.display = "inline-flex";
        } else {
          playCount.style.display = "none";
        }
      }
    }

    // Extract dominant color and update background
    if (track.album_cover) {
      extractDominantColor(track.album_cover, track.id)
        .then((color) => applyDynamicBackground(color))
        .catch((err) => console.warn("Color extraction failed:", err));
    }

    if (visualizer) {
      visualizer.classList.remove("is-hidden");
      if (track.is_playing) {
        visualizer.classList.add("is-playing");
        visualizer.classList.remove("is-paused");
        nothingPlayingMsg.style.display = "none";
      } else {
        visualizer.classList.remove("is-playing");
        visualizer.classList.add("is-paused");
        nothingPlayingMsg.style.display = "none";
      }
    }

    if (repeatIcon) {
      repeatIcon.style.display = "block";

      // Update UI from track payload, but ignore if we recently clicked it (optimistic lock)
      if (!repeatIcon.hasAttribute("data-optimistic-lock")) {
        if (track.repeat_state === "track" || track.repeat_state === "context") {
          repeatIcon.classList.add("active");
        } else {
          repeatIcon.classList.remove("active");
        }
      }

      // Attach click handler tracking only once
      if (!repeatIcon.onclick) {
        repeatIcon.onclick = async () => {
          // Source of truth is current UI state
          const isCurrentlyRepeating = repeatIcon.classList.contains("active");
          const newState = isCurrentlyRepeating ? "off" : "track";

          // Apply optimistic UI update immediately
          if (newState === "track") {
            repeatIcon.classList.add("active");
            if (currentTrack) currentTrack.repeat_state = "track";
          } else {
            repeatIcon.classList.remove("active");
            if (currentTrack) currentTrack.repeat_state = "off";
          }

          // Lock UI from being overwritten by backend polling delays
          repeatIcon.setAttribute("data-optimistic-lock", "true");
          clearTimeout(repeatIcon.lockTimeout);
          repeatIcon.lockTimeout = setTimeout(() => {
            repeatIcon.removeAttribute("data-optimistic-lock");
          }, 3500); // 3.5s grace period

          try {
            await fetch("/api/toggle-repeat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ state: newState })
            });
          } catch (e) {
            console.error("Failed to toggle repeat", e);
            // Revert UI on failure
            if (isCurrentlyRepeating) {
              repeatIcon.classList.add("active");
            } else {
              repeatIcon.classList.remove("active");
            }
          }
        };
      }
    }
  } else {
    if (isQueue) {
      if (title) title.textContent = "Not Playing";
      if (albumCover) albumCover.style.display = "none";
    } else {
      if (title) title.textContent = "Not Playing";
      if (artist) artist.textContent = "Play a song on Spotify";
      if (playCount) playCount.style.display = "none";
    }
    if (visualizer) {
      visualizer.classList.remove("is-playing", "is-paused");
      visualizer.classList.add("is-hidden");
    }
    if (repeatIcon) {
      repeatIcon.style.display = "none";
    }
    nothingPlayingMsg.style.display = "block";
    activePlaylistsMap.clear();
    renderPlaylists();
  }
}

function renderPlaylists() {
  const grid = document.getElementById("playlist-grid");
  grid.innerHTML = "";

  const isTracker = document.body.classList.contains("tracker-page");
  const isQueue = document.body.classList.contains("queue-page");

  // Helper to create item
  const createItem = (playlist) => {
    // Handle DIVIDER for Tracker and Queue
    if ((isTracker || isQueue) && playlist.is_divider) {
      const div = document.createElement("div");
      div.className = "section-divider-green";
      return div;
    }

    const isActive = activePlaylistsMap.has(playlist.id);

    const item = document.createElement("div");
    item.className = `playlist-item ${isActive ? "active" : ""}`;

    // Use ID for toggling
    item.onclick = () => togglePlaylist(playlist);

    const nameSpan = document.createElement("span");
    nameSpan.className = "playlist-name";
    nameSpan.textContent = playlist.name;

    item.appendChild(nameSpan);

    // Status Indicator (Checkmark)
    const indicator = document.createElement("div");
    indicator.className = "status-indicator";
    indicator.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    item.appendChild(indicator);

    return item;
  };

  if (isTracker || isQueue) {
    // Tracker/Queue Logic: Linear Rendering, Strict Order
    const linearGroup = document.createElement("div");
    linearGroup.className = isTracker ? "tracker-list" : "queue-list";
    // Styles moved to CSS for full-page scaling

    allPlaylists.forEach((p) => {
      linearGroup.appendChild(createItem(p));
    });
    grid.appendChild(linearGroup);
  } else {
    // Standard Dashboard Logic: Split Active/Inactive

    // Map state to playlists locally for sorting
    const playlistsWithState = allPlaylists.map((p) => ({
      ...p,
      isActive: activePlaylistsMap.has(p.id),
    }));

    const activePlaylists = playlistsWithState
      .filter((p) => p.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
    const inactivePlaylists = playlistsWithState
      .filter((p) => !p.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));

    // Render Active Group (Column Layout)
    // NOTE: gridTemplateRows must be set explicitly so that grid-auto-flow: column
    // knows how many rows to fill before wrapping to the next column.
    // This ensures playlists are alphabetically sorted TOP-TO-BOTTOM within each column.
    if (activePlaylists.length > 0) {
      const activeGroup = document.createElement("div");
      activeGroup.className = "active-group";
      const activeRowCount = Math.ceil(activePlaylists.length / 3);
      activeGroup.style.gridTemplateRows = `repeat(${activeRowCount}, 1fr)`;
      activePlaylists.forEach((p) => activeGroup.appendChild(createItem(p)));
      grid.appendChild(activeGroup);
    }

    // Divider
    if (activePlaylists.length > 0 && inactivePlaylists.length > 0) {
      const divider = document.createElement("div");
      divider.className = "playlist-divider";
      grid.appendChild(divider);
    }

    // Render Inactive Group (Grid Layout - fills remaining space)
    // NOTE: gridTemplateRows must be set explicitly so that grid-auto-flow: column
    // knows how many rows to fill before wrapping to the next column.
    // This ensures playlists are alphabetically sorted TOP-TO-BOTTOM within each column.
    if (inactivePlaylists.length > 0) {
      const inactiveGroup = document.createElement("div");
      inactiveGroup.className = "inactive-group";
      const rowCount = Math.ceil(inactivePlaylists.length / 3);
      inactiveGroup.style.gridTemplateRows = `repeat(${rowCount}, 1fr)`;
      inactivePlaylists.forEach((p) =>
        inactiveGroup.appendChild(createItem(p)),
      );
      grid.appendChild(inactiveGroup);
    }
  }
}

async function togglePlaylist(playlist) {
  if (!currentTrack) return;

  const isCurrentlyActive = activePlaylistsMap.has(playlist.id);
  const action = isCurrentlyActive ? "remove" : "add";
  const isQueue = document.body.classList.contains("queue-page");

  // Optimistic Update
  if (action === "add") {
    activePlaylistsMap.add(playlist.id);
  } else {
    activePlaylistsMap.delete(playlist.id);
  }

  // Copy Spotify Playlist Name to Clipboard (on Add only)
  if (action === "add" && playlist.spotify_name) {
    navigator.clipboard.writeText(playlist.spotify_name).catch((err) => {
      console.error("Failed to copy text: ", err);
    });
  }
  renderPlaylists();

  try {
    // Use different endpoint based on page type
    const endpoint = isQueue
      ? "/api/playlist/toggle-album"
      : "/api/playlist/toggle";
    const requestBody = isQueue
      ? {
        playlist_id: playlist.id,
        album_id: currentTrack.album_id,
        action: action,
      }
      : {
        playlist_id: playlist.id,
        track_uri: currentTrack.uri,
        action: action,
      };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const data = await res.json();
    if (!data.success) {
      console.error("Failed to toggle:", data.error);
      // Revert on failure
      if (action === "add") activePlaylistsMap.delete(playlist.id);
      else activePlaylistsMap.add(playlist.id);
      renderPlaylists();
      alert("Failed to update playlist: " + data.error);
    } else if (isQueue && data.track_count) {
      // Show success message with track count for album operations
      console.log(
        `${action === "add" ? "Added" : "Removed"} ${data.track_count} tracks from album`,
      );
    }
  } catch (e) {
    console.error("Error toggling:", e);
    // Revert on failure
    if (action === "add") activePlaylistsMap.delete(playlist.id);
    else activePlaylistsMap.add(playlist.id);
    alert("Network error.");
  }
}

// Fade Animation Handling
document.addEventListener("visibilitychange", () => {
  const container = document.querySelector(".app-container");
  if (container) {
    if (document.hidden) {
      // Prepare for next entry: reset animation state so user sees fade-in on return
      container.style.animation = "none";
      container.style.opacity = "0";
    } else {
      // Re-trigger the calm fade-in
      container.style.animation =
        "calmFadeIn 1.2s cubic-bezier(0.22, 1, 0.36, 1) forwards";
    }
  }
});
