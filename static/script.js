// ── Auth recovery ─────────────────────────────────────────────────────────
// Spotify refresh tokens now expire ~6 months after the user first authorized
// (enforced for existing apps on 2026-07-20). Once the backend can no longer
// refresh, its API routes return 401. Intercept those globally and send the
// user back through the login flow instead of leaving the UI silently broken.
let redirectingToLogin = false;
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401 && !redirectingToLogin) {
    redirectingToLogin = true;
    console.warn("Spotify session expired — redirecting to login.");
    window.location.href = "/login";
  }
  return res;
};

// Native loading screen readiness flags. Declared explicitly as false so the
// Swift poll can distinguish "this frontend gates the grid" (false until real
// tiles render) from an older frontend that never defines __gridReady (the
// poll treats undefined as ready to stay compatible either way).
window.__trackReady = false;
window.__gridReady = false;

// State
let currentTrack = null;
let allPlaylists = [];
let activePlaylistsMap = new Set(); // Set of Playlist IDs that contain the current track
let justSavedId = null; // Playlist ID that was just saved — gets a one-shot "save" animation
let animateNextRender = true; // stagger tile entry on track changes, not on every re-render
let colorCache = {}; // Cache extracted colors by track ID
let editMode = false; // Playlists page: tiles open the editor instead of toggling the track
let spotifyMode = false; // Playlists page: tiles open in the Spotify desktop app instead of toggling

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

