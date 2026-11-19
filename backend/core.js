// The backend's workings without its transport (server.js adds the MCP server and the hub): the wiki model over the
// plugin's data, the tools, the folder copy, and what to do when pages change elsewhere. Tests run it with a fake store.
import { Files } from "../shared/files.js";
import { FOLDER_PREFIX } from "../shared/folders.js";
import { PROPOSAL_PREFIX } from "../shared/proposals.js";
import { SETTINGS_KEY } from "../shared/settings.js";
import { TYPE_PREFIX } from "../shared/types.js";
import { BOOKMARKS_KEY, PAGES, Wiki } from "../shared/wiki.js";
import { Mirror } from "./mirror.js";
import { authorOf, buildTools, READS } from "./tools.js";

/** The plugin's data store through the hub, in the shape shared/wiki.js wants. */
export function hubAdapter(hub) {
  return {
    dbList: (collection, opts = {}) => hub.call("layr__db_list", { collection, ...opts }),
    dbGet: (collection, id) => hub.call("layr__db_get", { collection, id }),
    dbInsert: (collection, value) => hub.call("layr__db_insert", { collection, value }),
    dbUpdate: (collection, id, value) => hub.call("layr__db_update", { collection, id, value }),
    dbDelete: (collection, id) => hub.call("layr__db_delete", { collection, id }),
    dataGet: (key) => hub.call("layr__data_get", { key }),
    dataSet: (key, value) => hub.call("layr__data_set", { key, value }),
    dataDelete: (key) => hub.call("layr__data_delete", { key }),
    dataList: (opts = {}) => hub.call("layr__data_list", opts),
    emit: (topic, data) => hub.emit(topic, { ...data, origin: "backend" }),
  };
}

/**
 * Everything but the transport, so tests can run it with a fake adapter. `settings()` → the layr settings (the folder
 * copy's); the wiki's own settings (history, review mode, templates) are its data key `settings`, read on load and
 * again when they change.
 */
export function createBackend({ adapter, session, settings, device = null, dataDir = null, log = () => {} }) {
  const wiki = new Wiki(adapter, { who: "ai", device });
  let loaded = null;
  let loadedAt = 0;
  const getWiki = async ({ reload = false } = {}) => {
    // Pages change on other devices and in the panels: read everything again now and then, besides the events.
    if (reload || !loaded || Date.now() - loadedAt > 5 * 60 * 1000) {
      loaded = wiki.load().then(() => (loadedAt = Date.now()));
      loaded.catch(() => (loaded = null));
    }
    await loaded;
    return wiki;
  };
  const files = new Files({ session, adapter, who: "ai" });
  const mirror = new Mirror({ getWiki, files, settings, log });
  const tools = buildTools({ getWiki, files, mirror, dataDir });

  /**
   * Something changed elsewhere (a panel, another device): read it again and update the folder copy. `{ids, types,
   * folders, bookmarks, proposals, settings}` as wiki:changed and changedFromSync give them.
   */
  const onChanged = async (change = {}) => {
    if (loaded) {
      await loaded.catch(() => {});
      await wiki.reloadData({ ...change, ids: change.ids ?? [] });
    }
    if (change.ids?.length || change.folders) mirror.schedule();
  };

  /** The wiki's settings changed (the panel's Settings page): use them from now on. */
  const reloadSettings = async () => {
    if (loaded) await loaded.catch(() => {});
    return wiki.loadSettings();
  };

  const call = async (name, args = {}, meta = undefined) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    const result = await tool.handler(args, authorOf(meta));
    if (!READS.has(name)) mirror.schedule();
    return result;
  };
  return { wiki, getWiki, files, mirror, tools, call, onChanged, reloadSettings };
}

/**
 * A `layr:data.changed` event's share for this plugin → the page ids that changed, and whether types, folders,
 * bookmarks, proposals or the settings did.
 */
export function changedFromSync(data) {
  const ids = data?.collections?.[PAGES] ?? [];
  const keys = data?.keys ?? [];
  const has = (prefix) => keys.some((k) => k.startsWith(prefix));
  return {
    ids,
    types: has(TYPE_PREFIX),
    folders: has(FOLDER_PREFIX),
    bookmarks: keys.includes(BOOKMARKS_KEY),
    proposals: has(PROPOSAL_PREFIX),
    settings: keys.includes(SETTINGS_KEY),
  };
}
