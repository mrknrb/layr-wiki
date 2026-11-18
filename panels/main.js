// The Wiki panel: read, write and link pages, on the PC and the phone. The pages are the plugin's own synced data
// (layr.db / layr.data), so the panel needs no backend: the backend (PC) only adds the AI tools and the folder copy.
// This file loads the wiki, makes `app` (app/app.js), installs the parts (each in a try/catch, so one broken part
// doesn't take the panel down), puts the tabs back and starts the frame (app/shell.js). PLAN.md › The panel.
import { Files } from "../shared/files.js";
import { readSettings } from "../shared/settings.js";
import { Wiki } from "../shared/wiki.js";
import { createApp } from "./app/app.js";
import { el } from "./app/dom.js";
import { startShell } from "./app/shell.js";
import { restoreTabs } from "./app/pure.js";
import { registerCommands, openToday, quickNote } from "./app/commands.js";
import { registerFiles } from "./app/files.js";
import { registerSearch } from "./app/search.js";
import { registerBookmarks, registerTags } from "./app/tags.js";
import { registerViews } from "./app/home.js";
import { registerSettingsPage } from "./app/settings-page.js";
import { loadBookmarks } from "./app/data.js";

const PARTS = ["./page/index.js", "./views/index.js", "./ai/index.js", "./io/index.js"];

await layr.ready;

const root = document.getElementById("wiki");
const instance = layr.info.instance;
let app = null;

/** The plugin's data store in the shape the model wants; events say which tab wrote, so it can ignore its own. */
const adapter = {
  dbList: (collection, opts = {}) => layr.db.list(collection, opts),
  dbGet: (collection, id) => layr.db.get(collection, id),
  dbInsert: (collection, value) => layr.db.insert(collection, value),
  dbUpdate: (collection, id, value) => layr.db.update(collection, id, value),
  dbDelete: (collection, id) => layr.db.delete(collection, id),
  dataGet: (key) => layr.data.get(key),
  dataSet: (key, value) => layr.data.set(key, value),
  dataDelete: (key) => layr.data.delete(key),
  dataList: (opts = {}) => layr.data.list(opts),
  emit: (topic, data) => {
    layr.events.emit(topic, { ...data, source: instance }).catch(() => {});
    // This tab's own changes: the frame redraws for them as for anyone else's.
    if (topic === "wiki:changed") queueMicrotask(() => app?.emit("changed", { ...data, local: true }));
  },
};

const wiki = new Wiki(adapter, { who: "you", device: layr.info.device?.id ?? null });
const files = new Files({ session: () => layr.tools.run("supabase_session", {}, { plugin: "layr" }), adapter });

// The parts load while the wiki does (a missing one just fails its import).
const parts = PARTS.map((path) => import(path).then((m) => ({ path, m }), (error) => ({ path, error })));

try {
  await wiki.load();
} catch (error) {
  root.replaceChildren(el("div", { class: "wiki-empty" }, el("h2", {}, "Couldn't read the wiki"),
    el("p", { class: "layr-error" }, error.message)));
  throw error;
}
const settings = wiki.settings ?? (await readSettings(adapter));

app = createApp({ wiki, files, adapter, settings });
window.wikiApp = app; // for the console and the end-to-end test

registerViews(app);
registerSettingsPage(app);
registerFiles(app);
registerSearch(app);
registerTags(app);
registerBookmarks(app);
registerCommands(app);
await loadBookmarks(app);

for (const { path, m, error } of await Promise.all(parts)) {
  if (error) {
    console.warn(`[wiki] ${path} not loaded:`, error?.message ?? error);
    continue;
  }
  try {
    await m.install?.(app);
  } catch (e) {
    console.error(`[wiki] ${path} install failed:`, e);
  }
}

// The model follows the settings (history, review mode, templates).
app.on("settings", () => wiki.setSettings?.(app.settings.all()));

// ---------- tabs back as they were, then what the panel was opened with ----------

const saved = layr.info.state ?? {};
const { tabs, active } = restoreTabs(saved);
app.paramsDone = saved.paramsDone ?? null;
app.tabs.restore(tabs, active);
startShell(app, root);

if (!tabs.length && app.settings.get("openDaily") && typeof wiki.dailyNote === "function") {
  openToday(app).catch(app.ui.fail);
}

/** In the active tab when it shows nothing yet (home without history), else in a new tab. */
const openHere = (route) => {
  const t = app.tabs.current();
  const fresh = t && t.route.view === "home" && !t.back.length;
  return app.open(route, { newTab: !fresh, replace: fresh });
};

/** What the panel was opened with: a page, a new page, search, a quick note, today's note. */
async function applyParams(params = {}, { start = false } = {}) {
  const key = JSON.stringify(params ?? {});
  // A restored tab gets its old params again: they were done then (e.g. a quick note was made).
  if (start && key === app.paramsDone) return;
  app.paramsDone = key;
  app.saveState();
  if (params.page) {
    const page = wiki.find(params.page);
    await openHere(page && !page.trashed ? { view: "page", id: page.id } : { view: "missing",
      title: String(params.page) });
  }
  if (params.new) await app.newPage({ title: typeof params.new === "string" ? params.new : "",
    folder: app.defaultFolder() });
  if (params.search) app.search(typeof params.search === "string" ? params.search : "");
  if (params.quickNote) await quickNote(app);
  if (params.today) await openToday(app);
}

layr.panel.onParams?.((params) => applyParams(params).catch(app.ui.fail));
await applyParams(layr.info.params ?? {}, { start: true }).catch(app.ui.fail);

// ---------- changes from elsewhere ----------

/** Read again what changed, then let everyone redraw. */
async function changedElsewhere(change, origin) {
  if (wiki.reloadData) await wiki.reloadData(change);
  else {
    if (change.ids?.length) await wiki.refresh(change.ids);
    if (change.types) await wiki.loadTypes();
  }
  if (change.bookmarks) await loadBookmarks(app);
  if (change.settings) await app.settings.reload();
  app.emit("changed", { ...change, remote: true, origin });
}

layr.events.on("wiki:changed", (data) => {
  if (!data || data.source === instance) return;
  const origin = data.origin === "backend" || data.by === "ai" ? "ai" : "tab";
  changedElsewhere({ ...data, ids: data.ids ?? [] }, origin).catch(app.ui.fail);
});

layr.data.onChange(({ keys = [], collections = {} } = {}) => {
  const has = (prefix) => keys.some((k) => k.startsWith(prefix));
  const change = {
    ids: collections.pages ?? [],
    types: has("type/"),
    folders: has("folder/"),
    views: has("view/"),
    proposals: has("proposal/"),
    bookmarks: keys.includes("bookmarks"),
    settings: keys.includes("settings"),
  };
  if (!change.ids.length && !Object.values(change).some((v) => v === true)) return;
  changedElsewhere(change, "device").catch(app.ui.fail);
});

await layr.expect("shell", ".wiki-bar", { min: 1, label: "The wiki's toolbar" });