// The grid's column count adapts to the available height (see renderPlaylists)
// — recompute when the layout box actually changes. A ResizeObserver on the
// section catches every cause (window resize, zoom, sidebar) — re-rendering
// only mutates the grid's children, so it can't re-trigger the observer.
let resizeRerenderTimer = null;
function scheduleGridRerender() {
  clearTimeout(resizeRerenderTimer);
  resizeRerenderTimer = setTimeout(() => {
    if (allPlaylists.length > 0) renderPlaylists();
  }, 150);
}
document.addEventListener("DOMContentLoaded", () => {
  // Both sources funnel into the same debounced rerender: the window event
  // covers plain resizes for certain; the observer additionally catches
  // section-box changes with no resize event (zoom, future layout shifts).
  window.addEventListener("resize", scheduleGridRerender);
  const section = document.querySelector(".playlist-section");
  if (section && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(scheduleGridRerender).observe(section);
  }
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
let playlistsLoaded = false; // true once fetchPlaylists has real data

// Read page identity from data attribute — works for any page defined in config.json.
// Falls back to body class checks for backward compatibility with existing HTML files.
function getPageId() {
  return document.body.dataset.pageId
    || (document.body.classList.contains("tracker-page") ? "tracker"
      : document.body.classList.contains("queue-page") ? "queue"
      : "playlists");
}

async function init() {
  // Instant render on page switches: every page is a full document load, so
  // without this the header sits on "Loading..." until the first poll returns.
  // The track playing 200ms ago is almost certainly still playing — render it
  // immediately from localStorage and let the first poll confirm or correct.
  try {
    const cached = JSON.parse(localStorage.getItem("lastKnownTrack") || "null");
    if (cached && cached.track && Date.now() - cached.ts < 60000) {
      currentTrack = cached.track;
      updateTrackInfo(cached.track);
      // Restore which tiles were lit for this track too, so the actives don't
      // flash off and back on while the fresh check is in flight.
      try {
        const act = JSON.parse(localStorage.getItem("lastActiveIds") || "null");
        if (act && act.uri === cached.track.uri && Array.isArray(act.ids)) {
          activePlaylistsMap = new Set(act.ids);
        }
      } catch (e) { /* nonfatal */ }
      checkPlaylists(cached.track.uri);
    }
  } catch (e) {
    console.warn("Failed to restore last known track:", e);
  }

  // Instant grid, same idea as the header: render the last known playlist
  // list for this page from localStorage — the config rarely changes between
  // loads, and fetchPlaylists() corrects the grid if it did. The skeleton
  // only ever shows on a true first run (nothing cached yet).
  try {
    const cachedGrid = JSON.parse(
      localStorage.getItem(`cachedPlaylists.${getPageId()}`) || "null",
    );
    if (cachedGrid && Array.isArray(cachedGrid.playlists) && cachedGrid.playlists.length > 0) {
      allPlaylists = cachedGrid.playlists;
      renderPlaylists();
    }
  } catch (e) {
    console.warn("Failed to restore cached playlists:", e);
  }

  // Start polling for the current track immediately — it only needs the
  // backend to be up, not the (slow) playlist warm-up. The native loading
  // screen watches window.__trackReady AND window.__gridReady so both the
  // track header and the real playlist tiles (not the skeleton) are visible
  // the moment the loading animation completes.
  pollCurrentTrack();

  // Fetch playlists in parallel; the grid shows a skeleton until data lands
  // (only when there was no cached list to render above).
  if (allPlaylists.length === 0) renderSkeletonGrid();
  fetchPlaylists();
}

async function fetchPlaylists() {
  try {
    const pageId = getPageId();
    const endpoint = `/api/page/${pageId}/playlists`;

    const res = await fetch(endpoint);

    if (res.status === 429) {
      console.warn("Playlists fetch rate limited, retrying in 5s...");
      renderGridMessage("SPOTIFY RATE LIMIT — RETRYING IN 5S…", "warn");
      setTimeout(fetchPlaylists, 5000);
      return;
    }

    if (!res.ok) throw new Error(`Failed to fetch playlists: ${res.status}`);

    // Keep the fetched list local until it has data — an empty interim
    // response must not clobber the cached list already on screen.
    const fetched = await res.json();

    // Check if backend is still loading playlists
    const loadingState = res.headers.get("X-Loading-State");
    const backendStillLoading = loadingState === "loading";

    if (fetched.length === 0) {
      // Only show the skeleton if nothing is rendered yet (no cached grid).
      const showSkeleton = () => {
        if (allPlaylists.length === 0) renderSkeletonGrid();
      };
      if (backendStillLoading) {
        // Backend is still loading — keep retrying without counting toward limit
        console.log("Backend still loading playlists, retrying in 2s...");
        showSkeleton();
        setTimeout(fetchPlaylists, 2000);
      } else {
        // Backend finished loading but returned 0 — count retries
        playlistRetryCount++;
        if (playlistRetryCount <= MAX_PLAYLIST_RETRIES) {
          console.log(`Playlists not ready yet, retrying in 2s... (attempt ${playlistRetryCount}/${MAX_PLAYLIST_RETRIES})`);
          showSkeleton();
          setTimeout(fetchPlaylists, 2000);
        } else if (allPlaylists.length === 0) {
          console.warn("Warning: Received 0 playlists after all retries");
          renderGridMessage("NO PLAYLISTS FOUND — CHECK BACKEND LOGS", "error");
        }
      }
    } else {
      allPlaylists = fetched;
      playlistRetryCount = 0;
      playlistsLoaded = true;
      // Remember for instant rendering on the next page load
      try {
        localStorage.setItem(
          `cachedPlaylists.${getPageId()}`,
          JSON.stringify({ ts: Date.now(), playlists: fetched }),
        );
      } catch (e) { /* storage full/unavailable — nonfatal */ }
      // Render immediately (all inactive initially) for speed
      renderPlaylists();
    }
  } catch (e) {
    console.error("Error in fetchPlaylists:", e);
    // A cached grid is better than an error screen — keep it and retry.
    if (allPlaylists.length === 0) {
      renderGridMessage(`ERROR LOADING PLAYLISTS — ${e.message}`, "error");
    } else {
      setTimeout(fetchPlaylists, 5000);
    }
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
 * Apply dynamic background gradient based on album colors.
 * Theme-aware: dark paints saturated tints over black, Daybreak paints the
 * same hue softly over paper so the album still colors the room.
 * @param {{r: number, g: number, b: number}} color - Dominant color
 */
function applyDynamicBackground(color) {
  lastAlbumColor = color;
  const { r, g, b } = color;

  const gradient = currentTheme === "light"
    ? `
        radial-gradient(
            ellipse at 20% 30%,
            rgba(${r}, ${g}, ${b}, 0.22) 0%,
            rgba(${r}, ${g}, ${b}, 0.12) 40%,
            transparent 70%
        ),
        radial-gradient(
            ellipse at 80% 70%,
            rgba(${Math.floor(r * 0.7)}, ${Math.floor(g * 0.7)}, ${Math.floor(b * 0.7)}, 0.16) 0%,
            rgba(${Math.floor(r * 0.5)}, ${Math.floor(g * 0.5)}, ${Math.floor(b * 0.5)}, 0.08) 50%,
            transparent 80%
        ),
        #eef0e8
    `
    : `
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

// ============================================
// Theme — dark (default) + "Daybreak" light twin
// Persisted choice, toggle button in the header on every page, and a
// customizable shortcut (default ⌘⇧L) handled by the grid-shortcut system.
// ============================================
const THEME_KEY = "dashTheme";
let currentTheme = "dark";
let lastAlbumColor = null;
try {
  if (localStorage.getItem(THEME_KEY) === "light") currentTheme = "light";
} catch (e) { /* storage unavailable — stay dark */ }

function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  document.body.classList.toggle("theme-light", currentTheme === "light");
  try {
    localStorage.setItem(THEME_KEY, currentTheme);
  } catch (e) { /* nonfatal */ }
  updateThemeToggleUI();
  // Re-tint the album background for the new substrate; with no album color
  // yet, drop any inline background so the per-theme CSS default shows.
  if (lastAlbumColor) applyDynamicBackground(lastAlbumColor);
  else document.body.style.background = "";
}

function toggleTheme() {
  applyTheme(currentTheme === "light" ? "dark" : "light");
}

// Icon shows the theme you'll GET: sun while dark, moon while light.
function updateThemeToggleUI() {
  const btn = document.getElementById("theme-toggle");
  const icon = document.getElementById("theme-toggle-icon");
  if (!btn || !icon) return;
  const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const moon = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  icon.innerHTML = currentTheme === "dark" ? sun : moon;
  const label = currentTheme === "dark" ? "light" : "dark";
  const combo = (typeof gridShortcuts !== "undefined" && gridShortcuts.theme)
    ? ` (${shortcutLabel(gridShortcuts.theme)})` : "";
  btn.title = `Switch to ${label} theme${combo}`;
  btn.setAttribute("aria-label", `Switch to ${label} theme`);
}

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(currentTheme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.addEventListener("click", toggleTheme);
});

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
              animateNextRender = true; // new track → staggered tile entry
              renderPlaylists();
              await checkPlaylists(track.uri);
            } catch (err) {
              console.error("Error checking playlists:", err);
            }

            // If sidebar is already open, update it for the new track
            if (typeof sidebarState !== "undefined" && sidebarState.isOpen) {
              showArtistSidebar(track);
            }
          }
        }
        // Remember for instant rendering on the next page load
        try {
          localStorage.setItem(
            "lastKnownTrack",
            JSON.stringify({ ts: Date.now(), track }),
          );
        } catch (e) { /* storage full/unavailable — nonfatal */ }
      } else {
        updateTrackInfo(null);
        try {
          localStorage.removeItem("lastKnownTrack");
        } catch (e) { /* nonfatal */ }
      }
      // Either outcome is a settled answer — the native loading screen can
      // lift. Set unconditionally: when the optimistic restore already
      // rendered this same track, the change-guard above skips, and the flag
      // must still flip.
      window.__trackReady = true;
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

let cacheWarmupRecheckTimer = null;

async function checkPlaylists(trackUri) {
  try {
    const res = await fetch(
      `/api/check-playlists?track_uri=${encodeURIComponent(trackUri)}`,
    );
    if (res.ok) {
      const activeIds = await res.json();
      activePlaylistsMap = new Set(activeIds);
      // Remember for instant active-state restore on the next page load
      try {
        localStorage.setItem(
          "lastActiveIds",
          JSON.stringify({ ts: Date.now(), uri: trackUri, ids: activeIds }),
        );
      } catch (e) { /* nonfatal */ }
      renderPlaylists();

      // While the backend's per-playlist track caches are still warming
      // (launch with a stale persisted cache, or a first run with none),
      // the answer may be incomplete — re-check until it reports fresh data.
      if (res.headers.get("X-Cache-State") === "warming") {
        clearTimeout(cacheWarmupRecheckTimer);
        cacheWarmupRecheckTimer = setTimeout(() => {
          if (currentTrack && currentTrack.uri === trackUri) {
            checkPlaylists(trackUri);
          }
        }, 10000);
      }
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

  if (track) {
    // Universal: Update Album Cover
    if (albumCover && track.album_cover) {
      albumCover.src = track.album_cover;
      albumCover.style.display = "block";
    }

    if (isQueue) {
      // Queue page: show album name + release metadata
      if (title) title.textContent = track.album || "Unknown Album";
      const meta = document.getElementById("album-meta");
      if (meta) {
        const parts = [];
        if (track.album_release_date) parts.push(`RELEASED ${formatDateMDY(track.album_release_date)}`);
        if (track.album_total_tracks) parts.push(`${track.album_total_tracks} TRACKS`);
        meta.textContent = parts.join(" · ");
      }
    } else {
      // Other pages: show track title and artist
      if (title) title.textContent = track.name;
      if (artist) artist.textContent = track.artist;
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

      // Update UI from track payload, but ignore if we recently clicked it (optimistic lock).
      // Only illuminate for single-track repeat ("track"). Album/context repeat
      // ("context") and "off" both leave the icon dim — the button toggles repeat-one.
      if (!repeatIcon.hasAttribute("data-optimistic-lock")) {
        if (track.repeat_state === "track") {
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
      const meta = document.getElementById("album-meta");
      if (meta) meta.textContent = "";
    } else {
      if (title) title.textContent = "Not Playing";
      if (artist) artist.textContent = "Play a song on Spotify";
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

/** Format a Spotify release date (YYYY-MM-DD / YYYY-MM / YYYY) as MM-DD-YY. */
function formatDateMDY(raw) {
  const parts = String(raw).split("-");
  const yy = (parts[0] || "").slice(2);
  if (parts.length >= 3) return `${parts[1]}-${parts[2]}-${yy}`;
  if (parts.length === 2) return `${parts[1]}-01-${yy}`;
  return `01-01-${yy}`;
}

// ============================================
// Grid loading / message states
// ============================================
function renderSkeletonGrid() {
  const grid = document.getElementById("playlist-grid");
  if (!grid) return;
  const isLinear =
    document.body.classList.contains("tracker-page") ||
    document.body.classList.contains("queue-page");
  const wrap = document.createElement("div");
  wrap.className = isLinear ? "skel-list" : "skel-grid";
  const count = isLinear ? 8 : 12;
  for (let i = 0; i < count; i++) {
    const tile = document.createElement("div");
    tile.className = "skel-tile";
    tile.style.animationDelay = `${(i % 6) * 90}ms`;
    wrap.appendChild(tile);
  }
  grid.innerHTML = "";
  grid.appendChild(wrap);
}

/** Full-grid status message. kind: "" (neutral) | "warn" (amber) | "error" (red). */
function renderGridMessage(message, kind = "") {
  const grid = document.getElementById("playlist-grid");
  if (!grid) return;
  const div = document.createElement("div");
  div.className = `grid-message ${kind}`.trim();
  div.textContent = message;
  grid.innerHTML = "";
  grid.appendChild(div);
  // A terminal error is a settled state — don't leave the native loading
  // screen hanging on __gridReady (its 15s cap would lift it anyway).
  if (kind === "error") window.__gridReady = true;
}

// The NAGA playlists ("NAGA NEXT SHOW" and "NAGA NEXT SHOW - PACK") are special:
// they get a premium holographic treatment instead of the standard green tile.
function isSpecialPlaylist(playlist) {
  const name = (playlist && playlist.name ? playlist.name : "").toUpperCase();
  return name.includes("NAGA NEXT SHOW");
}

function renderPlaylists() {
  const grid = document.getElementById("playlist-grid");

  // The track poller runs in parallel with the playlist fetch and triggers
  // renders; don't let those wipe the "Loading playlists…" placeholder
  // before any playlist data has arrived.
  if (!playlistsLoaded && allPlaylists.length === 0) return;

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
    const justSaved = isActive && playlist.id === justSavedId;
    item.className = "playlist-item";
    if (isActive) item.classList.add("active");
    if (justSaved) item.classList.add("just-saved");
    if (isSpecialPlaylist(playlist)) item.classList.add("naga-special");

    if (editMode && !isTracker && !isQueue) {
      item.classList.add("editable");
    }
    item.onclick = (e) => {
      // ⌘-click always opens the playlist in the Spotify desktop app,
      // regardless of mode (works on every page).
      if (e.metaKey) {
        openPlaylistInSpotify(playlist);
        return;
      }
      if (editMode && !isTracker && !isQueue) {
        // Edit mode: clicking a tile edits it instead of toggling the track
        openEditor("edit", playlist);
      } else if (spotifyMode && !isTracker && !isQueue) {
        // Spotify mode: clicking a tile opens it in the Spotify desktop app
        openPlaylistInSpotify(playlist);
      } else {
        // Use ID for toggling
        togglePlaylist(playlist);
      }
    };

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

    if (editMode && !isTracker && !isQueue) {
      const del = document.createElement("button");
      del.className = "tile-delete-btn";
      del.type = "button";
      del.setAttribute("aria-label", `Remove ${playlist.name}`);
      del.textContent = "✕";
      del.onclick = (e) => {
        e.stopPropagation();
        deletePlaylistItem(playlist);
      };
      item.appendChild(del);
    }

    return item;
  };

  if (isTracker || isQueue) {
    // Tracker/Queue Logic: Linear Rendering, Strict Order.
    // Dividers split the list into sections; a divider with a "label" in
    // config.json names the section that follows and renders as a vertical
    // rail. Unlabeled dividers stay plain separator lines (today's look).
    const linearGroup = document.createElement("div");
    linearGroup.className = isTracker ? "tracker-list" : "queue-list";

    const sections = [];
    let cur = { label: null, items: [] };
    allPlaylists.forEach((p) => {
      if (p.is_divider) {
        sections.push(cur);
        cur = { label: p.label || null, items: [] };
      } else {
        cur.items.push(p);
      }
    });
    sections.push(cur);

    sections.forEach((sec, idx) => {
      if (sec.items.length === 0 && !sec.label) return;
      if (idx > 0 && !sec.label) {
        const div = document.createElement("div");
        div.className = "section-divider-green";
        linearGroup.appendChild(div);
      }
      if (sec.label) {
        const group = document.createElement("div");
        group.className = "rail-group";
        group.style.flexGrow = String(Math.max(sec.items.length, 1));
        const rail = document.createElement("div");
        rail.className = "rail-label";
        rail.textContent = sec.label;
        const col = document.createElement("div");
        col.className = "rail-col";
        sec.items.forEach((p) => col.appendChild(createItem(p)));
        group.appendChild(rail);
        group.appendChild(col);
        linearGroup.appendChild(group);
      } else {
        sec.items.forEach((p) => linearGroup.appendChild(createItem(p)));
      }
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
      // minmax(0, 1fr) lets rows compress below content height when the
      // vertical budget tightens
      activeGroup.style.gridTemplateRows = `repeat(${activeRowCount}, minmax(0, 1fr))`;
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
      inactiveGroup.style.gridTemplateRows = `repeat(${rowCount}, minmax(0, 1fr))`;
      inactivePlaylists.forEach((p) =>
        inactiveGroup.appendChild(createItem(p)),
      );
      grid.appendChild(inactiveGroup);

      // Fit guarantee: 3 columns is the default, but on a short window the
      // rows would compress below a readable tile height (the page used to
      // crop the bottom instead — 08-28-26). Width is the abundant dimension
      // here, so add columns until every row keeps at least a full text line,
      // capped so columns stay wide enough for names to remain useful.
      const cs = getComputedStyle(inactiveGroup);
      const gap = parseFloat(cs.rowGap) || 0;
      const nameEl = inactiveGroup.querySelector(".playlist-name");
      const fontPx = nameEl ? parseFloat(getComputedStyle(nameEl).fontSize) : 16;
      const minRow = Math.ceil(fontPx * 1.3) + 12; // text line + padding + borders
      const avail = inactiveGroup.clientHeight; // flex-allocated, independent of row count
      const n = inactivePlaylists.length;
      const maxRows = Math.max(1, Math.floor((avail + gap) / (minRow + gap)));
      const colsByWidth = Math.max(3, Math.floor(inactiveGroup.clientWidth / 260));
      const cols = Math.min(Math.max(3, Math.ceil(n / maxRows)), colsByWidth);
      if (cols > 3) {
        inactiveGroup.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        inactiveGroup.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))`;
      }
    }
  }

  // Staggered entry on track changes only — re-renders from toggles or
  // polling must not replay the animation.
  if (animateNextRender) {
    animateNextRender = false;
    grid.querySelectorAll(".playlist-item").forEach((el, i) => {
      el.classList.add("tile-enter");
      el.style.animationDelay = `${Math.min(i * 12, 360)}ms`;
    });
  }

  // One-shot save animation should only play on the render right after a save.
  justSavedId = null;

  // Real tiles are on screen (not the skeleton) — the native loading screen
  // waits on this alongside __trackReady before lifting.
  window.__gridReady = true;
}

async function togglePlaylist(playlist) {
  if (!currentTrack) return;

  const isCurrentlyActive = activePlaylistsMap.has(playlist.id);
  const action = isCurrentlyActive ? "remove" : "add";
  const isQueue = document.body.classList.contains("queue-page");
  const isTracker = document.body.classList.contains("tracker-page");

  // Optimistic Update
  if (action === "add") {
    activePlaylistsMap.add(playlist.id);
    justSavedId = playlist.id; // trigger one-shot "just saved" animation on render
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

    // On the Tracker page, adding a track also follows its main artist
    if (isTracker && action === "add") {
      requestBody.follow_artist = true;
      requestBody.artist_id = currentTrack.artist_id || null;
    }

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
    } else {
      if (isQueue && data.track_count) {
        // Show success message with track count for album operations
        console.log(
          `${action === "add" ? "Added" : "Removed"} ${data.track_count} tracks from album`,
        );
      }

      // Trigger sidebar on ADD only (Playlists & Tracker pages), and only when
      // auto-reveal is armed — an already-open sidebar still refreshes.
      if (action === "add" && !isQueue && currentTrack) {
        // Tracker adds auto-follow the main artist server-side; patch any
        // cached sidebar entry so its follow button isn't stale
        if (isTracker && data.artist_followed) {
          const mainArtist = currentTrack.artist.split(",")[0].trim();
          const cached = sidebarState.artistCache[mainArtist];
          if (cached && cached !== "empty") cached.is_following = true;
          showToast(`Now following ${mainArtist}`);
        }
        if (sidebarAutoReveal || sidebarState.isOpen) showArtistSidebar(currentTrack);
      }
    }
  } catch (e) {
    console.error("Error toggling:", e);
    // Revert on failure
    if (action === "add") activePlaylistsMap.delete(playlist.id);
    else activePlaylistsMap.add(playlist.id);
    alert("Network error.");
  }
}

