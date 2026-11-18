// The panel's `app` object (PLAN.md › The panel): the loaded wiki, settings, dialogs, tabs and their routes, and the
// registries the parts fill in their `install(app)`. No drawing here: shell.js draws the frame and listens to the
// topics this file emits ("tabs", "route", "refresh", "changed", "settings", "editor", "layout").
import { put } from "./dom.js";
import { keyOf } from "../../shared/links.js";
import { normalizeSettings, readSettings, writeSettings } from "../../shared/settings.js";
import { effectiveKeys, routeKey } from "./pure.js";
import { makeUi } from "./ui.js";

const MAX_HISTORY = 50;

/** A list that keeps registrations by id (a later one with the same id replaces the earlier one) or in order. */
function registry(idOf = (x) => x.id) {
  const items = new Map();
  let n = 0;
  return {
    items,
    add(value) {
      const id = idOf(value) ?? `_${n++}`;
      items.set(id, value);
      return () => items.get(id) === value && items.delete(id);
    },
    list: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
  };
}

/**
 * `wiki` (loaded), `files`, `adapter` (the store the wiki uses), `settings` (normalized). Gives the app; parts are
 * installed into it afterwards, then shell.js starts it.
 */
export function createApp({ wiki, files, adapter, settings: initial }) {
  const topics = new Map();
  const ui = makeUi();

  const app = {
    wiki,
    files,
    ui,
    version: "0.2.0",

    on(topic, fn) {
      if (!topics.has(topic)) topics.set(topic, new Set());
      topics.get(topic).add(fn);
      return () => topics.get(topic)?.delete(fn);
    },
    emit(topic, data) {
      for (const fn of [...(topics.get(topic) ?? [])]) {
        try {
          const r = fn(data);
          if (r?.catch) r.catch((e) => console.error(`[wiki] ${topic} listener:`, e));
        } catch (e) {
          console.error(`[wiki] ${topic} listener:`, e);
        }
      }
    },

    tools: (name, args = {}) => layr.tools.run(name, args),
  };

  // ---------- settings ----------

  let all = normalizeSettings(initial ?? {});
  app.settings = {
    all: () => all,
    get: (id) => all[id],
    /** Change some settings ({id: value}; null: back to the default). Takes effect at once, then is saved. */
    async set(changes) {
      const merged = { ...all };
      for (const [k, v] of Object.entries(changes ?? {})) merged[k] = v === null ? undefined : v;
      all = normalizeSettings(merged);
      app.emit("settings", { ids: Object.keys(changes ?? {}) });
      all = await writeSettings(adapter, changes);
      adapter.emit("wiki:changed", { ids: [], settings: true });
      return all;
    },
    on: (fn) => app.on("settings", fn),
    /** Read them again (another tab or device changed them). */
    async reload() {
      all = await readSettings(adapter);
      app.emit("settings", { ids: null });
    },
  };

  // ---------- registries ----------

  const views = registry((v) => v.name);
  app.views = {
    /** A tab's content for `route.view`: `{title (text or (route, app) → text), icon, render(root, route, app)}`. */
    register: (name, spec) => views.add({ ...spec, name }),
    get: (name) => views.get(name),
    list: () => views.list(),
  };

  const sidebars = { left: registry(), right: registry() };
  app.sidebar = {
    /** A panel in a sidebar: `{id, title, icon, order, render(root, app) → cleanup?, update?, when?(app)}`. */
    register(side, spec) {
      const off = (sidebars[side] ?? sidebars.left).add(spec);
      app.emit("layout", { sidebar: side });
      return off;
    },
    list: (side) => (sidebars[side]?.list() ?? []).filter((s) => !s.when || safe(() => s.when(app)))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
    /** Show a sidebar panel (opens the sidebar). Set by shell.js. */
    show: () => {},
    toggle: () => {},
  };

  const commands = registry();
  app.commands = {
    /** `{id, title, icon?, key? ("ctrl+shift+k"), run(app), when?(app)}`: in the palette, on its key. */
    register(cmd) {
      const off = commands.add(cmd);
      app.emit("commands");
      return off;
    },
    list: () => commands.list().filter((c) => !c.when || safe(() => c.when(app))),
    all: () => commands.list(),
    get: (id) => commands.get(id),
    async run(id, ...args) {
      const cmd = commands.get(id);
      if (!cmd) throw new Error(`No command ${id}`);
      if (cmd.when && !safe(() => cmd.when(app))) return;
      return cmd.run(app, ...args);
    },
    /** The key a command has now (the user's or its own), as "ctrl+shift+k", or "". */
    key: (id) => effectiveKeys(commands.list(), all.hotkeys).byId.get(id) ?? "",
    keys: () => effectiveKeys(commands.list(), all.hotkeys),
  };

  const pageMenu = registry(() => null);
  app.pageMenu = {
    /** `(page, app) => [menu items]` for the page's ⋯ menu. */
    register: (fn) => pageMenu.add(fn),
    items(page) {
      const out = [];
      for (const fn of pageMenu.list()) {
        try {
          const items = fn(page, app) ?? [];
          if (items.length) out.push("-", ...items);
        } catch (e) {
          console.error("[wiki] page menu:", e);
        }
      }
      return out;
    },
  };

  const selectionActions = registry();
  app.selectionActions = {
    /** `{id, title, icon, run(editorApi, app)}`: offered on a text selection in the editor. */
    register: (action) => selectionActions.add(action),
    list: () => selectionActions.list(),
  };

  // ---------- defaults the other parts replace in their install ----------

  app.newPage = async ({ title = "", folder = null } = {}) => {
    const t = await ui.prompt("New page", { value: title, label: "Title", ok: "Create",
      check: (v) => (v ? checkMessage(wiki, v) : "Give the page a title") });
    if (!t) return null;
    const page = await wiki.create({ title: t, folder: folder ?? app.defaultFolder() });
    await app.openPage(page.id, { mode: "edit" });
    return page;
  };
  app.markdown = (root, markdown) => {
    // C2 renders properly; this keeps text readable until then.
    put(root, ui.el("pre", { class: "wiki-plain" }, String(markdown ?? "")));
  };
  app.hoverPreview = () => {};
  app.ai = { available: () => false, ask: async () => {
    throw new Error("Ask needs the Claude Code plugin");
  } };

  // The active editor: its selection events go out as app "selection" (AI actions listen to them).
  let editor = null;
  let offSelection = null;
  Object.defineProperty(app, "editor", {
    get: () => editor,
    set: (value) => {
      if (value === editor) return;
      offSelection?.();
      offSelection = null;
      editor = value ?? null;
      try {
        const off = editor?.on?.("selection", (data) => app.emit("selection", { editor, ...data }));
        if (typeof off === "function") offSelection = off;
      } catch {
        // an editor without events
      }
      app.emit("editor", editor);
    },
    enumerable: true,
  });

  /** Open an outside address: layr:// links through layr, web pages in a layr tab (else the system's way). */
  app.openUrl = async (url) => {
    const u = String(url ?? "");
    if (u.startsWith("layr://")) return layr.links.open(u);
    try {
      await layr.panels.open("page", { url: u }, { plugin: "browser" });
    } catch {
      window.open(u, "_blank", "noopener");
    }
  };

  /** Let the user pick files: gives File objects (an empty list when cancelled). */
  app.pickFiles = ({ multiple = true, accept = "" } = {}) => new Promise((resolve) => {
    const input = ui.el("input", { type: "file", multiple: multiple || null, accept: accept || null, hidden: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      input.remove();
      resolve([...(input.files ?? [])]);
    };
    input.addEventListener("change", finish);
    input.addEventListener("cancel", finish);
    document.body.append(input);
    input.click();
  });

  // ---------- tabs and routes ----------

  let nextTab = 1;
  const nav = { tabs: [], active: 0, closed: [] };
  const tab = () => nav.tabs[nav.active] ?? null;
  const newTab = (route) => ({ id: nextTab++, route, back: [], fwd: [], scroll: 0 });

  app.tabs = {
    list: () => nav.tabs,
    active: () => nav.active,
    current: tab,
    /** Put tabs back (start, restored state). */
    restore(tabs, active = 0) {
      nav.tabs = tabs.map((t) => ({ ...newTab(t.route), back: t.back ?? [], fwd: t.fwd ?? [] }));
      if (!nav.tabs.length) nav.tabs.push(newTab({ view: "home" }));
      nav.active = Math.min(active, nav.tabs.length - 1);
      changedTabs(true);
    },
    activate(i) {
      if (i < 0 || i >= nav.tabs.length || i === nav.active) return;
      app.emit("leave", tab());
      nav.active = i;
      changedTabs(true);
    },
    step(delta) {
      if (nav.tabs.length > 1) app.tabs.activate((nav.active + delta + nav.tabs.length) % nav.tabs.length);
    },
    close(i = nav.active) {
      const closing = nav.tabs[i];
      if (!closing) return;
      if (i === nav.active) app.emit("leave", closing);
      nav.closed.push(closing);
      if (nav.closed.length > 20) nav.closed.shift();
      nav.tabs.splice(i, 1);
      if (!nav.tabs.length) nav.tabs.push(newTab({ view: "home" }));
      const was = nav.active;
      if (i < nav.active || nav.active >= nav.tabs.length) nav.active = Math.max(0, nav.active - 1);
      changedTabs(i === was || i < was);
    },
    closeOthers(i = nav.active) {
      const keep = nav.tabs[i];
      if (!keep) return;
      nav.closed.push(...nav.tabs.filter((t) => t !== keep));
      nav.tabs = [keep];
      const moved = nav.active !== i;
      nav.active = 0;
      changedTabs(moved);
    },
    reopen() {
      const t = nav.closed.pop();
      if (!t) return;
      nav.tabs.splice(nav.active + 1, 0, t);
      app.emit("leave", tab());
      nav.active += 1;
      changedTabs(true);
    },
    move(from, to) {
      if (from === to || from < 0 || from >= nav.tabs.length) return;
      const activeTab = tab();
      const [t] = nav.tabs.splice(from, 1);
      nav.tabs.splice(Math.max(0, Math.min(to, nav.tabs.length)), 0, t);
      nav.active = nav.tabs.indexOf(activeTab);
      changedTabs(false);
    },
    title: (t) => routeTitle(t?.route),
    icon: (t) => routeIcon(t?.route),
  };

  /** Tabs changed: save them; `routeChanged`: the active tab shows something else now. */
  function changedTabs(routeChanged) {
    app.emit("tabs");
    if (routeChanged) app.emit("route", tab()?.route);
    save();
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const trim = (list) => list.slice(-20);
      layr.panel.setState({
        v: 2,
        tabs: nav.tabs.map((t) => ({ route: t.route, back: trim(t.back), fwd: trim(t.fwd) })),
        active: nav.active,
        paramsDone: app.paramsDone ?? null,
      }).catch(() => {});
    }, 200);
  }
  app.saveState = save;

  /** Show `route` in the active tab (its place goes on Back), a new tab (`newTab`), or instead of it (`replace`). */
  app.open = async (route, { newTab: inNew = false, replace = false, background = false } = {}) => {
    if (!route?.view) throw new Error("A route needs a view");
    if (inNew || !tab()) {
      const t = newTab(route);
      nav.tabs.splice(nav.active + 1, 0, t);
      if (!background || nav.tabs.length === 1) {
        app.emit("leave", tab());
        nav.active = nav.tabs.indexOf(t);
        changedTabs(true);
      } else changedTabs(false);
      return;
    }
    const t = tab();
    app.emit("leave", t);
    if (!replace && routeKey(t.route) !== routeKey(route)) {
      t.back.push(t.route);
      if (t.back.length > MAX_HISTORY) t.back.shift();
      t.fwd = [];
    }
    t.route = route;
    t.scroll = 0;
    changedTabs(true);
  };

  app.back = () => {
    const t = tab();
    if (!t?.back.length) return false;
    app.emit("leave", t);
    t.fwd.push(t.route);
    t.route = t.back.pop();
    changedTabs(true);
    return true;
  };
  app.forward = () => {
    const t = tab();
    if (!t?.fwd.length) return false;
    app.emit("leave", t);
    t.back.push(t.route);
    t.route = t.fwd.pop();
    changedTabs(true);
    return true;
  };
  app.canBack = () => Boolean(tab()?.back.length);
  app.canForward = () => Boolean(tab()?.fwd.length);

  /** Change the active route's details (mode, heading) without a Back step or a redraw. */
  app.updateRoute = (changes) => {
    const t = tab();
    if (!t) return;
    t.route = { ...t.route, ...changes };
    for (const [k, v] of Object.entries(changes)) if (v === undefined || v === null) delete t.route[k];
    app.emit("tabs");
    save();
  };

  /** A page by id, title or alias, or the "missing page" view offering to create it. */
  app.openPage = (idOrTitle, { heading = null, line = null, newTab: inNew = false, mode = null, replace = false } =
  {}) => {
    const page = wiki.find(idOrTitle);
    const at = Number.isInteger(line) ? { line } : {};
    const route = page && !page.trashed
      ? { view: "page", id: page.id, ...(heading ? { heading } : {}), ...at, ...(mode ? { mode } : {}) }
      : { view: "missing", title: String(idOrTitle ?? "") };
    return app.open(route, { newTab: inNew, replace });
  };

  app.route = () => tab()?.route ?? { view: "home" };
  app.page = () => {
    const r = app.route();
    if (r.view !== "page") return null;
    const p = wiki.pages.get(r.id);
    return p && !p.trashed ? p : null;
  };
  app.refresh = () => app.emit("refresh");

  /** The folder new pages go in (settings.newPageFolder: the open page's or the top one). */
  app.defaultFolder = () => (all.newPageFolder === "current" ? app.page()?.folder ?? "" : "");

  function routeTitle(route) {
    if (!route) return "";
    if (route.view === "page") return wiki.pages.get(route.id)?.title ?? "Missing page";
    if (route.view === "missing") return route.title ?? "New page";
    const spec = views.get(route.view);
    const t = spec?.title;
    if (typeof t === "function") return safe(() => t(route, app), route.view) ?? route.view;
    return t ?? route.view;
  }
  function routeIcon(route) {
    if (!route) return "file";
    if (route.view === "page") {
      const page = wiki.pages.get(route.id);
      const type = page?.type ? safe(() => wiki.type(page.type)) : null;
      return type?.icon ?? "file-text";
    }
    if (route.view === "missing") return "file-plus";
    const spec = views.get(route.view);
    return (typeof spec?.icon === "function" ? safe(() => spec.icon(route, app)) : spec?.icon) ?? "file";
  }
  app.routeTitle = routeTitle;
  app.routeIcon = routeIcon;

  return app;
}

function safe(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function checkMessage(wiki, title) {
  try {
    wiki.checkTitle(title);
    return null;
  } catch (e) {
    return e.message;
  }
}

/** Two titles are the same page title (any case). */
export const sameTitle = (a, b) => keyOf(a) === keyOf(b);
