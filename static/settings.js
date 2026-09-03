// ============================================
// Settings page — the single preferences surface.
//
// Runs in two hosts:
//   • the native Settings window (window.webkit.messageHandlers.settings
//     exists) — app-level preferences round-trip through the bridge below;
//   • a plain browser tab at /settings — grid shortcuts and the theme are
//     shared through localStorage (same origin as the dashboard), app-level
//     rows show as unavailable.
//
// Bridge, page → native:  {type:'ready'} · {type:'set',key,value}
//   {type:'hotkey',page,keyCode,modifiers|clear} · {type:'sidebarShortcut',…|clear}
//   {type:'sectionShortcut',section,…|clear} · {type:'gridShortcutsChanged'}
//   {type:'theme',theme} · {type:'recording',active} · {type:'close'}
// Native → page:  SettingsPage.setState(json) · SettingsPage.update(partial)
//   · SettingsPage.showSection(id)
// ============================================
(function () {
  "use strict";

  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.settings;
  const native = !!bridge;
  const THEME_KEY = "dashTheme";
  const SECTION_KEY = "settingsSection";

  // Carbon modifier masks — the native hotkey layer's vocabulary
  const CMD = 256, SHIFT = 512, OPT = 2048, CTRL = 4096;

  // KeyboardEvent.code → Carbon virtual keycode (ANSI layout)
  const CODE_TO_KEYCODE = {
    KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
    KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
    Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24,
    Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30,
    KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
    Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45,
    KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
    F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumpadDivide: 75,
    NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80, NumpadEqual: 81,
    Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87,
    Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
    F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105, F16: 106,
    F14: 107, F10: 109, F12: 111, F15: 113, Insert: 114, Home: 115, PageUp: 116,
    Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
    ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  };
  const CODE_LABEL = {
    Enter: "↩", Tab: "⇥", Space: "Space", Backspace: "⌫", Escape: "Esc", Delete: "⌦",
    Insert: "Ins", Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
    ArrowLeft: "←", ArrowRight: "→", ArrowDown: "↓", ArrowUp: "↑",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    NumpadDecimal: "Num .", NumpadMultiply: "Num *", NumpadAdd: "Num +", NumpadDivide: "Num /",
    NumpadEnter: "Num ↩", NumpadSubtract: "Num -", NumpadEqual: "Num =",
  };
  const KEYCODE_NAME = {};
  for (const [code, kc] of Object.entries(CODE_TO_KEYCODE)) {
    let name = CODE_LABEL[code];
    if (!name) {
      if (code.startsWith("Key")) name = code.slice(3);
      else if (code.startsWith("Digit")) name = code.slice(5);
      else if (code.startsWith("Numpad")) name = "Num " + code.slice(6);
      else name = code; // F-keys
    }
    KEYCODE_NAME[kc] = name;
  }

  function carbonLabel(combo) {
    if (!combo) return "";
    const m = combo.modifiers || 0;
    return (
      (m & CTRL ? "⌃" : "") + (m & OPT ? "⌥" : "") + (m & SHIFT ? "⇧" : "") + (m & CMD ? "⌘" : "") +
      (KEYCODE_NAME[combo.keyCode] || `Key${combo.keyCode}`)
    );
  }
  function carbonMods(e) {
    return (e.ctrlKey ? CTRL : 0) | (e.altKey ? OPT : 0) | (e.shiftKey ? SHIFT : 0) | (e.metaKey ? CMD : 0);
  }
  function sameCombo(a, b) {
    return !!a && !!b && a.keyCode === b.keyCode && (a.modifiers || 0) === (b.modifiers || 0);
  }
  function post(msg) {
    if (native) {
      try { bridge.postMessage(msg); } catch (e) { console.error("bridge", e); }
    }
  }

  // ── State ──────────────────────────────────────────────
  const SECTION_DEFAULTS = {
    general: { keyCode: 5, modifiers: CTRL },     // ⌃G
    appearance: { keyCode: 0, modifiers: CTRL },  // ⌃A
    shortcuts: { keyCode: 1, modifiers: CTRL },   // ⌃S
  };
  const SIDEBAR_DEFAULT = { keyCode: 1, modifiers: CMD }; // ⌘S

  let storedTheme = "dark";
  try { if (localStorage.getItem(THEME_KEY) === "light") storedTheme = "light"; } catch (e) { /* */ }

  const state = {
    menuBarMode: false,
    floatOnTop: true,
    hotkeys: { playlist: null, tracker: null, queue: null },
    sidebar: { ...SIDEBAR_DEFAULT },
    sections: {
      general: { ...SECTION_DEFAULTS.general },
      appearance: { ...SECTION_DEFAULTS.appearance },
      shortcuts: { ...SECTION_DEFAULTS.shortcuts },
    },
    theme: storedTheme,
    grid: GridShortcuts.load(),
  };

  const THEMES = [
    { id: "dark", name: "Phosphor", kind: "DARK", bg: "#0a0a0a", heading: "#84ff00", text: "#ffffff", muted: "#a0a0a0", accent: "#00f3ff", border: "rgba(255,255,255,0.12)" },
    { id: "light", name: "Daybreak", kind: "LIGHT", bg: "#eef0e8", heading: "#3d7a00", text: "#1d2418", muted: "#49523f", accent: "#006d7a", border: "rgba(20,28,10,0.16)" },
  ];

  const ICONS = {
    general: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    shortcuts: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  };
  function svg(paths, cls) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("viewBox", "0 0 24 24");
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "currentColor");
    el.setAttribute("stroke-width", "2");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("aria-hidden", "true");
    if (cls) el.setAttribute("class", cls);
    el.innerHTML = paths;
    return el;
  }

  const SECTIONS = [
    { id: "general", name: "General", desc: "How the dashboard lives on your Mac." },
    { id: "appearance", name: "Appearance", desc: "Phosphor by night, Daybreak by day. Themes are built into the dashboard stylesheet." },
    { id: "shortcuts", name: "Shortcuts", desc: "Every key is yours. Click a key, press the new combo — Esc cancels, ↺ restores the default." },
  ];

  // ── DOM helpers ────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return node;
  }
  const refreshers = [];
  function onRefresh(fn) { refreshers.push(fn); fn(); }
  function refresh() { for (const fn of refreshers) fn(); }

  // ── Recording ─────────────────────────────────────────
  let recording = null;
  function startRecording(btn, opts) {
    stopRecording();
    recording = { btn, ...opts };
    btn.classList.add("recording");
    btn.classList.remove("empty");
    btn.textContent = "PRESS KEYS…";
    post({ type: "recording", active: true });
  }
  function stopRecording() {
    if (!recording) return;
    recording.btn.classList.remove("recording");
    recording = null;
    post({ type: "recording", active: false });
    refresh();
  }
  function flash(btn, text) {
    btn.textContent = text;
    btn.classList.add("flash");
    setTimeout(() => {
      if (recording && recording.btn === btn) {
        btn.classList.remove("flash");
        btn.textContent = "PRESS KEYS…";
      }
    }, 900);
  }

  document.addEventListener("keydown", (e) => {
    if (recording) {
      e.preventDefault();
      e.stopPropagation();
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
      if (e.key === "Escape") { stopRecording(); return; }
      if (recording.kind === "carbon") {
        const keyCode = CODE_TO_KEYCODE[e.code];
        const modifiers = carbonMods(e);
        if (keyCode === undefined) return flash(recording.btn, "UNSUPPORTED KEY");
        if (recording.requireModifier && modifiers === 0) return flash(recording.btn, "ADD ⌘ ⌥ ⌃ OR ⇧");
        if (modifiers === CMD && (e.code === "Backquote" || e.code === "Comma")) return flash(recording.btn, "RESERVED");
        recording.commit({ keyCode, modifiers });
      } else {
        recording.commit({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      }
      stopRecording();
      return;
    }
    if (e.key === "Escape") {
      const search = document.getElementById("settings-search");
      if (document.activeElement === search && search.value) {
        search.value = "";
        applySearch("");
        return;
      }
      closeSettings();
      return;
    }
    // In a browser tab the page owns its own section shortcuts; inside the
    // app the native key monitor routes them (and knows to pause while a
    // recorder is capturing).
    if (!native && !e.repeat) {
      const kc = CODE_TO_KEYCODE[e.code];
      const mods = carbonMods(e);
      for (const id of Object.keys(state.sections)) {
        if (sameCombo(state.sections[id], { keyCode: kc, modifiers: mods })) {
          e.preventDefault();
          showSection(id);
          return;
        }
      }
    }
  }, true);

  function closeSettings() {
    if (native) post({ type: "close" });
    else window.close();
  }

  // ── Row builders ──────────────────────────────────────
  function row(name, desc, controls, opts = {}) {
    const info = el("div", { class: "row-info" },
      el("div", { class: "row-name", text: name }),
      el("div", { class: "row-desc", text: desc }));
    const r = el("div", { class: "row" }, info, el("div", { class: "row-controls" }, ...controls));
    r.dataset.search = `${name} ${desc} ${opts.keywords || ""}`.toLowerCase();
    if (opts.nativeOnly && !native) {
      r.classList.add("disabled");
      r.querySelector(".row-controls").prepend(el("span", { class: "row-note", text: "Mac app only" }));
    }
    return r;
  }

  function toggleRow(name, desc, key, keywords) {
    const sw = el("button", { class: "switch", type: "button", role: "switch", "aria-label": name,
      onclick: () => {
        state[key] = !state[key];
        post({ type: "set", key, value: state[key] });
        refresh();
      } });
    onRefresh(() => sw.setAttribute("aria-checked", String(!!state[key])));
    return row(name, desc, [sw], { nativeOnly: true, keywords });
  }

  // kind: 'carbon' (native keycode+modifiers) | 'grid' ({key, meta, …})
  function recorderRow(name, desc, spec) {
    const btn = el("button", { class: "recorder", type: "button", title: "Click, then press the new shortcut. Esc cancels." });
    btn.addEventListener("click", () => {
      if (recording && recording.btn === btn) return stopRecording();
      startRecording(btn, { kind: spec.kind, requireModifier: !!spec.requireModifier, commit: spec.commit });
    });
    const reset = el("button", { class: "row-reset", type: "button", text: spec.clearGlyph || "↺",
      title: spec.resetTitle || "Reset to default", "aria-label": spec.resetTitle || "Reset to default",
      onclick: () => { spec.reset(); refresh(); } });
    onRefresh(() => {
      if (recording && recording.btn === btn) return;
      const label = spec.label();
      btn.classList.toggle("empty", !label);
      btn.textContent = label || "Click to record";
      reset.disabled = !!spec.isDefault && spec.isDefault();
    });
    return row(name, desc, [btn, reset], { nativeOnly: !!spec.nativeOnly, keywords: spec.keywords });
  }

  function card(title, opts = {}) {
    const head = el("div", { class: "card-head" }, el("div", { class: "card-title", text: title }));
    if (opts.action) {
      head.appendChild(el("button", { class: "card-action", type: "button", text: opts.action.label, onclick: opts.action.run }));
    }
    const c = el("div", { class: "card" }, head);
    if (opts.caption) c.appendChild(el("div", { class: "card-caption", text: opts.caption }));
    if (opts.span2) c.classList.add("span-2");
    c.dataset.search = `${title} ${opts.caption || ""}`.toLowerCase();
    return c;
  }

  // ── Sections ──────────────────────────────────────────
  function buildGeneral() {
    const app = card("APP", { caption: native ? "" : "These rows control the Mac app and apply only inside it." });
    app.appendChild(toggleRow("Run as Menu Bar Utility", "Hide the Dock icon and live in the menu bar instead.", "menuBarMode", "dock status bar accessory"));
    app.appendChild(toggleRow("Float on Top", "Keep the dashboard window above every other window.", "floatOnTop", "window level always"));
    return [app];
  }

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    document.body.classList.toggle("theme-light", state.theme === "light");
    try { localStorage.setItem(THEME_KEY, state.theme); } catch (e) { /* */ }
    post({ type: "theme", theme: state.theme });
    refresh();
  }

  function buildAppearance() {
    const mode = card("MODE");
    const seg = el("div", { class: "segmented", role: "radiogroup", "aria-label": "Appearance" });
    const darkBtn = el("button", { type: "button", onclick: () => setTheme("dark") }, svg(ICONS.moon), "DARK");
    const lightBtn = el("button", { type: "button", onclick: () => setTheme("light") }, svg(ICONS.sun), "LIGHT");
    seg.append(darkBtn, lightBtn);
    onRefresh(() => {
      darkBtn.classList.toggle("active", state.theme === "dark");
      lightBtn.classList.toggle("active", state.theme === "light");
    });
    const modeRow = row("Appearance", "", [seg], { keywords: "dark light theme mode toggle" });
    onRefresh(() => {
      modeRow.querySelector(".row-desc").textContent =
        `${GridShortcuts.label(state.grid.theme)} toggles between the two from any page.`;
    });
    mode.appendChild(modeRow);

    const grids = THEMES.map((t) => {
      const c = card(`${t.kind} THEME`);
      c.dataset.search += ` ${t.name} ${t.kind} theme`.toLowerCase();
      const grid = el("div", { class: "swatch-grid" });
      const preview = el("div", { class: "swatch-preview" },
        el("span", { class: "swatch-aa", text: "Aa" }),
        el("i", { class: "swatch-rule" }), el("i", { class: "swatch-rule" }), el("i", { class: "swatch-rule" }));
      preview.style.background = t.bg;
      preview.style.borderColor = t.border;
      preview.querySelector(".swatch-aa").style.color = t.heading;
      const rules = preview.querySelectorAll(".swatch-rule");
      rules[0].style.background = t.text; rules[0].style.width = "72%";
      rules[1].style.background = t.muted; rules[1].style.width = "52%";
      rules[2].style.background = t.accent; rules[2].style.width = "34%";
      const sw = el("button", { class: "swatch", type: "button", "aria-label": `${t.name} (${t.kind.toLowerCase()} theme)`, onclick: () => setTheme(t.id) },
        preview,
        el("div", { class: "swatch-meta" }, el("span", { class: "swatch-name", text: t.name }), el("span", { class: "swatch-kind", text: t.kind })));
      onRefresh(() => sw.classList.toggle("active", state.theme === t.id));
      grid.appendChild(sw);
      c.appendChild(grid);
      return c;
    });
    return [mode, ...grids];
  }

  function buildShortcuts() {
    // Global hotkeys — system-wide, registered natively
    const hot = card("GLOBAL HOTKEYS", { caption: "Work from any app: each combo shows the dashboard on that page, or hides it when that page is already up." });
    const PAGES = [["playlist", "Playlists"], ["tracker", "Tracker"], ["queue", "Queue"]];
    for (const [id, name] of PAGES) {
      hot.appendChild(recorderRow(name, `Toggle the ${name} page from anywhere on the Mac.`, {
        kind: "carbon", requireModifier: true, nativeOnly: true, keywords: "global hotkey system-wide page",
        label: () => carbonLabel(state.hotkeys[id]),
        isDefault: () => !state.hotkeys[id],
        clearGlyph: "✕", resetTitle: "Remove this hotkey",
        commit: (combo) => { state.hotkeys[id] = combo; post({ type: "hotkey", page: id, ...combo }); },
        reset: () => { state.hotkeys[id] = null; post({ type: "hotkey", page: id, clear: true }); },
      }));
    }

    // Window shortcuts — the native layer swallows these before the page
    const win = card("WINDOW", { caption: "Active while the dashboard window has focus." });
    win.appendChild(recorderRow("Toggle Sidebar", "Show or hide the artist release sidebar (Playlists and Tracker).", {
      kind: "carbon", requireModifier: true, nativeOnly: true, keywords: "artist release panel",
      label: () => carbonLabel(state.sidebar),
      isDefault: () => sameCombo(state.sidebar, SIDEBAR_DEFAULT),
      commit: (combo) => { state.sidebar = combo; post({ type: "sidebarShortcut", ...combo, display: carbonLabel(combo) }); },
      reset: () => { state.sidebar = { ...SIDEBAR_DEFAULT }; post({ type: "sidebarShortcut", clear: true }); },
    }));

    // Playlists grid — shared with the dashboard through localStorage
    const grid = card("PLAYLISTS GRID", {
      caption: "Single keys work while nothing is focused; the keycaps on the page show the live combos.",
      action: { label: "RESET DEFAULTS", run: () => { state.grid = GridShortcuts.defaultsCopy(); commitGrid(); } },
    });
    function commitGrid() {
      GridShortcuts.save(state.grid);
      post({ type: "gridShortcutsChanged" });
      refresh();
    }
    for (const action of Object.keys(GridShortcuts.DEFAULTS)) {
      const meta = GridShortcuts.META[action];
      grid.appendChild(recorderRow(meta.name, meta.desc, {
        kind: "grid", keywords: "playlists grid key",
        label: () => GridShortcuts.label(state.grid[action]),
        isDefault: () => GridShortcuts.label(state.grid[action]) === GridShortcuts.label(GridShortcuts.DEFAULTS[action]),
        commit: (combo) => { state.grid[action] = combo; commitGrid(); },
        reset: () => { state.grid[action] = { ...GridShortcuts.DEFAULTS[action] }; commitGrid(); },
      }));
    }

    // Settings sections — ⌃ + first letter, rebindable; ⌘` / ⌘, stay fixed
    const sec = card("SETTINGS", { caption: "Jump straight to a section from anywhere in the app — while Settings is open they switch sections. ⌘` toggles this window and ⌘, opens it; those two stay fixed." });
    for (const s of SECTIONS) {
      sec.appendChild(recorderRow(`Settings › ${s.name}`, `Open Settings to ${s.name}.`, {
        kind: "carbon", requireModifier: true, nativeOnly: true, keywords: "section jump",
        label: () => carbonLabel(state.sections[s.id]),
        isDefault: () => sameCombo(state.sections[s.id], SECTION_DEFAULTS[s.id]),
        commit: (combo) => { state.sections[s.id] = combo; post({ type: "sectionShortcut", section: s.id, ...combo, display: carbonLabel(combo) }); },
        reset: () => { state.sections[s.id] = { ...SECTION_DEFAULTS[s.id] }; post({ type: "sectionShortcut", section: s.id, clear: true }); },
      }));
    }
    return [hot, win, grid, sec];
  }

  // ── Assembly ──────────────────────────────────────────
  const railNav = document.getElementById("rail-nav");
  const paneBody = document.getElementById("pane-body");
  const paneTitle = document.getElementById("pane-title");
  const paneDesc = document.getElementById("pane-desc");
  const sectionEls = {};
  const railItems = {};
  let currentSection = "general";
  try { if (SECTIONS.some((s) => s.id === localStorage.getItem(SECTION_KEY))) currentSection = localStorage.getItem(SECTION_KEY); } catch (e) { /* */ }

  const BUILDERS = { general: buildGeneral, appearance: buildAppearance, shortcuts: buildShortcuts };
  for (const s of SECTIONS) {
    const item = el("button", { class: "rail-item", type: "button", onclick: () => { clearSearch(); showSection(s.id); } },
      svg(ICONS[s.id]), el("span", { class: "rail-name", text: s.name }), el("kbd", { class: "rail-badge" }));
    onRefresh(() => { item.querySelector(".rail-badge").textContent = carbonLabel(state.sections[s.id]); });
    railNav.appendChild(item);
    railItems[s.id] = item;

    const section = el("section", { class: "section", "data-section": s.id },
      el("div", { class: "section-label", text: s.name.toUpperCase() }),
      el("div", { class: "card-grid" }, ...BUILDERS[s.id]()));
    section.hidden = true;
    paneBody.appendChild(section);
    sectionEls[s.id] = section;
  }
  const searchEmpty = el("div", { class: "search-empty" });
  searchEmpty.hidden = true;
  paneBody.appendChild(searchEmpty);

  document.getElementById("rail-foot").textContent = native
    ? "⌘` toggles · ⌘, opens · Esc closes"
    : "Browser tab — changes reach the dashboard live";

  function showSection(id) {
    if (!sectionEls[id]) return;
    currentSection = id;
    try { localStorage.setItem(SECTION_KEY, id); } catch (e) { /* */ }
    for (const s of SECTIONS) {
      sectionEls[s.id].hidden = s.id !== id;
      railItems[s.id].classList.toggle("active", s.id === id);
      railItems[s.id].classList.remove("dim");
    }
    const meta = SECTIONS.find((s) => s.id === id);
    paneTitle.textContent = meta.name.toUpperCase();
    paneDesc.textContent = meta.desc;
    // A shared scrolling body carries the previous section's offset — open at the top
    paneBody.scrollTop = 0;
    requestAnimationFrame(() => { paneBody.scrollTop = 0; });
  }

  // ── Search ────────────────────────────────────────────
  const searchInput = document.getElementById("settings-search");
  function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function applySearch(q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const searching = terms.length > 0;
    paneBody.classList.toggle("searching", searching);
    if (!searching) {
      for (const s of SECTIONS) {
        sectionEls[s.id].querySelectorAll(".card, .row").forEach((n) => { n.hidden = false; });
      }
      searchEmpty.hidden = true;
      showSection(currentSection);
      return;
    }
    let total = 0;
    for (const s of SECTIONS) {
      const sec = sectionEls[s.id];
      let secHits = 0;
      sec.querySelectorAll(".card").forEach((c) => {
        const cardMatch = terms.every((t) => norm(c.dataset.search).includes(t) || norm(s.name).includes(t));
        let rowHits = 0;
        const rows = c.querySelectorAll(".row");
        rows.forEach((r) => {
          const hit = cardMatch || terms.every((t) => norm(r.dataset.search).includes(t));
          r.hidden = !hit;
          if (hit) rowHits++;
        });
        const show = rowHits > 0 || (rows.length === 0 && cardMatch);
        c.hidden = !show;
        if (show) secHits += Math.max(rowHits, 1);
      });
      sec.hidden = secHits === 0;
      railItems[s.id].classList.toggle("dim", secHits === 0);
      railItems[s.id].classList.remove("active");
      total += secHits;
    }
    paneTitle.textContent = "SEARCH";
    paneDesc.textContent = total ? `${total} ${total === 1 ? "match" : "matches"} for “${q.trim()}”` : `Nothing matches “${q.trim()}”`;
    searchEmpty.hidden = total > 0;
    searchEmpty.textContent = "NO SETTINGS MATCH";
    paneBody.scrollTop = 0;
  }
  function clearSearch() {
    if (!searchInput.value) return;
    searchInput.value = "";
    applySearch("");
  }
  searchInput.addEventListener("input", () => applySearch(searchInput.value));
  document.getElementById("pane-close").addEventListener("click", closeSettings);

  // Another same-origin document (the dashboard tab) changed shared state
  window.addEventListener("storage", (e) => {
    if (e.key === GridShortcuts.STORAGE_KEY) { state.grid = GridShortcuts.load(); refresh(); }
    if (e.key === THEME_KEY && e.newValue && e.newValue !== state.theme) {
      state.theme = e.newValue === "light" ? "light" : "dark";
      document.body.classList.toggle("theme-light", state.theme === "light");
      refresh();
    }
  });

  // ── Native API ────────────────────────────────────────
  function applyState(partial) {
    if (!partial) return;
    if ("menuBarMode" in partial) state.menuBarMode = !!partial.menuBarMode;
    if ("floatOnTop" in partial) state.floatOnTop = !!partial.floatOnTop;
    if (partial.hotkeys) for (const k of Object.keys(state.hotkeys)) state.hotkeys[k] = partial.hotkeys[k] || null;
    if (partial.sidebar) state.sidebar = partial.sidebar;
    if (partial.sections) for (const k of Object.keys(state.sections)) if (partial.sections[k]) state.sections[k] = partial.sections[k];
    if (partial.theme && partial.theme !== state.theme) {
      state.theme = partial.theme === "light" ? "light" : "dark";
      document.body.classList.toggle("theme-light", state.theme === "light");
      try { localStorage.setItem(THEME_KEY, state.theme); } catch (e) { /* */ }
    }
    if (partial.gridChanged) state.grid = GridShortcuts.load();
    refresh();
  }
  window.SettingsPage = {
    setState: applyState,
    update: applyState,
    showSection: (id) => { clearSearch(); showSection(id); },
    isRecording: () => !!recording,
  };

  document.body.classList.toggle("theme-light", state.theme === "light");
  showSection(currentSection);
  refresh();
  post({ type: "ready" });
})();