// ============================================
// Open in Spotify desktop app
// ============================================
async function openPlaylistInSpotify(playlist) {
  if (!playlist || !playlist.id || playlist.is_divider) return;
  try {
    const res = await fetch("/api/open-in-spotify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_id: playlist.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    showToast(`Opening “${playlist.spotify_name || playlist.name}” in Spotify`);
  } catch (e) {
    console.error("Error opening playlist in Spotify:", e);
    showToast("Couldn’t open in Spotify — is the app installed?", "error");
  }
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = "success") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = type === "error" ? "toast error" : "toast";
  toast.textContent = message;
  container.appendChild(toast);

  // Enter on the next frame so the transition actually plays
  requestAnimationFrame(() => toast.classList.add("show"));

  setTimeout(() => {
    toast.classList.remove("show");
    toast.addEventListener("transitionend", () => toast.remove(), {
      once: true,
    });
    setTimeout(() => toast.remove(), 600); // fallback if transitionend never fires
  }, 3500);
}

// ============================================
// Artist Release Sidebar
// ============================================
let sidebarState = {
  isOpen: false,
  currentRelease: null,    // The fetched release data
  queuePlaylists: [],      // Queue playlists for the sidebar
  queueActiveMap: new Set(), // Active queue playlist IDs for sidebar album
  artistCache: {},         // Cache: artistName -> release data
  isLibrarySaved: false,
  isFollowing: false,
};

