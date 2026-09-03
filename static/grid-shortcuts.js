// Shared grid-shortcut model — loaded by every dashboard page AND the Settings
// page, so the defaults, storage key, label format and matching live in exactly
// one place. Settings writes; the pages read (and reload on change).
(function () {
  const STORAGE_KEY = "gridShortcuts.v1";
  const DEFAULTS = {
    new: { key: "n", meta: false, ctrl: false, alt: false, shift: false },
    edit: { key: "e", meta: false, ctrl: false, alt: false, shift: false },
    cancel: { key: "c", meta: false, ctrl: false, alt: false, shift: false },
    spotify: { key: "s", meta: false, ctrl: false, alt: false, shift: false },
    find: { key: "f", meta: false, ctrl: false, alt: false, shift: false },
    theme: { key: "l", meta: true, ctrl: false, alt: false, shift: true },
  };
  // What each action does — the Settings page renders these; the dashboard
  // uses them for tooltips.
  const META = {
    new: { name: "NEW", desc: "Open the new-playlist editor" },
    edit: { name: "EDIT", desc: "Toggle edit mode on the grid" },
    cancel: { name: "CANCEL", desc: "Leave the armed mode (Esc always works too)" },
    spotify: { name: "SPOTIFY", desc: "Toggle open-in-Spotify mode" },
    find: { name: "FIND", desc: "Focus the playlist filter box (/ and ⌘F always work too)" },
    theme: { name: "THEME", desc: "Switch between Phosphor (dark) and Daybreak (light) — all pages" },
  };

  function defaultsCopy() {
    const copy = {};
    for (const action of Object.keys(DEFAULTS)) copy[action] = { ...DEFAULTS[action] };
    return copy;
  }

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const merged = {};
      for (const action of Object.keys(DEFAULTS)) {
        const s = stored[action];
        merged[action] =
          s && typeof s.key === "string" && s.key
            ? { key: s.key, meta: !!s.meta, ctrl: !!s.ctrl, alt: !!s.alt, shift: !!s.shift }
            : { ...DEFAULTS[action] };
      }
      return merged;
    } catch (e) {
      return defaultsCopy();
    }
  }

  function save(shortcuts) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
    } catch (e) { /* storage unavailable — nonfatal */ }
  }

  function label(sc) {
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

  function matches(e, sc) {
    return (
      e.key.toLowerCase() === sc.key.toLowerCase() &&
      e.metaKey === sc.meta && e.ctrlKey === sc.ctrl &&
      e.altKey === sc.alt && e.shiftKey === sc.shift
    );
  }

  window.GridShortcuts = { STORAGE_KEY, DEFAULTS, META, defaultsCopy, load, save, label, matches };
})();
