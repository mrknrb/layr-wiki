// The frame: toolbar with tabs, the two sidebars (resizable, hideable, drawers on the phone), the centre showing the
// active tab's view, focus mode, keys, link clicks and the Look settings. app.js holds the state; this draws it.
import { add, el, icon, narrow, put } from "./dom.js";
import { keyFromEvent, keyLabel, routeKey } from "./pure.js";
import { markFor, isBookmarked, toggleBookmark } from "./data.js";

const LAYOUT_KEY = "wiki.layout";
const MIN_SIDE = 180;
const MAX_SIDE = 640;

const FONTS = {
  sans: "var(--font)",
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", serif',
  mono: "var(--font-mono)",
  system: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif",
};
const LINE_WIDTHS = { narrow: "620px", normal: "760px", wide: "960px", full: "100%" };

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function startShell(app, root) {
  const saved = readLayout();
  const layout = {
    left: { open: saved.left?.open ?? true, width: saved.left?.width ?? 260, panel: saved.left?.panel ?? "files" },
    right: { open: saved.right?.open ?? window.innerWidth >= 1100, width: saved.right?.width ?? 280,
      panel: saved.right?.panel ?? null },
    focus: false,
  };
  const saveLayout = () => localStorage.setItem(LAYOUT_KEY, JSON.stringify({
    left: { open: layout.left.open, width: layout.left.width, panel: layout.left.panel },
    right: { open: layout.right.open, width: layout.right.width, panel: layout.right.panel },
  }));
  // On the phone the sidebars are drawers: closed until asked for, and not remembered.
  const drawer = { left: false, right: false };
  const isPhone = () => narrow();

  // ---------- the DOM ----------

  const btn = (id, name, title, onclick, extra = {}) => el("button", { id, class: "layr-button ghost icon wiki-tb",
    title, "aria-label": title, onclick, ...extra }, icon(name));
  const tabsEl = el("div", { class: "wiki-tabs", id: "tabs", role: "tablist" });
  const newTabBtn = btn("btnNewTab", "plus", "New tab (Ctrl+T)", () => app.open({ view: "home" }, { newTab: true }));
  const tabSwitch = el("button", { id: "btnTabs", class: "wiki-tabswitch", title: "Tabs", "aria-label": "Tabs",
    onclick: () => openTabSwitcher() });
  const bar = el("header", { class: "wiki-bar", id: "bar" },
    btn("btnLeft", "panel-left", "Show or hide the left sidebar", () => toggleSide("left")),
    btn("btnBack", "arrow-left", "Back (Alt+←)", () => app.back()),
    btn("btnForward", "arrow-right", "Forward (Alt+→)", () => app.forward()),
    tabsEl,
    tabSwitch,
    btn("btnMore", "ellipsis", "More", (e) => moreMenu(e)),
    btn("btnRight", "panel-right", "Show or hide the right sidebar", () => toggleSide("right")));
  const side = (which) => {
    const aside = el("aside", { class: `wiki-side ${which}`, id: which === "left" ? "leftSide" : "rightSide",
      "aria-label": which === "left" ? "Left sidebar" : "Right sidebar" });
    const strip = el("nav", { class: "wiki-side-strip", role: "tablist" });
    const body = el("div", { class: "wiki-side-body" });
    const foot = which === "left" ? el("div", { class: "wiki-side-foot" }) : null;
    add(aside, strip, body);
    if (foot) add(aside, foot);
    return { aside, strip, body, foot, cleanup: null, current: null };
  };
  const sides = { left: side("left"), right: side("right") };
  const splitter = (which) => el("div", { class: `wiki-split ${which}`, role: "separator",
    "aria-orientation": "vertical",
    title: "Drag to resize; double-click to hide" });
  const splits = { left: splitter("left"), right: splitter("right") };
  const viewHost = el("main", { class: "wiki-view", id: "view", tabindex: "-1" });
  const center = el("div", { class: "wiki-center" }, viewHost);
  const scrim = el("div", { class: "wiki-scrim", onclick: () => closeDrawers() });
  const fab = el("button", { class: "wiki-fab", id: "fab", title: "New note (hold: today's note)",
    "aria-label": "New note" }, icon("plus"));
  const focusExit = el("button", { class: "layr-button ghost icon wiki-focus-exit",
    title: "Leave focus mode (Ctrl+Shift+F)",
    "aria-label": "Leave focus mode", onclick: () => setFocus(false) }, icon("minimize-2"));
  const frame = el("div", { class: "wiki-body" }, sides.left.aside, splits.left, center, splits.right,
    sides.right.aside);
  put(root, bar, frame, scrim, fab, focusExit);
  root.classList.add("wiki-ready");

  // ---------- sidebars ----------

  function applySides() {
    const phone = isPhone();
    root.classList.toggle("phone", phone);
    for (const which of ["left", "right"]) {
      const s = layout[which];
      const has = app.sidebar.list(which).length > 0;
      const open = has && (phone ? drawer[which] : s.open && !layout.focus);
      root.classList.toggle(`${which}-open`, open);
      root.classList.toggle(`${which}-none`, !has);
      sides[which].aside.style.width = phone ? "" : `${s.width}px`;
      sides[which].aside.hidden = !open;
      splits[which].hidden = phone || !open;
    }
    scrim.hidden = !(phone && (drawer.left || drawer.right));
    $id("btnLeft")?.setAttribute("aria-pressed", String(root.classList.contains("left-open")));
    $id("btnRight")?.setAttribute("aria-pressed", String(root.classList.contains("right-open")));
    $id("btnRight").hidden = !app.sidebar.list("right").length;
  }

  function toggleSide(which, open = null) {
    if (isPhone()) {
      const next = open ?? !drawer[which];
      drawer.left = false;
      drawer.right = false;
      drawer[which] = next;
    } else {
      if (layout.focus) setFocus(false);
      layout[which].open = open ?? !layout[which].open;
      saveLayout();
    }
    applySides();
    drawSide(which);
  }
  const closeDrawers = () => {
    if (!drawer.left && !drawer.right) return;
    drawer.left = false;
    drawer.right = false;
    applySides();
  };

  function drawStrip(which) {
    const s = sides[which];
    const panels = app.sidebar.list(which);
    put(s.strip, ...panels.map((p) => el("button", {
      class: `wiki-side-tab${p.id === layout[which].panel ? " active" : ""}`, role: "tab", title: p.title,
      "aria-label": p.title, "aria-selected": String(p.id === layout[which].panel), "data-panel": p.id,
      onclick: () => showPanel(which, p.id),
    }, icon(p.icon ?? "circle"))), el("span", { class: "wiki-side-strip-fill" }),
    isPhone() ? el("button", { class: "layr-button ghost icon small", title: "Close", "aria-label": "Close",
      onclick: closeDrawers }, icon("x")) : null);
  }

  /** Draw the sidebar's active panel (from scratch, or with its `update` when `why` says what changed). */
  function drawSide(which, why = null) {
    const s = sides[which];
    const panels = app.sidebar.list(which);
    if (!panels.length) {
      s.cleanup?.();
      s.cleanup = null;
      s.current = null;
      put(s.body);
      return;
    }
    if (!panels.some((p) => p.id === layout[which].panel)) layout[which].panel = panels[0].id;
    drawStrip(which);
    if (s.aside.hidden) return;
    const spec = panels.find((p) => p.id === layout[which].panel);
    if (why && s.current === spec) {
      if (spec.update) {
        try {
          spec.update(s.body.firstChild, app, why);
        } catch (e) {
          console.error(`[wiki] sidebar ${spec.id}:`, e);
        }
        return;
      }
      // Someone is typing in it: drawing it again would lose that.
      if (s.body.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) return;
    }
    const scroll = s.current === spec ? s.body.firstChild?.scrollTop ?? 0 : 0;
    s.cleanup?.();
    s.cleanup = null;
    s.current = spec;
    const inner = el("div", { class: "wiki-side-panel", "data-panel": spec.id });
    put(s.body, inner);
    try {
      const done = spec.render(inner, app);
      Promise.resolve(done).then((c) => {
        if (s.current === spec && s.body.firstChild === inner) s.cleanup = typeof c === "function" ? c : null;
        else if (typeof c === "function") c();
      }).catch((e) => showBroken(inner, spec.title, e));
    } catch (e) {
      showBroken(inner, spec.title, e);
    }
    inner.scrollTop = scroll;
  }

  function showPanel(which, id) {
    if (layout[which].panel === id && !isPhone() && layout[which].open && !sides[which].aside.hidden) {
      return drawSide(which);
    }
    layout[which].panel = id;
    saveLayout();
    if (isPhone()) {
      drawer.left = false;
      drawer.right = false;
      drawer[which] = true;
    } else layout[which].open = true;
    applySides();
    drawSide(which);
  }
  app.sidebar.show = (which, id) => showPanel(which, id);
  app.sidebar.toggle = (which, open) => toggleSide(which, open);
  app.sidebar.isOpen = (which) => !sides[which].aside.hidden;
  app.sidebar.close = closeDrawers;

  function drawFoot() {
    const foot = sides.left.foot;
    const trashed = app.wiki.trashed().length;
    const item = (name, label, route, extra = null) => el("button", {
      class: `wiki-foot-item${app.route().view === route.view ? " active" : ""}`, title: label,
      onclick: (e) => {
        app.open(route, { newTab: e.ctrlKey || e.metaKey });
        if (isPhone()) closeDrawers();
      } }, icon(name), el("span", {}, label), extra);
    put(foot, 
      item("house", "Home", { view: "home" }),
      item("trash-2", "Trash", { view: "trash" }, trashed ? el("span", { class: "wiki-count" },
        String(trashed)) : null),
      el("span", { class: "wiki-bar-fill" }),
      el("button", { class: "layr-button ghost icon small", title: "Settings", "aria-label": "Settings",
        onclick: () => (app.open({ view: "settings" }), isPhone() && closeDrawers()) }, icon("settings")));
  }

  // Resizing by dragging the splitters.
  for (const which of ["left", "right"]) {
    const sp = splits[which];
    sp.addEventListener("dblclick", () => toggleSide(which, false));
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const width = layout[which].width;
      root.classList.add("resizing");
      const move = (ev) => {
        const dx = ev.clientX - start;
        const max = Math.min(MAX_SIDE, window.innerWidth - 320);
        layout[which].width = Math.round(Math.max(MIN_SIDE, Math.min(max, width + (which === "left" ? dx : -dx))));
        sides[which].aside.style.width = `${layout[which].width}px`;
      };
      const up = () => {
        sp.removeEventListener("pointermove", move);
        sp.removeEventListener("pointerup", up);
        sp.removeEventListener("pointercancel", up);
        root.classList.remove("resizing");
        saveLayout();
      };
      sp.addEventListener("pointermove", move);
      sp.addEventListener("pointerup", up);
      sp.addEventListener("pointercancel", up);
    });
  }

  // ---------- tabs ----------

  let dragTab = null;
  function drawTabs() {
    const tabs = app.tabs.list();
    const active = app.tabs.active();
    put(tabsEl, ...tabs.map((t, i) => {
      const title = app.tabs.title(t);
      const node = el("div", { class: `wiki-tab${i === active ? " active" : ""}`, role: "tab", draggable: "true",
        "aria-selected": String(i === active), title, "data-index": String(i) },
      tabIcon(app.tabs.icon(t)),
      el("span", { class: "wiki-tab-title" }, title),
      el("button", { class: "wiki-tab-close", title: "Close (Ctrl+W)", "aria-label": `Close ${title}`,
        onclick: (e) => {
          e.stopPropagation();
          app.tabs.close(i);
        } }, icon("x")));
      node.addEventListener("click", () => app.tabs.activate(i));
      node.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
      node.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        app.tabs.close(i);
      });
      node.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        app.ui.menu([
          { label: "Close", icon: "close", shortcut: "Ctrl+W", run: () => app.tabs.close(i) },
          { label: "Close other tabs", icon: "tab_close", disabled: tabs.length < 2,
            run: () => app.tabs.closeOthers(i) },
          { label: "Reopen closed tab", icon: "undo", shortcut: "Ctrl+Shift+T", run: () => app.tabs.reopen() },
          "-",
          { label: "Duplicate", icon: "content_copy", run: () => app.open({ ...t.route }, { newTab: true }) },
        ], e).catch(app.ui.fail);
      });
      node.addEventListener("dragstart", (e) => {
        dragTab = i;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-wiki-tab", String(i));
        const page = t.route.view === "page" ? app.wiki.pages.get(t.route.id) : null;
        if (page) e.dataTransfer.setData("text/plain", `[[${page.title}]]`);
        node.classList.add("dragging");
      });
      node.addEventListener("dragend", () => {
        dragTab = null;
        for (const n of tabsEl.querySelectorAll(".drop-before, .drop-after, .dragging")) {
          n.classList.remove("drop-before", "drop-after", "dragging");
        }
      });
      node.addEventListener("dragover", (e) => {
        if (dragTab === null) return;
        e.preventDefault();
        const r = node.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        node.classList.toggle("drop-after", after);
        node.classList.toggle("drop-before", !after);
      });
      node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
      node.addEventListener("drop", (e) => {
        if (dragTab === null) return;
        e.preventDefault();
        const r = node.getBoundingClientRect();
        let to = i + (e.clientX > r.left + r.width / 2 ? 1 : 0);
        if (dragTab < to) to -= 1;
        app.tabs.move(dragTab, to);
      });
      return node;
    }), newTabBtn);
    tabsEl.querySelector(".wiki-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const cur = app.tabs.current();
    put(tabSwitch, tabIcon(app.tabs.icon(cur)), el("span", { class: "wiki-tab-title" }, app.tabs.title(cur)),
      tabs.length > 1 ? el("span", { class: "wiki-count" }, String(tabs.length)) : null, icon("chevron-down"));
    $id("btnBack").disabled = !app.canBack();
    $id("btnForward").disabled = !app.canForward();
    setTitle();
  }

  function setTitle() {
    const r = app.route();
    const t = r.view === "home" ? "Wiki" : r.view === "page" ? app.routeTitle(r) : `${app.routeTitle(r)} · Wiki`;
    if (t !== setTitle.last) {
      setTitle.last = t;
      layr.panel.setTitle(t).catch(() => {});
      document.title = t;
    }
  }

  /** The phone's tab list: a sheet with every tab, close buttons and a new tab. */
  function openTabSwitcher() {
    app.ui.modal("Tabs", (body, close) => {
      const list = el("ul", { class: "wiki-tablist" });
      const fill = () => put(list, ...app.tabs.list().map((t, i) => el("li", {
        class: i === app.tabs.active() ? "active" : null,
        onclick: () => (app.tabs.activate(i), close()),
      }, tabIcon(app.tabs.icon(t)), el("span", { class: "wiki-tab-title" }, app.tabs.title(t)),
      el("button", { class: "layr-button ghost icon small", "aria-label": "Close tab", onclick: (e) => {
        e.stopPropagation();
        app.tabs.close(i);
        fill();
      } }, icon("x")))));
      fill();
      add(body, list, el("div", { class: "wiki-row" },
        el("button", { class: "layr-button", onclick: () => (app.open({ view: "home" }, { newTab: true }), close()) },
          icon("plus"), " New tab"),
        el("button", { class: "layr-button ghost", onclick: () => (app.tabs.closeOthers(), close()) },
          "Close the others")));
    });
  }

  // ---------- the view ----------

  const viewState = { cleanup: null, root: null, token: 0, key: "" };
  let drawn = null;

  function cleanupView() {
    try {
      viewState.cleanup?.();
    } catch (e) {
      console.error("[wiki] view cleanup:", e);
    }
    viewState.cleanup = null;
    app.editor = null;
  }

  /** Draw the active tab's view; `keepScroll` keeps where it was (a redraw after a change). */
  function drawView({ keepScroll = false } = {}) {
    const t = app.tabs.current();
    const route = t?.route ?? { view: "home" };
    const scroll = keepScroll ? viewHost.scrollTop : t?.scroll ?? 0;
    cleanupView();
    const token = ++viewState.token;
    const spec = app.views.get(route.view);
    const inner = el("div", { class: "wiki-view-root", "data-view": route.view });
    viewState.root = inner;
    viewState.key = routeKey(route);
    put(viewHost, inner);
    root.dataset.view = route.view;
    drawn = t;
    if (!spec) {
      add(inner, el("div", { class: "wiki-empty" }, icon("puzzle", "big"),
        el("h2", {}, "This view isn't available"),
        el("p", { class: "layr-muted" }, `“${route.view}” comes with a part of the wiki that isn't loaded.`),
        el("button", { class: "layr-button", onclick: () => app.open({ view: "home" }, { replace: true }) },
          "Go home")));
      return;
    }
    try {
      const done = spec.render(inner, route, app);
      Promise.resolve(done).then((c) => {
        if (token === viewState.token) viewState.cleanup = typeof c === "function" ? c : null;
        else if (typeof c === "function") c();
        if (token === viewState.token) viewHost.scrollTop = scroll;
      }).catch((e) => token === viewState.token && showBroken(inner, app.routeTitle(route), e));
    } catch (e) {
      showBroken(inner, app.routeTitle(route), e);
    }
    viewHost.scrollTop = scroll;
  }

  app.on("leave", (t) => {
    if (t && t === drawn) t.scroll = viewHost.scrollTop;
  });

  /** Data changed: draw the view again, unless it is being edited or said it updates itself (`redraw: false`). */
  function redrawView() {
    const spec = app.views.get(app.route().view);
    if (spec?.redraw === false || app.editor) return;
    const a = document.activeElement;
    if (viewHost.contains(a) && a.matches("input, textarea, select, [contenteditable], [contenteditable] *")) return;
    drawView({ keepScroll: true });
  }

  // ---------- the more menu ----------

  async function moreMenu(e) {
    const route = app.route();
    const page = app.page();
    const mark = markFor(app, route);
    const items = [
      { label: "Command palette", icon: "terminal", shortcut: keyLabel(app.commands.key("command-palette")),
        run: () => app.commands.run("command-palette") },
      { label: "Quick switcher", icon: "search", shortcut: keyLabel(app.commands.key("quick-switcher")),
        run: () => app.commands.run("quick-switcher") },
      "-",
      mark ? { label: isBookmarked(mark) ? "Remove bookmark" : "Bookmark", icon: "bookmark",
        run: () => toggleBookmark(app, mark) } : null,
      page ? { label: "Open in a new tab", icon: "open_in_new", run: () => app.openPage(page.id,
        { newTab: true }) } : null,
      page ? { label: "Rename…", icon: "edit", shortcut: keyLabel(app.commands.key("rename-page")),
        run: () => app.commands.run("rename-page") } : null,
      page ? { label: "Move to folder…", icon: "drive_file_move", run: () => app.commands.run("move-page") } : null,
      page ? { label: "Copy link", icon: "link", run: () => app.commands.run("copy-link") } : null,
      page ? { label: "Show in the file tree", icon: "account_tree",
        run: () => app.commands.run("reveal-page") } : null,
      ...(page ? app.pageMenu.items(page) : []),
      "-",
      { label: layout.focus ? "Leave focus mode" : "Focus mode", icon: "fullscreen",
        shortcut: keyLabel(app.commands.key("focus-mode")), run: () => setFocus(!layout.focus) },
      { label: "Settings", icon: "settings", run: () => app.open({ view: "settings" }) },
      page ? "-" : null,
      page ? { label: "Move to the trash", icon: "delete", danger: true,
        run: () => app.commands.run("trash-page") } : null,
    ].filter(Boolean);
    await app.ui.menu(items, e).catch(app.ui.fail);
  }

  // ---------- focus mode ----------

  function setFocus(on) {
    layout.focus = on;
    root.classList.toggle("focus", on);
    applySides();
    if (!on) for (const w of ["left", "right"]) drawSide(w);
  }
  app.setFocus = setFocus;
  app.isFocus = () => layout.focus;

  // ---------- keys ----------

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (document.querySelector(".wiki-modal-back, .wiki-menu")) return;
    const key = keyFromEvent(e);
    if (!key) return;
    const typing = e.target?.matches?.("input, textarea, select, [contenteditable], [contenteditable] *");
    // Plain keys while typing are the text; Ctrl/Alt combinations and F-keys are commands.
    if (typing && !/^(ctrl|alt)\+/.test(key) && !/^(shift\+)?f\d+$/.test(key)) return;
    const ids = app.commands.keys().byKey.get(key) ?? [];
    for (const id of ids) {
      const cmd = app.commands.get(id);
      if (!cmd || (cmd.when && !cmd.when(app))) continue;
      e.preventDefault();
      e.stopPropagation();
      Promise.resolve().then(() => cmd.run(app)).catch(app.ui.fail);
      return;
    }
  });

  // ---------- links anywhere in the panel ----------

  const linkOf = (e) => {
    const a = e.target?.closest?.("a[data-page], [data-wiki-link]");
    if (!a || a.closest(".cm-editor")) return null;
    return a;
  };
  const openLink = (a, newTab) => {
    const title = a.dataset.page ?? a.dataset.wikiLink;
    app.openPage(title, { heading: a.dataset.heading || null, newTab });
    if (isPhone() && !newTab) closeDrawers();
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const link = linkOf(e);
    if (link) {
      e.preventDefault();
      return openLink(link, e.ctrlKey || e.metaKey);
    }
    const tag = e.target?.closest?.("a.tag[data-tag], a[data-tag]");
    if (tag && !tag.closest(".cm-editor")) {
      e.preventDefault();
      return openSearch(`#${tag.dataset.tag}`, e.ctrlKey || e.metaKey);
    }
    const file = e.target?.closest?.("a[data-file]");
    if (file && !file.closest(".cm-editor")) {
      e.preventDefault();
      return download(file.dataset.file);
    }
    const hash = e.target?.closest?.('a[href^="#"]');
    if (hash && viewHost.contains(hash) && hash.getAttribute("href").length > 1) {
      e.preventDefault();
      const id = decodeURIComponent(hash.getAttribute("href").slice(1));
      (viewHost.querySelector(`[id="${CSS.escape(id)}"]`) ??
        viewHost.querySelector(`[id="${CSS.escape(id.toLowerCase())}"]`))
        ?.scrollIntoView({ block: "start" });
    }
  });
  document.addEventListener("mousedown", (e) => e.button === 1 && linkOf(e) && e.preventDefault());
  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || e.defaultPrevented) return;
    const link = linkOf(e);
    if (!link) return;
    e.preventDefault();
    openLink(link, true);
  });
  let hoverTimer = null;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const a = e.target?.closest?.("a[data-page], [data-wiki-link]");
    if (!a || a.closest(".wiki-tab, .wiki-side-strip")) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!a.isConnected || !app.settings.get("hoverPreview") || !a.matches(":hover")) return;
      try {
        app.hoverPreview(a, a.dataset.page ?? a.dataset.wikiLink, { heading: a.dataset.heading || null });
      } catch (err) {
        console.error("[wiki] hover preview:", err);
      }
    }, 350);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.target?.closest?.("a[data-page], [data-wiki-link]")) clearTimeout(hoverTimer);
  });

  function openSearch(query, newTab = false) {
    if (newTab || (isPhone() && !app.sidebar.list("left").some((p) => p.id === "search"))) {
      return app.open({ view: "search", query }, { newTab });
    }
    showPanel("left", "search");
    app.emit("search", query);
  }
  app.search = openSearch;

  async function download(name) {
    try {
      const { record, bytes } = await app.files.download(name);
      const url = URL.createObjectURL(new Blob([bytes], { type: record.mime }));
      const a = el("a", { href: url, download: record.name });
      add(document.body, a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      app.ui.fail(error);
    }
  }

  // ---------- phone: swipe from the edges, the + button ----------

  let touch = null;
  document.addEventListener("touchstart", (e) => {
    if (!isPhone() || e.touches.length !== 1) return;
    const t = e.touches[0];
    const edge = 28;
    const fromLeft = t.clientX < edge;
    const fromRight = t.clientX > window.innerWidth - edge;
    const inLeft = !sides.left.aside.hidden && sides.left.aside.contains(e.target);
    const inRight = !sides.right.aside.hidden && sides.right.aside.contains(e.target);
    touch = { x: t.clientX, y: t.clientY, fromLeft, fromRight, inLeft, inRight, at: Date.now() };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!touch || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) {
      touch = null;
      return;
    }
    if (Math.abs(dx) < 50) return;
    if (touch.fromLeft && dx > 0 && !drawer.left) toggleSide("left", true);
    else if (touch.fromRight && dx < 0 && !drawer.right && app.sidebar.list("right").length) toggleSide("right", true);
    else if ((touch.inLeft && dx < 0) || (touch.inRight && dx > 0)) closeDrawers();
    else return;
    touch = null;
  }, { passive: true });
  document.addEventListener("touchend", () => (touch = null), { passive: true });

  let press = null;
  let longDone = false;
  fab.addEventListener("pointerdown", () => {
    longDone = false;
    clearTimeout(press);
    press = setTimeout(() => {
      longDone = true;
      app.commands.run("today").catch(app.ui.fail);
    }, 550);
  });
  const stopPress = () => clearTimeout(press);
  fab.addEventListener("pointerup", stopPress);
  fab.addEventListener("pointerleave", stopPress);
  fab.addEventListener("contextmenu", (e) => e.preventDefault());
  fab.addEventListener("click", () => {
    if (longDone) return;
    app.commands.run("quick-note").catch(app.ui.fail);
  });
  const drawFab = () => {
    // Not over the editor (its keyboard toolbar sits there) nor over views with their own box at the bottom.
    const r = app.route();
    fab.hidden = !isPhone() || Boolean(app.editor) || r.mode === "edit" || r.view === "ask" || r.view === "review";
  };

  // ---------- the Look settings ----------

  function applyLook() {
    const s = app.settings.all();
    const html = document.documentElement;
    html.style.setProperty("--wiki-font", FONTS[s.font] ?? FONTS.sans);
    html.style.setProperty("--wiki-font-size", `${s.fontSize}px`);
    html.style.setProperty("--wiki-line-width", LINE_WIDTHS[s.lineWidth] ?? LINE_WIDTHS.normal);
    html.dataset.density = s.density;
    if (s.accent && /^#[0-9a-f]{3,8}$|^rgb|^hsl|^[a-z]+$/i.test(s.accent)) {
      html.style.setProperty("--wiki-accent", s.accent);
      html.style.setProperty("--wiki-accent-fg", contrastFg(s.accent));
      html.dataset.wikiAccent = "";
    } else {
      html.style.removeProperty("--wiki-accent");
      delete html.dataset.wikiAccent;
    }
    applyTheme();
    root.classList.toggle("no-page-icons", !s.pageIcons);
  }
  /** The wiki's own light or dark, over layr's (layr.js sets data-theme on every theme change: set it again). */
  function applyTheme() {
    const html = document.documentElement;
    const mode = app.settings.get("theme");
    if (mode === "light" || mode === "dark") {
      html.dataset.wikiTheme = mode;
      html.dataset.theme = mode;
      html.style.colorScheme = mode;
    } else {
      delete html.dataset.wikiTheme;
      const layrMode = layr.info?.theme?.mode;
      if (layrMode) {
        html.dataset.theme = layrMode === "light" ? "light" : "dark";
        html.style.colorScheme = html.dataset.theme;
      }
    }
  }
  layr.events.on("layr:theme", () => setTimeout(applyTheme, 0));

  // ---------- wiring ----------

  let pending = null;
  const later = (fn) => {
    pending = pending ?? new Set();
    pending.add(fn);
    if (pending.size === 1) {
      setTimeout(() => {
        const list = pending;
        pending = null;
        for (const f of list) f();
      }, 40);
    }
  };
  const redrawSides = () => {
    drawSide("left", "changed");
    drawSide("right", "changed");
    drawFoot();
  };

  app.on("tabs", () => drawTabs());
  app.on("route", () => {
    drawView();
    drawTabs();
    drawFoot();
    drawFab();
    drawSide("left", "route");
    drawSide("right", "route");
    if (isPhone()) closeDrawers();
  });
  app.on("refresh", () => drawView({ keepScroll: true }));
  app.on("changed", () => later(() => {
    drawTabs();
    redrawSides();
    redrawView();
  }));
  app.on("bookmarks", () => later(redrawSides));
  app.on("settings", () => {
    applyLook();
    later(redrawSides);
  });
  app.on("layout", () => later(() => {
    applySides();
    drawSide("left");
    drawSide("right");
  }));
  app.on("editor", drawFab);
  app.on("commands", () => {});

  window.matchMedia("(max-width: 700px)").addEventListener("change", () => {
    drawer.left = false;
    drawer.right = false;
    applySides();
    drawSide("left");
    drawSide("right");
    drawFab();
  });

  applyLook();
  applySides();
  drawSide("left");
  drawSide("right");
  drawFoot();
  drawTabs();
  drawView();
  drawFab();

  return { drawView, drawTabs, applySides, toggleSide, setFocus, openTabSwitcher, closeDrawers };
}

const $id = (id) => document.getElementById(id);

/** An icon by Lucide name, or an emoji (types may use either). */
export function tabIcon(name) {
  if (name && !/^[a-z0-9_-]+$/.test(name)) return el("span", { class: "icon emoji", "aria-hidden": "true" }, name);
  return icon(name || "file");
}

function showBroken(root, what, error) {
  console.error(`[wiki] ${what}:`, error);
  put(root, el("div", { class: "wiki-empty" }, icon("triangle-alert", "big"),
    el("h2", {}, `${what || "This"} couldn't be shown`),
    el("p", { class: "layr-error" }, error?.message ?? String(error))));
}

function contrastFg(color) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(color).trim());
  if (!m) return "#ffffff";
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.substr(i, 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0d1020" : "#ffffff";
}