// ============================================
// Sidebar auto-reveal — header button on every page that has a sidebar.
// Governs whether the sidebar exposes ITSELF (on an add); opening it by hand
// (header button, edge handle, ⌘S) always works either way. Persisted, so the
// choice carries across pages and reloads.
// ============================================
const SIDEBAR_AUTO_KEY = "sidebarAutoReveal";
let sidebarAutoReveal = true;
try {
  if (localStorage.getItem(SIDEBAR_AUTO_KEY) === "off") sidebarAutoReveal = false;
} catch (e) { /* storage unavailable — stay auto */ }

function applySidebarAuto(on) {
  sidebarAutoReveal = !!on;
  try {
    localStorage.setItem(SIDEBAR_AUTO_KEY, sidebarAutoReveal ? "on" : "off");
  } catch (e) { /* nonfatal */ }
  updateSidebarAutoUI();
}

// Filled panel = comes out on its own; dashed outline = manual only.
function updateSidebarAutoUI() {
  const btn = document.getElementById("sidebar-auto-toggle");
  const icon = document.getElementById("sidebar-auto-toggle-icon");
  if (!btn || !icon) return;
  const frame = '<rect x="3" y="4" width="18" height="16" rx="2"/>';
  icon.innerHTML = sidebarAutoReveal
    ? frame + '<path d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5z" fill="currentColor" stroke="none"/>'
    : frame + '<line x1="14" y1="4" x2="14" y2="20" stroke-dasharray="2.5 2.5"/>';
  btn.classList.toggle("active", sidebarAutoReveal);
  btn.setAttribute("aria-pressed", sidebarAutoReveal ? "true" : "false");
  const label = sidebarAutoReveal
    ? "Sidebar reveals itself on add — click to keep it closed"
    : "Sidebar stays closed — click to reveal it automatically";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

// Flipping the switch also acts on the sidebar now, so the setting is legible
// the moment you press it.
function toggleSidebarAuto() {
  applySidebarAuto(!sidebarAutoReveal);
  if (sidebarAutoReveal !== sidebarState.isOpen) toggleSidebar();
  showToast(sidebarAutoReveal ? "Sidebar auto-reveal ON" : "Sidebar auto-reveal OFF");
}

/**
 * Initialize sidebar toggle and event listeners
 */
function initSidebar() {
  const sidebar = document.getElementById("artist-sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");
  if (!sidebar || !toggleBtn) return;

  toggleBtn.addEventListener("click", () => {
    toggleSidebar();
  });

  const autoBtn = document.getElementById("sidebar-auto-toggle");
  if (autoBtn) autoBtn.addEventListener("click", toggleSidebarAuto);
  updateSidebarAutoUI();

  // Fetch queue playlists for sidebar use
  fetchQueuePlaylistsForSidebar();
}

/**
 * Fetch queue playlists from the API for use in the sidebar.
 * Retries if backend is still loading, same pattern as fetchPlaylists().
 */
async function fetchQueuePlaylistsForSidebar() {
  try {
    const res = await fetch("/api/page/queue/playlists");
    if (!res.ok) return;

    const playlists = await res.json();
    const loadingState = res.headers.get("X-Loading-State");

    if (playlists.length === 0 && loadingState === "loading") {
      // Backend still warming up — retry in 2s
      setTimeout(fetchQueuePlaylistsForSidebar, 2000);
      return;
    }

    sidebarState.queuePlaylists = playlists;
  } catch (e) {
    console.error("Error fetching queue playlists for sidebar:", e);
  }
}

/**
 * Toggle sidebar open/closed
 */
function toggleSidebar() {
  const sidebar = document.getElementById("artist-sidebar");
  if (!sidebar) return;

  // If opening, ensure data is loaded for the current track
  if (!sidebarState.isOpen) {
    if (typeof currentTrack !== "undefined" && currentTrack) {
      showArtistSidebar(currentTrack);
      return;
    } else {
      sidebarState.isOpen = true;
      sidebar.classList.add("open");
      document.querySelector(".playlist-section")?.classList.add("sidebar-open");
      document.body.classList.add("sidebar-open");
    }
  } else {
    // Closing
    sidebarState.isOpen = false;
    sidebar.classList.remove("open");
    document.querySelector(".playlist-section")?.classList.remove("sidebar-open");
    document.body.classList.remove("sidebar-open");
  }
}

/**
 * Show sidebar with artist's latest release
 */
async function showArtistSidebar(track) {
  const sidebar = document.getElementById("artist-sidebar");
  if (!sidebar) return;

  // Get first artist name (handle comma-separated)
  const artistName = track.artist.split(",")[0].trim();

  // Check cache first
  if (sidebarState.artistCache[artistName]) {
    if (sidebarState.artistCache[artistName] === "empty" || sidebarState.artistCache[artistName].isEmpty) {
      populateEmptySidebar(artistName, sidebarState.artistCache[artistName]);
    } else {
      populateSidebar(sidebarState.artistCache[artistName]);
    }
    if (!sidebarState.isOpen) {
      sidebarState.isOpen = true;
      sidebar.classList.add("open");
      document.querySelector(".playlist-section")?.classList.add("sidebar-open");
      document.body.classList.add("sidebar-open");
    }
    return;
  }

  // Show loading state
  const content = document.getElementById("sidebar-content");
  if (content) content.classList.add("sidebar-loading");

  // Open sidebar
  if (!sidebarState.isOpen) {
    sidebarState.isOpen = true;
    sidebar.classList.add("open");
    document.querySelector(".playlist-section")?.classList.add("sidebar-open");
    document.body.classList.add("sidebar-open");
  }

    try {
      const res = await fetch(`/api/artist-latest-release?artist_name=${encodeURIComponent(artistName)}`);
      if (!res.ok) {
        if (res.status === 404) {
          const errData = await res.json().catch(() => ({}));
          const emptyData = { isEmpty: true, artist_id: errData.artist_id, is_following: errData.is_following };
          sidebarState.artistCache[artistName] = emptyData;
          populateEmptySidebar(artistName, emptyData);
        } else {
          const errData = await res.json().catch(() => ({}));
          console.warn("Failed to fetch artist latest release:", errData?.error);
        }
        if (content) content.classList.remove("sidebar-loading");
        return;
      }
  
      const release = await res.json();
      sidebarState.artistCache[artistName] = release;
      populateSidebar(release);
  
    } catch (e) {
    console.error("Error fetching artist release:", e);
  } finally {
    if (content) content.classList.remove("sidebar-loading");
  }
}

/**
 * Populate sidebar UI with release data
 */
async function populateSidebar(release) {
  const content = document.getElementById("sidebar-content");
  if (content) content.classList.remove("empty-state");

  sidebarState.currentRelease = release;

  // Artwork
  const artwork = document.getElementById("sidebar-artwork");
  if (artwork && release.artwork) {
    artwork.src = release.artwork;
    artwork.alt = `${release.name} artwork`;
  }

  // Badge
  const badge = document.getElementById("sidebar-release-badge");
  if (badge) badge.textContent = release.type || "ALBUM";

  // Meta
  const releaseName = document.getElementById("sidebar-release-name");
  if (releaseName) releaseName.textContent = release.name || "—";

  const artistName = document.getElementById("sidebar-artist-name");
  if (artistName) artistName.textContent = release.artist_name || "—";

  const releaseDate = document.getElementById("sidebar-release-date");
  if (releaseDate) releaseDate.textContent = release.formatted_date ? `Released ${release.formatted_date}` : "—";

  // Check library status
  await checkAlbumLibraryStatus(release.id);

  // Ensure queue playlists are loaded before rendering
  if (sidebarState.queuePlaylists.length === 0) {
    await fetchQueuePlaylistsForSidebar();
  }

  // Render queue items
  renderSidebarQueue();

  // Ensure buttons are visible if they were hidden by an empty state
  const libraryBtn = document.getElementById("sidebar-library-btn");
  if (libraryBtn) libraryBtn.style.display = "flex";
  
  // Wire up library button
  setupLibraryButton(release.id);

  // Wire up follow button
  sidebarState.isFollowing = release.is_following || false;
  setupFollowButton(release.artist_id);
}

/**
 * Render elegant empty state when no recent release is found
 */
function populateEmptySidebar(artistName, data = null) {
  sidebarState.currentRelease = null;
  const content = document.getElementById("sidebar-content");
  if (content) content.classList.add("empty-state");

  const releaseName = document.getElementById("sidebar-release-name");
  if (releaseName) releaseName.textContent = "No Recent Releases";

  const artistNameEl = document.getElementById("sidebar-artist-name");
  if (artistNameEl) artistNameEl.textContent = `for ${artistName}`;

  if (data && data.artist_id) {
    sidebarState.isFollowing = data.is_following || false;
    setupFollowButton(data.artist_id);
  } else {
    // Hide follow button if we don't have artist ID
    const followBtn = document.getElementById("sidebar-follow-btn");
    if (followBtn) followBtn.style.display = "none";
  }
  
  // Hide library button in empty state
  const libraryBtn = document.getElementById("sidebar-library-btn");
  if (libraryBtn) libraryBtn.style.display = "none";
}

/**
 * Check if album is in user's library
 */
async function checkAlbumLibraryStatus(albumId) {
  try {
    const res = await fetch(`/api/check-album-library?album_id=${encodeURIComponent(albumId)}`);
    if (res.ok) {
      const data = await res.json();
      sidebarState.isLibrarySaved = data.is_saved || false;
      updateLibraryButtonUI();
    }
  } catch (e) {
    console.error("Error checking album library status:", e);
  }
}

/**
 * Update which queue playlists contain the current sidebar album
 */
async function checkSidebarQueueStatus(albumId) {
  sidebarState.queueActiveMap.clear();

  // We need to check if the album's tracks exist in queue playlists
  // Use the existing check-playlists endpoint with album tracks
  // For efficiency, we'll just check the first track of the album as a proxy
  // This is imperfect but avoids excessive API calls
  try {
    // We don't have a direct "check album in playlist" endpoint,
    // so we skip auto-checking for now and let the user toggle manually
    // The UI will start with all queue items inactive
  } catch (e) {
    console.error("Error checking sidebar queue status:", e);
  }
}

/**
 * Update the library button UI based on state
 */
function updateLibraryButtonUI() {
  const btn = document.getElementById("sidebar-library-btn");
  const btnText = document.getElementById("library-btn-text");
  if (!btn || !btnText) return;

  if (sidebarState.isLibrarySaved) {
    btn.classList.add("saved");
    btnText.textContent = "In Library";
  } else {
    btn.classList.remove("saved");
    btnText.textContent = "Save to Library";
  }
}

/**
 * Set up library button click handler
 */
function setupLibraryButton(albumId) {
  const btn = document.getElementById("sidebar-library-btn");
  if (!btn) return;

  // Remove old handler by cloning
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener("click", async () => {
    const action = sidebarState.isLibrarySaved ? "remove" : "add";

    // Optimistic update
    sidebarState.isLibrarySaved = !sidebarState.isLibrarySaved;
    updateLibraryButtonUI();

    try {
      const res = await fetch("/api/album-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ album_id: albumId, action }),
      });

      const data = await res.json();
      if (!data.success) {
        // Revert
        sidebarState.isLibrarySaved = !sidebarState.isLibrarySaved;
        updateLibraryButtonUI();
        console.error("Failed to toggle library:", data.error);
      }
    } catch (e) {
      // Revert
      sidebarState.isLibrarySaved = !sidebarState.isLibrarySaved;
      updateLibraryButtonUI();
      console.error("Error toggling album library:", e);
    }
  });
}

