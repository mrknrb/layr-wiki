// The wiki: pages, their history, links and search, over a small data adapter, so the panel (layr.db / layr.data)
// and the backend (the hub's layr__db_* / layr__data_*) run the same code. Tested in test/wiki.test.js.
//
// Where things are (the plugin's own data, synced between the user's devices since the manifest says "sync": true):
// - db collection `pages`: one record per page, `{title, markdown, by, agent?, device?, updated, trashed?}`. The id
//   never changes; `markdown` is the whole file as it is written to the folder copy (properties block and text).
// - data `rev/<page id>/<stamp>`: the page's history, `{title, markdown, by, agent?, device?, at, note?}`. A save
//   updates the newest revision when the same author (and device, and agent) saved within the last 10 minutes, else
//   adds one; old ones thin out (pruneRevisions). Revisions of a page edited on two devices at once both survive.
// - data `type/<name>`: the user's own page types (types.js); data `file/<name>`: attachments (files.js).
//
// adapter: {dbList(collection, {limit, before}), dbGet, dbInsert(collection, value) → {id}, dbUpdate, dbDelete,
//           dataGet, dataSet, dataDelete, dataList({prefix, limit, after}), emit(topic, data)}
import { setProperties, splitFrontmatter, stringifyYaml } from "./frontmatter.js";
import { asList, extractLinks, fileTargets, inlineTags, isFileTarget, keyOf, mentions, propertyLink, renameLinks,
  titleProblem } from "./links.js";
import { findType, mergeTypes, templateFor } from "./types.js";

export const PAGES = "pages";
export const COALESCE_MS = 10 * 60 * 1000;
const KEEP_RECENT = 40;
const KEEP_MAX = 120;

/** A revision key's stamp: the time in base 36 (sorts as text) and a little randomness. */
export const stamp = (at) => `${Math.floor(at).toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 6)}`;
export const revPrefix = (pageId) => `rev/${pageId}/`;

