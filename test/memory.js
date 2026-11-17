// An in-memory stand-in for the plugin's data store (layr.data / layr.db), with the same shapes and ordering as the
// core: data.list sorted by key, db.list newest first, ids that sort by time.

let counter = 0;

export function memoryAdapter() {
  const kv = new Map();
  const db = new Map(); // collection → Map(id → {id, value, createdAt, updatedAt})
  const events = [];
  const col = (c) => {
    if (!db.has(c)) db.set(c, new Map());
    return db.get(c);
  };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    kv,
    db,
    events,
    async dbList(collection, { limit = 50, before, after } = {}) {
      let rows = [...col(collection).values()].sort((a, b) => b.id.localeCompare(a.id));
      if (before) rows = rows.filter((r) => r.id < before);
      if (after) rows = rows.filter((r) => r.id > after);
      return clone(rows.slice(0, limit));
    },
    async dbGet(collection, id) {
      return clone(col(collection).get(id)) ?? null;
    },
    async dbInsert(collection, value) {
      counter++;
      const id = `${Date.now().toString(36).padStart(10, "0")}${String(counter).padStart(8, "0")}`;
      const now = Date.now();
      col(collection).set(id, { id, value: clone(value), createdAt: now, updatedAt: now });
      return { id };
    },
    async dbUpdate(collection, id, value) {
      const row = col(collection).get(id);
      if (!row) throw new Error(`not found: ${id}`);
      row.value = clone(value);
      row.updatedAt = Date.now();
      return null;
    },
    async dbDelete(collection, id) {
      col(collection).delete(id);
      return null;
    },
    async dataGet(key) {
      return clone(kv.get(key)?.value) ?? null;
    },
    async dataSet(key, value) {
      kv.set(key, { key, value: clone(value), updatedAt: Date.now() });
      return null;
    },
    async dataDelete(key) {
      kv.delete(key);
      return null;
    },
    async dataList({ prefix = "", limit = 100, after } = {}) {
      let rows = [...kv.values()].filter((r) => r.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
      if (after) rows = rows.filter((r) => r.key > after);
      return clone(rows.slice(0, limit));
    },
    emit(topic, data) {
      events.push({ topic, data });
    },
  };
}