/**
 * Update follow button UI based on state
 */
function updateFollowButtonUI() {
  const btn = document.getElementById("sidebar-follow-btn");
  const btnText = document.getElementById("follow-btn-text");
  if (!btn || !btnText) return;

  if (sidebarState.isFollowing) {
    btn.classList.add("saved"); // Use same styling class as library button for consistency
    btnText.textContent = "Following";
  } else {
    btn.classList.remove("saved");
    btnText.textContent = "Follow";
  }
}

/**
 * Set up follow button click handler
 */
function setupFollowButton(artistId) {
  const btn = document.getElementById("sidebar-follow-btn");
  if (!btn || !artistId) {
    if (btn) btn.style.display = "none";
    return;
  }
  
  btn.style.display = "flex"; // Ensure it's visible if we have an artist ID

  // Remove old handler by cloning
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);

  newBtn.addEventListener("click", async () => {
    const action = sidebarState.isFollowing ? "remove" : "add";

    // Optimistic update
    sidebarState.isFollowing = !sidebarState.isFollowing;
    updateFollowButtonUI();

    try {
      const res = await fetch("/api/toggle-artist-follow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artist_id: artistId, action }),
      });

      const data = await res.json();
      if (!data.success) {
        // Revert
        sidebarState.isFollowing = !sidebarState.isFollowing;
        updateFollowButtonUI();
        console.error("Failed to toggle follow:", data.error);
      }
    } catch (e) {
      // Revert
      sidebarState.isFollowing = !sidebarState.isFollowing;
      updateFollowButtonUI();
      console.error("Error toggling follow:", e);
    }
  });

  // Initial UI state
  updateFollowButtonUI();
}

