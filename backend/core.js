// The backend's workings without its transport (server.js adds the MCP server and the hub): the wiki model over the
// plugin's data, the tools, the folder copy, and what to do when pages change elsewhere. Tests run it with a fake store.
import { Files } from "../shared/files.js";
import { PAGES, Wiki } from "../shared/wiki.js";
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

/** Everything but the transport, so tests can run it with a fake adapter. */
export function createBackend({ adapter, session, settings, device = null, log = () => {} }) {
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
  const tools = buildTools({ getWiki, files, mirror });

  /** Pages changed elsewhere (a panel, another device): read them again and update the folder copy. */
  const onChanged = async ({ ids = [], types = false } = {}) => {
    if (loaded) {
      await loaded.catch(() => {});
      if (ids.length) await wiki.refresh(ids);
      if (types) await wiki.loadTypes();
    }
    mirror.schedule();
  };

  const call = async (name, args = {}, meta = undefined) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    const result = await tool.handler(args, authorOf(meta));
    if (!READS.has(name)) mirror.schedule();
    return result;
  };
  return { wiki, getWiki, files, mirror, tools, call, onChanged };
}

/** A `layr:data.changed` event's share for this plugin → the page ids that changed, and whether types did. */
export function changedFromSync(data) {
  const ids = data?.collections?.[PAGES] ?? [];
  const types = (data?.keys ?? []).some((k) => k.startsWith("type/"));
  return { ids, types };
}