/** A page record → the page with everything read from its Markdown. */
export function parsePage(id, value, meta = {}) {
  const markdown = String(value?.markdown ?? "");
  const { props, body } = splitFrontmatter(markdown);
  const links = extractLinks(markdown);
  const pageLinks = [];
  const seen = new Set();
  for (const l of links) {
    if (isFileTarget(l.target) || seen.has(keyOf(l.target))) continue;
    seen.add(keyOf(l.target));
    pageLinks.push(l.target);
  }
  // Links written in properties without the [[ ]] syntax count too when a field is a link (organism: "[[Mouse]]").
  for (const v of Object.values(props).flatMap(asList)) {
    const t = propertyLink(v);
    if (t && !seen.has(keyOf(t))) {
      seen.add(keyOf(t));
      pageLinks.push(t);
    }
  }
  const tags = [...new Set([...asList(props.tags), ...inlineTags(body)].map((t) => t.replace(/^#/, "")))];
  return {
    id,
    title: String(value?.title ?? ""),
    markdown,
    body,
    props,
    type: props.type ? String(props.type) : null,
    aliases: asList(props.aliases),
    tags,
    links: pageLinks,
    files: fileTargets(markdown),
    by: value?.by ?? "you",
    agent: value?.agent ?? null,
    device: value?.device ?? null,
    updated: value?.updated ?? meta.updatedAt ?? 0,
    created: meta.createdAt ?? value?.updated ?? 0,
    trashed: value?.trashed ?? null,
  };
}

/** Revisions newest first (by time, then by key). */
const newestFirst = (a, b) => b.at - a.at || String(b.key).localeCompare(String(a.key));

/** Which revision keys to delete: keep the newest KEEP_RECENT, then the newest of each older day, at most KEEP_MAX. */
export function pruneRevisions(revs) {
  const sorted = [...revs].sort((a, b) => b.at - a.at);
  const keep = new Set(sorted.slice(0, KEEP_RECENT).map((r) => r.key));
  const days = new Set();
  for (const r of sorted.slice(KEEP_RECENT)) {
    const day = new Date(r.at).toISOString().slice(0, 10);
    if (days.has(day) || keep.size >= KEEP_MAX) continue;
    days.add(day);
    keep.add(r.key);
  }
  return sorted.filter((r) => !keep.has(r.key)).map((r) => r.key);
}

/** The revision to go back to to undo the newest change: the first older one written by someone else. */
export function undoTarget(revs) {
  const sorted = [...revs].sort(newestFirst);
  if (sorted.length < 2) return null;
  const who = (r) => `${r.by}|${r.agent ?? ""}`;
  const last = who(sorted[0]);
  return sorted.find((r) => who(r) !== last) ?? null;
}

/** Search score of one page for the query's words (0: no match). */
function score(page, words, phrase) {
  const title = keyOf(page.title);
  const aliases = page.aliases.map(keyOf);
  const tags = page.tags.map(keyOf);
  const body = page.body.toLowerCase();
  let total = 0;
  if (title === phrase || aliases.includes(phrase)) total += 100;
  else if (title.startsWith(phrase)) total += 40;
  for (const w of words) {
    let s = 0;
    if (title.includes(w)) s += 20;
    if (aliases.some((a) => a.includes(w))) s += 15;
    if (tags.some((t) => t === w)) s += 10;
    if (page.type && keyOf(page.type) === w) s += 5;
    if (s === 0) {
      const n = body.split(w).length - 1;
      if (n) s += Math.min(5, n);
    }
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

/** A short piece of `body` around the first of `words` it holds. */
export function snippet(body, words, width = 140) {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), Infinity);
  if (at === Infinity) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

export class Wiki {
  /** `who`: the default author of changes (`you`, `ai`, `plugin:<id>`); `device`: this device's id. */
  constructor(adapter, { who = "you", device = null, now = () => Date.now() } = {}) {
    this.a = adapter;
    this.who = who;
    this.device = device;
    this.now = now;
    this.pages = new Map();
    this.customTypes = [];
    this.lastRevs = new Map(); // page id → {last: newest revision without its text, count}
    this.index = null;
  }

  // ---------- loading ----------

  /** Read every page and the user's page types. */
  async load() {
    const pages = new Map();
    let before;
    for (;;) {
      const rows = await this.a.dbList(PAGES, { limit: 500, before });
      for (const r of rows) pages.set(r.id, parsePage(r.id, r.value, r));
      if (rows.length < 500) break;
      before = rows[rows.length - 1].id;
    }
    this.pages = pages;
    this.lastRevs.clear();
    await this.loadTypes();
    this.index = null;
    return this;
  }

  async loadTypes() {
    const rows = await this.a.dataList({ prefix: "type/", limit: 1000 });
    this.customTypes = rows.map((r) => r.value).filter((v) => v && v.name);
  }

  /** Read these pages again (after an event or a sync); a page that is gone is dropped. */
  async refresh(ids) {
    for (const id of ids) {
      this.lastRevs.delete(id); // someone else wrote: their revision may be the newest now
      const r = await this.a.dbGet(PAGES, id);
      if (r) this.pages.set(id, parsePage(id, r.value, r));
      else this.pages.delete(id);
    }
    this.index = null;
  }

  // ---------- reading ----------

  /** Live pages (not in the trash). */
  live() {
    return [...this.pages.values()].filter((p) => !p.trashed);
  }

  trashed() {
    return [...this.pages.values()].filter((p) => p.trashed).sort((a, b) => b.trashed - a.trashed);
  }

  /** Title and alias (lowercase) → page, the oldest page winning when two share one; and links → backlinks. */
  idx() {
    if (this.index) return this.index;
    const byKey = new Map();
    const live = this.live().sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    for (const p of live) if (!byKey.has(keyOf(p.title))) byKey.set(keyOf(p.title), p);
    for (const p of live) for (const a of p.aliases) if (!byKey.has(keyOf(a))) byKey.set(keyOf(a), p);
    const backlinks = new Map();
    const wanted = new Map();
    for (const p of live) {
      for (const t of p.links) {
        const target = byKey.get(keyOf(t));
        if (target) {
          if (target.id === p.id) continue;
          if (!backlinks.has(target.id)) backlinks.set(target.id, []);
          backlinks.get(target.id).push(p);
        } else {
          const k = keyOf(t);
          if (!wanted.has(k)) wanted.set(k, { title: t, from: [] });
          wanted.get(k).from.push(p);
        }
      }
    }
    this.index = { byKey, backlinks, wanted };
    return this.index;
  }

  /** The live page a link target, title or alias means (any case), or null. */
  resolve(target) {
    return this.idx().byKey.get(keyOf(String(target ?? "").replace(/\.md$/i, ""))) ?? null;
  }

  /** A page by id, else by title or alias; trashed ones only by id. */
  find(idOrTitle) {
    if (idOrTitle === null || idOrTitle === undefined) return null;
    return this.pages.get(idOrTitle) ?? this.resolve(idOrTitle);
  }

  /** `find`, or an error an AI can act on. */
  need(idOrTitle) {
    const page = this.find(idOrTitle) ?? this.trashed().find((p) => keyOf(p.title) === keyOf(idOrTitle));
    if (page && !page.trashed) return page;
    const hint = this.search(String(idOrTitle ?? ""), { limit: 5 }).map((r) => r.page.title);
    throw new Error(
      `No page "${idOrTitle}"${page?.trashed ? " (it is in the trash: restore it first)" : ""}.` +
        (hint.length ? ` Similar: ${hint.join(", ")}` : ""),
    );
  }

  backlinks(id) {
    return [...(this.idx().backlinks.get(id) ?? [])].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Pages that name this page's title (or an alias) in their text without linking to it. */
  unlinkedMentions(id) {
    const page = this.pages.get(id);
    if (!page) return [];
    const linked = new Set(this.backlinks(id).map((p) => p.id));
    const names = [page.title, ...page.aliases];
    return this.live()
      .filter((p) => p.id !== id && !linked.has(p.id) && names.some((n) => mentions(p.body, n)))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Links to pages that don't exist yet, most wanted first: `[{title, from: [pages]}]`. */
  wanted() {
    return [...this.idx().wanted.values()].sort((a, b) => b.from.length - a.from.length || a.title.localeCompare(b.title));
  }

  /** Pages nothing links to (Home pages left out). */
  orphans() {
    const { backlinks } = this.idx();
    return this.live()
      .filter((p) => !backlinks.has(p.id) && keyOf(p.title) !== "home")
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Titles (any case) more than one live page has. */
  duplicates() {
    const by = new Map();
    for (const p of this.live()) by.set(keyOf(p.title), [...(by.get(keyOf(p.title)) ?? []), p]);
    return [...by.values()].filter((list) => list.length > 1);
  }

  /** `[{page, score, snippet}]`, best first. `type`, `tag`: only pages of that type / with that tag. */
  search(query, { type = null, tag = null, limit = 30 } = {}) {
    const phrase = keyOf(query);
    const words = phrase.split(/\s+/).filter(Boolean);
    const tagKey = tag ? keyOf(String(tag).replace(/^#/, "")) : null;
    const results = [];
    for (const page of this.live()) {
      if (type && keyOf(page.type) !== keyOf(type)) continue;
      if (tagKey && !page.tags.some((t) => keyOf(t) === tagKey)) continue;
      const s = words.length ? score(page, words, phrase) : 1;
      if (s > 0) results.push({ page, score: s, snippet: snippet(page.body, words) });
    }
    results.sort((a, b) => b.score - a.score || b.page.updated - a.page.updated);
    return results.slice(0, limit);
  }

  /** Recently changed live pages, newest first. */
  recent(limit = 20) {
    return this.live()
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit);
  }

  types() {
    return mergeTypes(this.customTypes);
  }

  type(name) {
    return findType(this.types(), name);
  }

  /** A new page's Markdown for this type name (empty for none). */
  template(typeName) {
    const type = this.type(typeName);
    if (!type && typeName) return `---\ntype: ${typeName}\n---\n\n`;
    return templateFor(type, { stringify: stringifyYaml });
  }

  /** `title` is free for a new page (or for renaming `exceptId`)? Throws with the reason when not. */
  checkTitle(title, exceptId = null) {
    const problem = titleProblem(title);
    if (problem) throw new Error(problem);
    const taken = this.live().find((p) => p.id !== exceptId && keyOf(p.title) === keyOf(title));
    if (taken) throw new Error(`There is a page "${taken.title}" already`);
  }

  // ---------- history ----------

  /** The page's revisions, newest first: `[{key, title, markdown, by, agent, device, at, note}]`. */
  async revisions(id) {
    const out = [];
    let after;
    for (;;) {
      const rows = await this.a.dataList({ prefix: revPrefix(id), limit: 1000, after });
      for (const r of rows) out.push({ key: r.key, ...r.value });
      if (rows.length < 1000) break;
      after = rows[rows.length - 1].key;
    }
    return out.sort(newestFirst);
  }

  /** Record `markdown` as the page's newest revision (coalescing an editing burst of one author). */
  async addRevision(id, { title, markdown, by, agent = null, note = null, at: when }) {
    // The newest revision is remembered, so a save doesn't read the whole history; it is read again for thinning.
    let cached = this.lastRevs.get(id);
    if (!cached) {
      const revs = await this.revisions(id);
      cached = { last: revs[0] ? { ...revs[0], markdown: undefined } : null, count: revs.length };
      this.lastRevs.set(id, cached);
    }
    const last = cached.last;
    // Strictly after the newest one, so two saves in the same millisecond keep their order.
    const at = Math.max(when, (last?.at ?? 0) + 1);
    const same =
      last && !note && !last.note && last.by === by && (last.agent ?? null) === agent &&
      (last.device ?? null) === this.device && at - last.at < COALESCE_MS;
    const value = { title, markdown, by, agent, device: this.device, at, ...(note ? { note } : {}) };
    if (same) {
      await this.a.dataSet(last.key, value);
      cached.last = { ...last, at, title };
      return;
    }
    const key = revPrefix(id) + stamp(at);
    await this.a.dataSet(key, value);
    cached.last = { key, title, by, agent, device: this.device, at, note };
    cached.count++;
    if (cached.count > KEEP_RECENT) {
      const revs = await this.revisions(id);
      const drop = new Set(pruneRevisions(revs));
      for (const k of drop) await this.a.dataDelete(k);
      cached.count = revs.length - drop.size;
    }
  }

  // ---------- writing ----------

  /** The author fields of a change. */
  author(opts = {}) {
    return { by: opts.by ?? this.who, agent: opts.agent ?? null };
  }

  async write(id, value, rev) {
    await this.a.dbUpdate(PAGES, id, value);
    this.pages.set(id, parsePage(id, value, { createdAt: this.pages.get(id)?.created }));
    this.index = null;
    await this.addRevision(id, { title: value.title, markdown: value.markdown, by: value.by, agent: value.agent,
      at: value.updated, note: rev?.note ?? null });
  }

  changed(ids, extra = {}) {
    try {
      this.a.emit?.("wiki:changed", { ids, by: this.who, ...extra });
    } catch {
      // events are best effort
    }
  }

  /** A new page. `markdown` defaults to the type's template. Gives the page. */
  async create({ title, type = null, markdown = null }, opts = {}) {
    const t = String(title ?? "").trim();
    this.checkTitle(t);
    const text = markdown ?? this.template(type);
    const md = type && markdown !== null && !splitFrontmatter(text).props.type ? setProperties(text, { type }) : text;
    const { by, agent } = this.author(opts);
    const at = this.now();
    const value = { title: t, markdown: md, by, agent, device: this.device, updated: at };
    const { id } = await this.a.dbInsert(PAGES, value);
    this.pages.set(id, parsePage(id, value, { createdAt: at }));
    this.index = null;
    await this.addRevision(id, { title: t, markdown: md, by, agent, at, note: "created" });
    this.changed([id]);
    return this.pages.get(id);
  }

  /** Replace a page's Markdown. Nothing is written when it is the same. */
  async save(id, markdown, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    const md = String(markdown ?? "");
    if (md === page.markdown && !page.trashed) return page;
    const { by, agent } = this.author(opts);
    const value = { title: page.title, markdown: md, by, agent, device: this.device, updated: this.now() };
    await this.write(id, value, { note: opts.note ?? null });
    if (!opts.quiet) this.changed([id]);
    return this.pages.get(id);
  }

  /** Rename a page and fix every link to it (and to its old title in other pages). Gives `{page, updated: n}`. */
  async rename(id, newTitle, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    const t = String(newTitle ?? "").trim();
    if (t === page.title) return { page, updated: 0 };
    this.checkTitle(t, id);
    const old = page.title;
    const { by, agent } = this.author(opts);
    const ids = [id];
    let updated = 0;
    for (const other of this.live()) {
      const { markdown, count } = renameLinks(other.markdown, old, t);
      if (!count) continue;
      if (other.id === id) continue;
      updated++;
      ids.push(other.id);
      await this.save(other.id, markdown, { by, agent, quiet: true, note: `link renamed: ${old} → ${t}` });
    }
    const self = renameLinks(page.markdown, old, t).markdown;
    const value = { title: t, markdown: self, by, agent, device: this.device, updated: this.now() };
    await this.write(id, value, { note: `renamed from ${old}` });
    this.changed(ids);
    return { page: this.pages.get(id), updated };
  }

  /** Move a page to the trash (it keeps its history and can come back). */
  async trash(id, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    const { by, agent } = this.author(opts);
    const value = { title: page.title, markdown: page.markdown, by, agent, device: this.device, updated: this.now(),
      trashed: this.now() };
    await this.a.dbUpdate(PAGES, id, value);
    this.pages.set(id, parsePage(id, value, { createdAt: page.created }));
    this.index = null;
    this.changed([id]);
    return this.pages.get(id);
  }

  /** Bring a page back from the trash (a free title is needed: else it gets " (restored)"). */
  async untrash(id, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    let title = page.title;
    if (this.live().some((p) => keyOf(p.title) === keyOf(title))) title = `${title} (restored)`;
    const { by, agent } = this.author(opts);
    const value = { title, markdown: page.markdown, by, agent, device: this.device, updated: this.now() };
    await this.write(id, value, { note: "restored from the trash" });
    this.changed([id]);
    return this.pages.get(id);
  }

  /** Delete a page for good, with its history (the panel asks the user first; never offered to the AI). */
  async destroy(id) {
    for (const r of await this.revisions(id)) await this.a.dataDelete(r.key);
    this.lastRevs.delete(id);
    await this.a.dbDelete(PAGES, id);
    this.pages.delete(id);
    this.index = null;
    this.changed([id]);
  }

  /** Put an older revision back as the newest version (`revKey` null: undo the newest change). */
  async restore(id, revKey = null, opts = {}) {
    const revs = await this.revisions(id);
    const rev = revKey ? revs.find((r) => r.key === revKey) : undoTarget(revs);
    if (!rev) throw new Error(revKey ? `No revision ${revKey}` : "There is nothing older to go back to");
    const page = this.pages.get(id);
    if (page?.trashed) await this.untrash(id, opts);
    const when = new Date(rev.at).toISOString().slice(0, 16).replace("T", " ");
    return this.save(id, rev.markdown, { ...opts, note: `restored the version of ${when}` });
  }

  /** Change some properties (null removes one). */
  async setProps(id, changes, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    return this.save(id, setProperties(page.markdown, changes), opts);
  }

  /** Save a page type of the user's own (or change a built-in one). */
  async defineType(type) {
    const name = String(type?.name ?? "").trim();
    if (!/^[\p{L}][\p{L}\p{N} _-]{0,39}$/u.test(name)) throw new Error("A type's name: a letter, then up to 39 letters, digits, spaces, _ or -");
    const value = {
      name,
      ...(type.icon ? { icon: String(type.icon).slice(0, 8) } : {}),
      ...(Array.isArray(type.fields) ? { fields: type.fields.map(cleanField) } : {}),
      ...(Array.isArray(type.sections) ? { sections: type.sections.map(String) } : {}),
      ...(type.description ? { description: String(type.description) } : {}),
    };
    await this.a.dataSet(`type/${name.toLowerCase()}`, value);
    await this.loadTypes();
    this.changed([], { types: true });
    return this.type(name);
  }
}

function cleanField(f) {
  const key = String(f?.key ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new Error(`A field key: lowercase letters, digits and _ ("${key}")`);
  const kinds = ["text", "link", "links", "list", "date", "number", "url"];
  return {
    key,
    label: String(f.label ?? key.replace(/_/g, " ")),
    ...(f.kind && kinds.includes(f.kind) ? { kind: f.kind } : {}),
    ...(f.url ? { url: String(f.url) } : {}),
    ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
  };
}