/**
 * Render queue playlist items in the sidebar
 */
function renderSidebarQueue() {
  const list = document.getElementById("sidebar-queue-list");
  if (!list) return;
  list.innerHTML = "";

  sidebarState.queuePlaylists.forEach((qp) => {
    if (qp.is_divider) {
      const divider = document.createElement("div");
      divider.className = "sidebar-queue-divider";
      list.appendChild(divider);
      return;
    }

    const isActive = sidebarState.queueActiveMap.has(qp.id);

    const item = document.createElement("div");
    item.className = `sidebar-queue-item ${isActive ? "active" : ""}`;
    item.onclick = (e) => {
      // ⌘-click opens the playlist in the Spotify desktop app (same as the grid)
      if (e.metaKey) {
        openPlaylistInSpotify(qp);
        return;
      }
      toggleSidebarQueueItem(qp);
    };

    const nameSpan = document.createElement("span");
    nameSpan.className = "sidebar-queue-name";
    nameSpan.textContent = qp.name;

    // Hover-revealed "open in Spotify" button (space always reserved — fades in)
    const openBtn = document.createElement("button");
    openBtn.className = "sidebar-queue-open";
    openBtn.type = "button";
    openBtn.title = `Open "${qp.spotify_name || qp.name}" in Spotify`;
    openBtn.setAttribute("aria-label", `Open ${qp.name} in Spotify`);
    openBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.586 14.424a.622.622 0 0 1-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 1 1-.277-1.215c3.809-.87 7.077-.496 9.712 1.115.293.18.386.563.207.857zm1.223-2.723a.78.78 0 0 1-1.072.257c-2.687-1.652-6.785-2.131-9.965-1.166A.779.779 0 1 1 6.32 11.3c3.632-1.102 8.147-.568 11.234 1.328a.78.78 0 0 1 .255 1.073zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71a.935.935 0 1 1-.543-1.79c3.532-1.072 9.404-.865 13.115 1.338a.936.936 0 0 1-.955 1.608z"/></svg>';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      openPlaylistInSpotify(qp);
    };

    const check = document.createElement("div");
    check.className = "sidebar-queue-check";
    check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

    item.appendChild(nameSpan);
    item.appendChild(openBtn);
    item.appendChild(check);
    list.appendChild(item);
  });
}

/**
 * Toggle album in a queue playlist from the sidebar
 */
async function toggleSidebarQueueItem(queuePlaylist) {
  if (!sidebarState.currentRelease) return;

  const albumId = sidebarState.currentRelease.id;
  const isActive = sidebarState.queueActiveMap.has(queuePlaylist.id);
  const action = isActive ? "remove" : "add";

  // Optimistic update
  if (action === "add") {
    sidebarState.queueActiveMap.add(queuePlaylist.id);
    // Copy Spotify playlist name to clipboard on add (mirrors Queue page behavior)
    if (queuePlaylist.spotify_name) {
      navigator.clipboard.writeText(queuePlaylist.spotify_name).catch((err) => {
        console.error("Failed to copy playlist name:", err);
      });
    }
  } else {
    sidebarState.queueActiveMap.delete(queuePlaylist.id);
  }
  renderSidebarQueue();

  try {
    const res = await fetch("/api/playlist/toggle-album", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlist_id: queuePlaylist.id,
        album_id: albumId,
        action: action,
      }),
    });

    const data = await res.json();
    if (!data.success) {
      // Revert
      if (action === "add") sidebarState.queueActiveMap.delete(queuePlaylist.id);
      else sidebarState.queueActiveMap.add(queuePlaylist.id);
      renderSidebarQueue();
      console.error("Failed to toggle queue album:", data.error);
    } else {
      console.log(`Sidebar: ${action === "add" ? "Added" : "Removed"} ${data.track_count || "?"} tracks from album in queue`);
    }
  } catch (e) {
    // Revert
    if (action === "add") sidebarState.queueActiveMap.delete(queuePlaylist.id);
    else sidebarState.queueActiveMap.add(queuePlaylist.id);
    renderSidebarQueue();
    console.error("Error toggling sidebar queue:", e);
  }
}

// Initialize sidebar on DOM ready (for playlists and tracker pages only)
document.addEventListener("DOMContentLoaded", () => {
  const isQueue = document.body.classList.contains("queue-page");
  if (!isQueue) {
    initSidebar();
  }
});

// ⌘S fallback: the desktop app's native key monitor normally handles ⌘S and
// swallows the event before it reaches the page, so this never double-fires.
// It only catches what the native layer misses — and makes ⌘S work when the
// dashboard is opened in a regular browser (where it also blocks "Save Page").
document.addEventListener("keydown", (e) => {
  if (e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    toggleSidebar();
  }
});

// ============================================
// Playlist Editor (playlists page only)
// Add / edit / remove the tiles shown on this page. Only the dashboard's
// config is changed — the Spotify playlists themselves are never touched.
// ============================================
const editorState = {
  mode: "add", // "add" | "edit"
  original: null, // playlist entry being edited (as served by the backend)
  selected: null, // {id, name} chosen Spotify playlist
  spotifyPlaylists: null, // cached picker list
};

function initPlaylistEditor() {
  const editBtn = document.getElementById("edit-mode-btn");
  const addBtn = document.getElementById("add-playlist-btn");
  const spotifyBtn = document.getElementById("spotify-mode-btn");
  const overlay = document.getElementById("playlist-editor-overlay");
  if (!editBtn || !addBtn || !overlay) return;

  editBtn.addEventListener("click", toggleEditMode);
  addBtn.addEventListener("click", () => openEditor("add"));
  if (spotifyBtn) spotifyBtn.addEventListener("click", toggleSpotifyMode);
  const cancelBtn = document.getElementById("cancel-mode-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", cancelArmedMode);

  document.getElementById("editor-cancel").addEventListener("click", closeEditor);
  document.getElementById("editor-save").addEventListener("click", saveEditor);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditor();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeEditor();
  });

  const search = document.getElementById("editor-spotify-search");
  search.addEventListener("input", () => renderSpotifyPicker(search.value));
}

// Shortcuts run on every page (theme toggle is global); the modal wiring
// inside initGridShortcuts self-skips where the markup doesn't exist.
document.addEventListener("DOMContentLoaded", initGridShortcuts);

function toggleEditMode() {
  editMode = !editMode;
  if (editMode && spotifyMode) setSpotifyMode(false); // modes are exclusive
  document.body.classList.toggle("edit-mode", editMode);
  const btn = document.getElementById("edit-mode-btn");
  if (btn) {
    btn.classList.toggle("active", editMode);
    const label = btn.querySelector(".btn-label");
    if (label) label.textContent = editMode ? "✓ DONE" : "✎ EDIT";
  }
  updateModeBanner();
  renderPlaylists();
}

function setSpotifyMode(on) {
  spotifyMode = on;
  document.body.classList.toggle("spotify-mode", spotifyMode);
  const btn = document.getElementById("spotify-mode-btn");
  if (btn) btn.classList.toggle("active", spotifyMode);
  updateModeBanner();
  renderPlaylists();
}

// Escape hatch out of edit / spotify mode — the CANCEL button, its shortcut
// (C by default) and Esc all land here. Tile edits and removals are written
// through as they happen, so this leaves the mode rather than undoing them.
function cancelArmedMode() {
  if (editMode) toggleEditMode();
  else if (spotifyMode) setSpotifyMode(false);
}

// CANCEL only exists while a mode is armed — nothing to cancel otherwise.
function updateCancelButton() {
  const btn = document.getElementById("cancel-mode-btn");
  if (btn) btn.hidden = !(editMode || spotifyMode);
}

// Labeled strip under the toolbar while a mode is armed, so a click's
// meaning is never a surprise.
function updateModeBanner() {
  updateCancelButton();
  const banner = document.getElementById("mode-banner");
  if (!banner) return;
  if (editMode) {
    banner.textContent = "EDIT MODE — CLICK A TILE TO EDIT IT · ✕ REMOVES IT FROM THIS PAGE";
    banner.className = "mode-banner edit";
    banner.hidden = false;
  } else if (spotifyMode) {
    banner.textContent = "SPOTIFY MODE — CLICK A PLAYLIST TO OPEN IT IN THE SPOTIFY APP";
    banner.className = "mode-banner spotify";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function toggleSpotifyMode() {
  if (!spotifyMode && editMode) toggleEditMode(); // modes are exclusive
  setSpotifyMode(!spotifyMode);
}

// ============================================
// Customizable grid shortcuts (playlists page)
// Defaults: N = new, E = edit, S = spotify. Click-to-record in the
// KEYBOARD SHORTCUTS modal; persisted in localStorage.
// ============================================
const SHORTCUTS_STORAGE_KEY = "gridShortcuts.v1";
const SHORTCUT_DEFAULTS = {
  new: { key: "n", meta: false, ctrl: false, alt: false, shift: false },
  edit: { key: "e", meta: false, ctrl: false, alt: false, shift: false },
  cancel: { key: "c", meta: false, ctrl: false, alt: false, shift: false },
  spotify: { key: "s", meta: false, ctrl: false, alt: false, shift: false },
  theme: { key: "l", meta: true, ctrl: false, alt: false, shift: true },
};
let gridShortcuts = loadGridShortcuts();
let recordingAction = null; // action id while a recorder is capturing

function loadGridShortcuts() {
  try {
    const stored = JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) || "{}");
    const merged = {};
    for (const action of Object.keys(SHORTCUT_DEFAULTS)) {
      const s = stored[action];
      merged[action] =
        s && typeof s.key === "string" && s.key
          ? { key: s.key, meta: !!s.meta, ctrl: !!s.ctrl, alt: !!s.alt, shift: !!s.shift }
          : { ...SHORTCUT_DEFAULTS[action] };
    }
    return merged;
  } catch (e) {
    return shortcutDefaultsCopy();
  }
}

function shortcutDefaultsCopy() {
  const copy = {};
  for (const action of Object.keys(SHORTCUT_DEFAULTS)) {
    copy[action] = { ...SHORTCUT_DEFAULTS[action] };
  }
  return copy;
}

function saveGridShortcuts() {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(gridShortcuts));
  } catch (e) { /* storage unavailable — nonfatal */ }
}

function shortcutLabel(sc) {
  const specials = {
    " ": "Space", enter: "↩", escape: "Esc", backspace: "⌫", delete: "⌦",
    tab: "⇥", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  };
  const k = sc.key.toLowerCase();
  const keyName = specials[k] || sc.key.toUpperCase();
  return (
    (sc.ctrl ? "⌃" : "") + (sc.alt ? "⌥" : "") +
    (sc.shift ? "⇧" : "") + (sc.meta ? "⌘" : "") + keyName
  );
}

function refreshShortcutLabels() {
  for (const action of Object.keys(gridShortcuts)) {
    const label = shortcutLabel(gridShortcuts[action]);
    const hint = document.getElementById(`key-hint-${action}`);
    if (hint) hint.textContent = label;
    const recorder = document.getElementById(`recorder-${action}`);
    if (recorder && recordingAction !== action) recorder.textContent = label;
  }
  // Surface the live shortcut in each button's tooltip
  const tips = {
    new: ["add-playlist-btn", "Add a playlist tile"],
    edit: ["edit-mode-btn", "Toggle edit mode"],
    cancel: ["cancel-mode-btn", "Leave the armed mode — Esc does this too"],
    spotify: ["spotify-mode-btn", "Toggle open-in-Spotify mode — clicking a playlist opens it in the Spotify app"],
  };
  for (const action of Object.keys(tips)) {
    const [id, desc] = tips[action];
    const btn = document.getElementById(id);
    if (btn) btn.title = `${desc} (${shortcutLabel(gridShortcuts[action])})`;
  }
  updateThemeToggleUI(); // theme button's tooltip carries its live shortcut
}

function matchesShortcut(e, sc) {
  return (
    e.key.toLowerCase() === sc.key.toLowerCase() &&
    e.metaKey === sc.meta && e.ctrlKey === sc.ctrl &&
    e.altKey === sc.alt && e.shiftKey === sc.shift
  );
}

function initGridShortcuts() {
  // The keydown dispatcher runs on EVERY page (the theme shortcut is global);
  // the customization modal only exists on the playlists page.
  document.addEventListener("keydown", handleShortcutKeydown, true);

  const overlay = document.getElementById("shortcuts-overlay");
  const openBtn = document.getElementById("shortcuts-btn");
  if (!overlay || !openBtn) {
    updateThemeToggleUI();
    return;
  }

  openBtn.addEventListener("click", openShortcutsModal);

  // Inside the native app the entry point lives in the Settings window
  // (Spotify Dashboard → Settings → Grid Shortcuts), so hide the toolbar
  // icon there; it stays for plain-browser use.
  if (window.__nativeApp) openBtn.style.display = "none";
  document.getElementById("shortcuts-close").addEventListener("click", closeShortcutsModal);
  document.getElementById("shortcuts-reset").addEventListener("click", () => {
    gridShortcuts = shortcutDefaultsCopy();
    stopRecording();
    saveGridShortcuts();
    refreshShortcutLabels();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeShortcutsModal();
  });

  for (const action of Object.keys(SHORTCUT_DEFAULTS)) {
    const recorder = document.getElementById(`recorder-${action}`);
    if (!recorder) continue;
    recorder.addEventListener("click", () => {
      if (recordingAction === action) return;
      stopRecording();
      recordingAction = action;
      recorder.classList.add("recording");
      recorder.textContent = "PRESS KEYS…";
    });
  }

  refreshShortcutLabels();
}

// Also called from the native Settings window ("Grid Shortcuts → Customize…")
function openShortcutsModal() {
  const overlay = document.getElementById("shortcuts-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  refreshShortcutLabels();
}

function closeShortcutsModal() {
  stopRecording();
  const overlay = document.getElementById("shortcuts-overlay");
  if (overlay) overlay.hidden = true;
}

function stopRecording() {
  if (!recordingAction) return;
  const recorder = document.getElementById(`recorder-${recordingAction}`);
  if (recorder) recorder.classList.remove("recording");
  recordingAction = null;
  refreshShortcutLabels();
}

function handleShortcutKeydown(e) {
  const shortcutsOverlay = document.getElementById("shortcuts-overlay");
  const editorOverlay = document.getElementById("playlist-editor-overlay");

  // A recorder is capturing: the next non-modifier key becomes the shortcut.
  if (recordingAction) {
    e.preventDefault();
    e.stopPropagation();
    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return; // wait for a real key
    if (e.key === "Escape") {
      stopRecording();
      return;
    }
    gridShortcuts[recordingAction] = {
      key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
    };
    saveGridShortcuts();
    stopRecording();
    return;
  }

  // Esc closes the shortcuts modal
  if (shortcutsOverlay && !shortcutsOverlay.hidden) {
    if (e.key === "Escape") closeShortcutsModal();
    return; // no shortcuts fire while the modal is open
  }

  // Don't fire while typing or while the editor modal is open
  if (editorOverlay && !editorOverlay.hidden) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

  // Theme works everywhere; NEW/EDIT/SPOTIFY only on the playlists grid page
  if (matchesShortcut(e, gridShortcuts.theme)) {
    e.preventDefault();
    toggleTheme();
    return;
  }

  const isGridPage = document.getElementById("add-playlist-btn") !== null;
  if (!isGridPage) return;

  // Esc is the always-on twin of the CANCEL button; the customizable CANCEL
  // shortcut only fires while there is a mode to leave.
  if (e.key === "Escape" && (editMode || spotifyMode)) {
    e.preventDefault();
    cancelArmedMode();
    return;
  }

  if (matchesShortcut(e, gridShortcuts.cancel) && (editMode || spotifyMode)) {
    e.preventDefault();
    cancelArmedMode();
  } else if (matchesShortcut(e, gridShortcuts.new)) {
    e.preventDefault();
    openEditor("add");
  } else if (matchesShortcut(e, gridShortcuts.edit)) {
    e.preventDefault();
    toggleEditMode();
  } else if (matchesShortcut(e, gridShortcuts.spotify)) {
    e.preventDefault();
    toggleSpotifyMode();
  }
}

async function loadSpotifyPlaylistsForPicker(refresh = false) {
  if (editorState.spotifyPlaylists && !refresh) return editorState.spotifyPlaylists;
  const res = await fetch(`/api/spotify-playlists${refresh ? "?refresh=1" : ""}`);
  if (!res.ok) throw new Error(`Failed to load Spotify playlists (${res.status})`);
  editorState.spotifyPlaylists = await res.json();
  return editorState.spotifyPlaylists;
}

function openEditor(mode, playlist = null) {
  editorState.mode = mode;
  editorState.original = playlist;
  editorState.selected = playlist
    ? { id: playlist.id, name: playlist.spotify_name }
    : null;

  const overlay = document.getElementById("playlist-editor-overlay");
  document.getElementById("editor-title").textContent =
    mode === "edit" ? "EDIT PLAYLIST" : "NEW PLAYLIST";
  document.getElementById("editor-display-name").value = playlist ? playlist.name : "";
  document.getElementById("editor-spotify-search").value = "";
  setEditorError(null);
  updateSelectedChip();

  overlay.hidden = false;
  document.getElementById("editor-display-name").focus();

  const list = document.getElementById("editor-spotify-list");
  list.innerHTML =
    '<div class="editor-list-note">Loading your Spotify playlists…</div>';
  loadSpotifyPlaylistsForPicker()
    .then(() => renderSpotifyPicker(""))
    .catch((e) => {
      list.innerHTML = "";
      setEditorError(e.message);
    });
}

function closeEditor() {
  document.getElementById("playlist-editor-overlay").hidden = true;
}

function renderSpotifyPicker(filterText) {
  const list = document.getElementById("editor-spotify-list");
  list.innerHTML = "";
  const all = editorState.spotifyPlaylists || [];
  const filter = (filterText || "").trim().toLowerCase();
  const matches = filter
    ? all.filter((p) => p.name.toLowerCase().includes(filter))
    : all;

  if (matches.length === 0) {
    list.innerHTML = '<div class="editor-list-note">No playlists match.</div>';
    return;
  }

  matches.forEach((p) => {
    const row = document.createElement("div");
    row.className = "editor-spotify-row";
    if (editorState.selected && editorState.selected.id === p.id) {
      row.classList.add("selected");
    }
    row.textContent = p.name;
    row.onclick = () => {
      editorState.selected = { id: p.id, name: p.name };
      setEditorError(null);
      updateSelectedChip();
      renderSpotifyPicker(filterText);
    };
    list.appendChild(row);
  });
}

function updateSelectedChip() {
  const chip = document.getElementById("editor-selected");
  if (editorState.selected) {
    chip.textContent = `→ ${editorState.selected.name}`;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

function setEditorError(msg) {
  const el = document.getElementById("editor-error");
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function saveEditor() {
  const displayName = document.getElementById("editor-display-name").value.trim();
  if (!displayName) return setEditorError("Enter a display name.");
  if (!editorState.selected)
    return setEditorError("Pick the Spotify playlist this tile should update.");

  const isEdit = editorState.mode === "edit";
  const body = {
    display_name: displayName,
    spotify_name: editorState.selected.name,
    spotify_id: editorState.selected.id,
  };
  if (isEdit) body.original_display_name = editorState.original.name;

  const saveBtn = document.getElementById("editor-save");
  saveBtn.disabled = true;
  try {
    const pageId = document.body.dataset.pageId || "playlists";
    const res = await fetch(`/api/page/${pageId}/playlists`, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return setEditorError(data.error || `Save failed (${res.status})`);
    }
    closeEditor();
    await refreshAfterEdit();
  } catch (e) {
    console.error("Error saving playlist item:", e);
    setEditorError("Network error — try again.");
  } finally {
    saveBtn.disabled = false;
  }
}

async function deletePlaylistItem(playlist) {
  const ok = confirm(
    `Remove "${playlist.name}" from this page?\n(The Spotify playlist itself is not touched.)`,
  );
  if (!ok) return;

  try {
    const pageId = document.body.dataset.pageId || "playlists";
    const res = await fetch(`/api/page/${pageId}/playlists`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: playlist.name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      alert("Failed to remove: " + (data.error || res.status));
      return;
    }
    await refreshAfterEdit();
  } catch (e) {
    console.error("Error removing playlist item:", e);
    alert("Network error removing playlist item.");
  }
}

async function refreshAfterEdit() {
  await fetchPlaylists();
  if (currentTrack) {
    try {
      await checkPlaylists(currentTrack.uri);
    } catch (e) {
      console.error("Error re-checking playlists after edit:", e);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const pageId = document.body.dataset.pageId || "playlists";
  const isGridPage =
    pageId === "playlists" &&
    !document.body.classList.contains("tracker-page") &&
    !document.body.classList.contains("queue-page");
  if (isGridPage) initPlaylistEditor();
});


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
