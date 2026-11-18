// The wiki: pages, their folders, history, links and search, types, templates, bookmarks and review mode, over a small
// data adapter, so the panel (layr.db / layr.data) and the backend (the hub's layr__db_* / layr__data_*) run the same
// code. Tested in test/wiki.test.js.
//
// Where things are (the plugin's own data, synced between the user's devices since the manifest says "sync": true):
// - db collection `pages`: one record per page, `{title, folder, markdown, by, agent?, device?, updated, trashed?}`.
//   The id never changes; `markdown` is the whole file as it is written to the folder copy (properties and text);
//   `folder` is "" (the top; 0.1 records have none) or a path "Projects/Thesis" (folders.js).
// - data `rev/<page id>/<stamp>`: the page's history, `{title, markdown, by, agent?, device?, at, note?}`. A save
//   updates the newest revision when the same author (and device, and agent) saved within the last few minutes
//   (setting historyMinutes), else adds one; old ones thin out (pruneRevisions). Revisions of a page edited on two
//   devices at once both survive. Moving a page to another folder isn't a revision (its text didn't change).
// - data `folder/<lowercase path>` = `{path}`: folders the user made (empty ones too); the others come from pages.
// - data `type/<lowercase name>`: the user's page types (types.js); `file/<name>`: attachments (files.js);
//   `bookmarks`: the pinned list; `proposal/<id>`: changes waiting for review (proposals.js); `settings` (settings.js).
//
// adapter: {dbList(collection, {limit, before}), dbGet, dbInsert(collection, value) → {id}, dbUpdate, dbDelete,
//           dataGet, dataSet, dataDelete, dataList({prefix, limit, after}), emit(topic, data)}
import { ancestors, checkFolder, cleanFolder, compareFolders, folderKey, FOLDER_PREFIX, isInside, joinPath, moveInto,
  nameOf } from "./folders.js";
import { setProperties, splitFrontmatter, stringifyYaml } from "./frontmatter.js";
import { asList, extractLinks, fileTargets, inlineTags, isFileTarget, keyOf, mentions, propertyLink, renameLinks,
  titleProblem } from "./links.js";
import { merge3, PROPOSAL_PREFIX, proposalId, proposalKey } from "./proposals.js";
import { normalizeSettings, readSettings } from "./settings.js";
import { dailyPath, fillTemplate, toDate } from "./templates.js";
import { cleanType, emptyValue, findType, normalizeType, templateFor, TYPE_PREFIX, typeKey } from "./types.js";

export const PAGES = "pages";
export const BOOKMARKS_KEY = "bookmarks";
export const BOOKMARK_KINDS = ["page", "view", "search", "folder", "tag"];
/** The defaults of the history settings (historyMinutes, historyRecent, historyMax). */
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
  // Links written in properties without the [[ ]] syntax count too when a field is a link (author: "[[Ann Lee]]").
  for (const v of Object.values(props).flatMap(asList)) {
    const t = propertyLink(v);
    if (t && !seen.has(keyOf(t)) && !isFileTarget(t)) {
      seen.add(keyOf(t));
      pageLinks.push(t);
    }
  }
  const tags = [...new Set([...asList(props.tags), ...inlineTags(body)].map((t) => t.replace(/^#/, "")))];
  const title = String(value?.title ?? "");
  const folder = cleanFolder(value?.folder);
  return {
    id,
    title,
    folder,
    path: joinPath(folder, title),
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

/**
 * Which revision keys to delete: keep the newest `recent`, then the newest of each older day, at most `max` in all
 * (the settings historyRecent and historyMax).
 */
export function pruneRevisions(revs, { recent = KEEP_RECENT, max = KEEP_MAX } = {}) {
  const sorted = [...revs].sort((a, b) => b.at - a.at);
  const keep = new Set(sorted.slice(0, Math.min(recent, max)).map((r) => r.key));
  const days = new Set();
  for (const r of sorted.slice(Math.min(recent, max))) {
    const day = new Date(r.at).toISOString().slice(0, 10);
    if (days.has(day) || keep.size >= max) continue;
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

/** A bookmark as given → a checked one (or an error). */
function cleanBookmark(b) {
  const kind = String(b?.kind ?? "");
  if (!BOOKMARK_KINDS.includes(kind)) throw new Error(`A bookmark's kind is one of ${BOOKMARK_KINDS.join(", ")}`);
  const target = String(b.target ?? "").trim();
  if (!target && kind !== "folder") throw new Error("A bookmark needs a target");
  const out = { kind, target, title: String(b.title ?? "").trim() || target || "Top folder" };
  // A bookmark of a view that isn't a page (graph, tasks, a search…) keeps the route the panel opens.
  if (b.route && typeof b.route === "object" && !Array.isArray(b.route)) out.route = b.route;
  return out;
}

export class Wiki {
  /**
   * `who`: the default author of changes (`you`, `ai`, `plugin:<id>`); `device`: this device's id; `history`:
   * `{minutes, recent, max}` (else the settings' historyMinutes, historyRecent, historyMax); `settings`: the wiki's
   * settings (else read from the data on load).
   */
  constructor(adapter, { who = "you", device = null, now = () => Date.now(), history = null, settings = null } = {}) {
    this.a = adapter;
    this.who = who;
    this.device = device;
    this.now = now;
    this.pages = new Map();
    this.customTypes = [];
    this.folderRecords = new Map(); // lowercase path → path
    this.bookmarkList = [];
    this.pending = new Map(); // proposal id → proposal
    this.lastRevs = new Map(); // page id → {last: newest revision without its text, count}
    this.index = null;
    this.fixedHistory = history;
    this.fixedSettings = Boolean(settings);
    this.setSettings(settings);
  }

  // ---------- settings ----------

  /** Use these settings (history, review mode, templates); missing ones are the defaults. */
  setSettings(settings) {
    this.settings = normalizeSettings(settings);
    this.review = Boolean(this.settings.aiReview);
    const s = this.settings;
    this.setHistory(this.fixedHistory ?? { minutes: s.historyMinutes, recent: s.historyRecent, max: s.historyMax });
    return this.settings;
  }

  /** How revisions are kept: one per `minutes` of a burst, `recent` kept in full, at most `max`. */
  setHistory({ minutes = COALESCE_MS / 60000, recent = KEEP_RECENT, max = KEEP_MAX } = {}) {
    const ms = Math.max(0, Number(minutes) || 0) * 60000;
    const count = (n, fallback) => Math.max(1, Number(n) || fallback);
    this.history = { ms, recent: count(recent, KEEP_RECENT), max: count(max, KEEP_MAX) };
    return this.history;
  }

  /** Read the settings from the data again (data key `settings`). */
  async loadSettings() {
    return this.setSettings(await readSettings(this.a));
  }

  // ---------- loading ----------

  /** Every data value under `prefix` (all batches): `[{key, value}]`. */
  async listData(prefix) {
    const out = [];
    let after;
    for (;;) {
      const rows = await this.a.dataList({ prefix, limit: 1000, after });
      out.push(...rows);
      if (rows.length < 1000) break;
      after = rows[rows.length - 1].key;
    }
    return out;
  }

  /** Read every page, the user's page types, folders, bookmarks, proposals and settings. */
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
    await Promise.all([this.loadTypes(), this.loadFolders(), this.loadBookmarks(), this.loadProposals(),
      this.fixedSettings ? null : this.loadSettings().catch(() => {})]);
    this.index = null;
    return this;
  }

  async loadTypes() {
    const rows = await this.listData(TYPE_PREFIX);
    this.customTypes = rows.map((r) => normalizeType(r.value)).filter(Boolean);
  }

  async loadFolders() {
    const rows = await this.listData(FOLDER_PREFIX);
    this.folderRecords = new Map(rows.map((r) => cleanFolder(r.value?.path)).filter(Boolean).map((p) => [keyOf(p), p]));
  }

  async loadBookmarks() {
    const list = await this.a.dataGet(BOOKMARKS_KEY).catch(() => null);
    this.bookmarkList = Array.isArray(list) ? list.filter((b) => b && BOOKMARK_KINDS.includes(b.kind)) : [];
  }

  async loadProposals() {
    const rows = await this.listData(PROPOSAL_PREFIX);
    this.pending = new Map(rows.filter((r) => r.value?.id).map((r) => [r.value.id, r.value]));
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

  /** Read again what an event says changed: `{ids, types, folders, bookmarks, proposals, settings}`. */
  async reloadData({ ids = [], types = false, folders = false, bookmarks = false, proposals = false,
    settings = false } = {}) {
    if (ids.length) await this.refresh(ids);
    if (types) await this.loadTypes();
    if (folders) await this.loadFolders();
    if (bookmarks) await this.loadBookmarks();
    if (proposals) await this.loadProposals();
    if (settings && !this.fixedSettings) await this.loadSettings();
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
    // [[Folder/Title]] (Obsidian writes paths when titles clash) means the page of that title.
    const lookup = (t) => byKey.get(keyOf(t)) ?? (String(t).includes("/") ? byKey.get(keyOf(nameOf(t))) : undefined);
    const backlinks = new Map();
    const wanted = new Map();
    for (const p of live) {
      for (const t of p.links) {
        const target = lookup(t);
        if (target) {
          if (target.id === p.id) continue;
          if (!backlinks.has(target.id)) backlinks.set(target.id, []);
          if (!backlinks.get(target.id).includes(p)) backlinks.get(target.id).push(p);
        } else {
          const k = keyOf(t);
          if (!wanted.has(k)) wanted.set(k, { title: t, from: [] });
          wanted.get(k).from.push(p);
        }
      }
    }
    this.index = { byKey, backlinks, wanted, lookup };
    return this.index;
  }

  /** The live page a link target, title or alias means (any case; "Folder/Title" too), or null. */
  resolve(target) {
    return this.idx().lookup(String(target ?? "").replace(/\.md$/i, "")) ?? null;
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

  /** Pages nothing links to (Home pages, templates and daily notes left out). */
  orphans() {
    const { backlinks } = this.idx();
    const { templatesFolder, dailyFolder } = this.settings;
    const within = (p, folder) => Boolean(folder) && Boolean(p.folder) && isInside(p.folder, folder);
    const kept = (p) => within(p, templatesFolder) || within(p, dailyFolder);
    return this.live()
      .filter((p) => !backlinks.has(p.id) && keyOf(p.title) !== "home" && !kept(p))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Titles (any case) more than one live page has. */
  duplicates() {
    const by = new Map();
    for (const p of this.live()) by.set(keyOf(p.title), [...(by.get(keyOf(p.title)) ?? []), p]);
    return [...by.values()].filter((list) => list.length > 1);
  }

  /**
   * `[{page, score, snippet}]`, best first. `type`, `tag`: only pages of that type / with that tag; `folder`: only
   * pages in that folder ("" the top), with its subfolders unless `subfolders` is false.
   */
  search(query, { type = null, tag = null, folder = null, subfolders = true, limit = 30 } = {}) {
    const phrase = keyOf(query);
    const words = phrase.split(/\s+/).filter(Boolean);
    const tagKey = tag ? keyOf(String(tag).replace(/^#/, "")) : null;
    const folderKey_ = folder === null || folder === undefined ? null : keyOf(cleanFolder(folder));
    const results = [];
    for (const page of this.live()) {
      if (type && keyOf(page.type) !== keyOf(type)) continue;
      if (tagKey && !page.tags.some((t) => keyOf(t) === tagKey || keyOf(t).startsWith(`${tagKey}/`))) continue;
      if (folderKey_ !== null) {
        if (subfolders ? !isInside(page.folder, folderKey_) : keyOf(page.folder) !== folderKey_) continue;
      }
      const s = words.length ? score(page, words, phrase) : 1;
      if (s > 0) results.push({ page, score: s, snippet: snippet(page.body, words) });
    }
    results.sort((a, b) => b.score - a.score || b.page.updated - a.page.updated);
    return results.slice(0, limit);
  }

  /** Live pages A to Z, optionally only of a folder (and its subfolders), type or tag. */
  list({ folder = null, subfolders = true, type = null, tag = null } = {}) {
    return this.search("", { folder, subfolders, type, tag, limit: Infinity }).map((r) => r.page)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Recently changed live pages, newest first. */
  recent(limit = 20) {
    return this.live()
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit);
  }

  /** `title` is free for a new page (or for renaming `exceptId`)? Throws with the reason when not. */
  checkTitle(title, exceptId = null) {
    const problem = titleProblem(title);
    if (problem) throw new Error(problem);
    const taken = this.live().find((p) => p.id !== exceptId && keyOf(p.title) === keyOf(title));
    if (taken) {
      throw new Error(`There is a page "${taken.title}" already${taken.folder ? ` (in ${taken.folder})` : ""}`);
    }
  }

  // ---------- folders ----------

  /** Every folder path (from pages and the folder records, their parents too), sorted, one spelling each. */
  folders() {
    const byKey = new Map();
    const add = (path) => {
      let spelled = "";
      for (const a of ancestors(path)) {
        const known = byKey.get(keyOf(a));
        spelled = known ?? joinPath(spelled, nameOf(a));
        if (!known) byKey.set(keyOf(a), spelled);
      }
    };
    for (const p of this.folderRecords.values()) add(p);
    for (const page of this.live()) add(page.folder);
    return [...byKey.values()].sort(compareFolders);
  }

  /** The folder's path as the wiki spells it, or null when there is no such folder ("" is the top). */
  folder(path) {
    const key = keyOf(cleanFolder(path));
    if (!key) return "";
    return this.folders().find((f) => keyOf(f) === key) ?? null;
  }

  /** `path` checked, its existing part spelled the way the wiki has it. */
  spellFolder(path) {
    const clean = checkFolder(path);
    let out = "";
    for (const a of ancestors(clean)) out = this.folder(a) ?? joinPath(out, nameOf(a));
    return out;
  }

  /** Make a folder (it stays when empty). Gives its path. */
  async createFolder(path) {
    const clean = this.spellFolder(path);
    if (!clean) throw new Error("The top folder is always there");
    if (!this.folderRecords.has(keyOf(clean))) {
      await this.a.dataSet(folderKey(clean), { path: clean });
      this.folderRecords.set(keyOf(clean), clean);
      this.changed([], { folders: true });
    }
    return clean;
  }

  /** A page's record with some fields changed (the page as it is otherwise). */
  recordOf(page, changes = {}) {
    const value = { title: page.title, folder: page.folder, markdown: page.markdown, by: page.by, agent: page.agent,
      device: page.device, updated: page.updated, ...changes };
    if (page.trashed && !("trashed" in changes)) value.trashed = page.trashed;
    if (!value.trashed) delete value.trashed;
    return value;
  }

  /** Change a page's folder in its record only (no revision: the text didn't change). */
  async setFolder(page, folder) {
    const value = this.recordOf(page, { folder });
    await this.a.dbUpdate(PAGES, page.id, value);
    this.pages.set(page.id, parsePage(page.id, value, { createdAt: page.created }));
    this.index = null;
  }

  /** Rename or move a folder with its pages and subfolders: `renameFolder("Work", "Archive/Work")`. */
  async renameFolder(from, to) {
    const src = this.folder(from);
    if (!src) throw new Error(`No folder "${from}"`);
    const dst = this.spellFolder(to);
    if (!dst) throw new Error("A folder can't become the top folder: move its pages instead");
    if (keyOf(dst) !== keyOf(src)) {
      if (isInside(dst, src)) throw new Error(`"${src}" can't go inside itself`);
      if (this.folder(dst) !== null) throw new Error(`There is a folder "${this.folder(dst)}" already`);
    } else if (cleanFolder(to) === src) return { path: src, moved: 0 };
    const target = keyOf(dst) === keyOf(src) ? cleanFolder(to) : dst;
    const ids = [];
    for (const page of [...this.pages.values()]) {
      if (!page.folder || !isInside(page.folder, src)) continue;
      await this.setFolder(page, moveInto(page.folder, src, target));
      ids.push(page.id);
    }
    const records = [...this.folderRecords.values()].filter((p) => isInside(p, src));
    for (const p of records) {
      await this.a.dataDelete(folderKey(p));
      this.folderRecords.delete(keyOf(p));
    }
    for (const p of [src, ...records]) {
      const moved = moveInto(p, src, target);
      if (this.folderRecords.has(keyOf(moved))) continue;
      await this.a.dataSet(folderKey(moved), { path: moved });
      this.folderRecords.set(keyOf(moved), moved);
    }
    const bookmarks = this.bookmarkList.map((b) =>
      b.kind === "folder" && b.target && isInside(b.target, src)
        ? { ...b, target: moveInto(b.target, src, target) }
        : b);
    const bookmarksChanged = bookmarks.some((b, i) => b !== this.bookmarkList[i]);
    if (bookmarksChanged) {
      this.bookmarkList = bookmarks;
      await this.a.dataSet(BOOKMARKS_KEY, bookmarks);
    }
    this.changed(ids, { folders: true, ...(bookmarksChanged ? { bookmarks: true } : {}) });
    return { path: target, moved: ids.length };
  }

  /**
   * Delete a folder and its subfolders. Only an empty one, unless `trashPages`: then its pages go to the trash
   * (they keep their folder, so restoring one brings the folder back). Gives `{path, trashed}`.
   */
  async deleteFolder(path, { trashPages = false } = {}, opts = {}) {
    const src = this.folder(path);
    if (!src) throw new Error(`No folder "${path}"`);
    const inside = this.live().filter((p) => p.folder && isInside(p.folder, src));
    if (inside.length && !trashPages) {
      throw new Error(`The folder "${src}" holds ${inside.length} page(s): move them out first, or delete it with ` +
        "its pages (they go to the trash)");
    }
    for (const p of inside) await this.trash(p.id, { ...opts, quiet: true });
    for (const p of [...this.folderRecords.values()].filter((f) => isInside(f, src))) {
      await this.a.dataDelete(folderKey(p));
      this.folderRecords.delete(keyOf(p));
    }
    this.changed(inside.map((p) => p.id), { folders: true });
    return { path: src, trashed: inside.length };
  }

  /** Move a page to a folder ("" the top; a new folder is made). */
  async move(id, folder, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    const target = this.spellFolder(folder);
    if (target === page.folder) return page;
    if (this.reviewing(opts)) {
      return this.propose({ op: "move", pageId: id, title: page.title, folder: target, base: page.markdown }, opts);
    }
    await this.setFolder(page, target);
    this.changed([id], { folders: true });
    return this.pages.get(id);
  }

  // ---------- types ----------

  /** The user's page types, A to Z. */
  types() {
    return [...this.customTypes].sort((a, b) => a.name.localeCompare(b.name));
  }

  type(name) {
    return findType(this.customTypes, name);
  }

  /** Every type name pages use or the user defined: `[{name, count, defined}]`, A to Z. */
  typesInUse() {
    const by = new Map();
    for (const t of this.customTypes) by.set(keyOf(t.name), { name: t.name, count: 0, defined: true });
    for (const p of this.live()) {
      if (!p.type) continue;
      const k = keyOf(p.type);
      if (!by.has(k)) by.set(k, { name: p.type, count: 0, defined: false });
      by.get(k).count++;
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A new page's Markdown for this type name (its properties and template, not yet filled in; "" for none). */
  template(typeName) {
    const type = this.type(typeName);
    if (!type && typeName) return `---\ntype: ${typeName}\n---\n\n`;
    return templateFor(type, { stringify: stringifyYaml });
  }

  /**
   * Add a page type or change one (by name, any case): what is given replaces what it had, the rest stays. Checked
   * (types.js cleanType). Gives the type.
   */
  async defineType(type) {
    const existing = this.type(type?.name);
    const given = Object.fromEntries(Object.entries(type ?? {}).filter(([, v]) => v !== undefined));
    if (given.sections && given.template === undefined) given.template = "";
    // An existing type keeps its spelling ("book" changes Book): renameType renames.
    const clean = cleanType(existing ? { ...existing, ...given, name: existing.name } : given);
    await this.a.dataSet(typeKey(clean.name), clean);
    this.customTypes = [...this.customTypes.filter((t) => keyOf(t.name) !== keyOf(clean.name)), normalizeType(clean)];
    this.changed([], { types: true });
    return this.type(clean.name);
  }

  /** Delete a type's definition; its pages keep their `type:` (shown with the default icon). Gives `{name, pages}`. */
  async deleteType(name) {
    const type = this.type(name);
    if (!type) throw new Error(`No type "${name}"`);
    await this.a.dataDelete(typeKey(type.name));
    this.customTypes = this.customTypes.filter((t) => keyOf(t.name) !== keyOf(type.name));
    this.changed([], { types: true });
    return { name: type.name, pages: this.live().filter((p) => keyOf(p.type) === keyOf(type.name)).length };
  }

  /**
   * Rename a type: its definition, link fields of other types that point at it, and `type:` in every page of it
   * (one revision each, recorded as the caller's). Gives `{type, updated}`.
   */
  async renameType(from, to, opts = {}) {
    const old = this.type(from);
    const pages = this.live().filter((p) => p.type && keyOf(p.type) === keyOf(from));
    if (!old && !pages.length) throw new Error(`No type "${from}"`);
    const retarget = (fields, name) =>
      fields.map((f) => (f.target && keyOf(f.target) === keyOf(from) ? { ...f, target: name } : f));
    const fresh = cleanType({ ...(old ?? { name: from }), name: to });
    const name = fresh.name;
    fresh.fields = retarget(fresh.fields, name);
    const exists = this.typesInUse().some((t) => keyOf(t.name) === keyOf(name));
    if (keyOf(name) !== keyOf(from) && exists) {
      throw new Error(`There is a type "${name}" already`);
    }
    if (old) {
      if (keyOf(old.name) !== keyOf(name)) await this.a.dataDelete(typeKey(old.name));
      await this.a.dataSet(typeKey(name), fresh);
    }
    for (const t of this.customTypes) {
      if (keyOf(t.name) === keyOf(from) || !t.fields.some((f) => f.target && keyOf(f.target) === keyOf(from))) continue;
      await this.a.dataSet(typeKey(t.name), cleanType({ ...t, fields: retarget(t.fields, name) }));
    }
    await this.loadTypes();
    const ids = [];
    for (const p of pages) {
      await this.save(p.id, setProperties(this.draft(p, opts), { type: name }),
        { ...opts, quiet: true, note: `type renamed: ${p.type} → ${name}` });
      ids.push(p.id);
    }
    this.changed(ids, { types: true });
    return { type: this.type(name), updated: ids.length };
  }

  // ---------- templates, daily notes ----------

  /** The template pages: the live pages in the templates folder (and its subfolders), A to Z. */
  templates(settings = this.settings) {
    const folder = cleanFolder(normalizeSettings(settings).templatesFolder);
    if (!folder) return [];
    return this.list({ folder });
  }

  /**
   * A new page's Markdown: `markdown` as it is; else a template page's (`template`: its id or title) or the type's
   * template, filled in. `body` replaces the text under the properties; `properties` are set; a `type` is written.
   */
  newMarkdown({ title, type = null, template = null, markdown = null, body, properties, date } = {}) {
    const fill = (md) => fillTemplate(md, { title, date: toDate(date ?? this.now()), settings: this.settings });
    let text;
    if (markdown !== null && markdown !== undefined) text = String(markdown);
    else if (template) {
      const page = this.find(template);
      if (!page || page.trashed) throw new Error(`No template page "${template}"`);
      text = fill(page.markdown);
    } else text = fill(this.template(type));
    if (body !== undefined && body !== null) {
      const { yaml } = splitFrontmatter(text);
      text = yaml === null ? String(body) : `---\n${yaml}\n---\n\n${String(body).replace(/^\n+/, "")}`;
    }
    if (type) {
      const { props } = splitFrontmatter(text);
      const add = {};
      if (!props.type) add.type = type;
      // A template page (or the given text) gets the type's fields it doesn't have yet.
      if (markdown === null || markdown === undefined) {
        for (const f of this.type(type)?.fields ?? []) if (!(f.key in props)) add[f.key] = emptyValue(f);
      }
      if (Object.keys(add).length) text = setProperties(text, add);
    }
    if (properties && Object.keys(properties).length) text = setProperties(text, properties);
    return text;
  }

  /** The page of `date`'s daily note; made (from the daily template, in the daily folder) when missing. */
  async dailyNote(date = this.now(), settings = this.settings, opts = {}) {
    const s = normalizeSettings(settings);
    const day = toDate(date);
    const { folder, title } = dailyPath(day, s);
    const existing = this.resolve(title);
    if (existing) return existing;
    if (opts.create === false) return null;
    // An agent in review mode gets its own new daily note that waits for review, rather than a second one.
    const pending = this.reviewing(opts)
      ? this.proposals().find((p) => p.op === "create" && keyOf(p.title) === keyOf(title)) : null;
    if (pending) return { ...pending, proposal: true };
    const tpl = s.dailyTemplate ? this.resolve(s.dailyTemplate) : null;
    const markdown = tpl ? fillTemplate(tpl.markdown, { title, date: day, settings: s }) : "";
    return this.create({ title, folder, markdown }, opts);
  }

  // ---------- bookmarks ----------

  /** The pinned pages, views, searches, folders and tags, in order: `[{kind, target, title}]`. */
  bookmarks() {
    return this.bookmarkList.map((b) => ({ ...b }));
  }

  async setBookmarks(list) {
    const clean = [];
    for (const b of Array.isArray(list) ? list : []) {
      const c = cleanBookmark(b);
      if (!clean.some((x) => x.kind === c.kind && keyOf(x.target) === keyOf(c.target))) clean.push(c);
    }
    await this.a.dataSet(BOOKMARKS_KEY, clean);
    this.bookmarkList = clean;
    this.changed([], { bookmarks: true });
    return this.bookmarks();
  }

  // ---------- history ----------

  /** The page's revisions, newest first: `[{key, title, markdown, by, agent, device, at, note}]`. */
  async revisions(id) {
    return (await this.listData(revPrefix(id))).map((r) => ({ key: r.key, ...r.value })).sort(newestFirst);
  }

  /** Record `markdown` as the page's newest revision (coalescing an editing burst of one author). */
  async addRevision(id, { title, markdown, by, agent = null, note = null, at: when }) {
    // The newest revision is remembered, so a save doesn't read the whole history; it is read again for thinning.
    let cached = this.lastRevs.get(id);
    if (!cached) {
      const revs = await this.revisions(id);
      cached = { last: revs[0] ? { ...revs[0], markdown: undefined } : null, count: revs.length, pruneAt: 0 };
      this.lastRevs.set(id, cached);
    }
    const last = cached.last;
    // Strictly after the newest one, so two saves in the same millisecond keep their order.
    const at = Math.max(when, (last?.at ?? 0) + 1);
    const same =
      last && !note && !last.note && last.by === by && (last.agent ?? null) === agent &&
      (last.device ?? null) === this.device && at - last.at < this.history.ms;
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
    const { recent, max } = this.history;
    // Thinning reads the whole history: done when there is something to thin, not on every save after that.
    if (cached.count > Math.min(recent, max) && cached.count >= cached.pruneAt) {
      const revs = await this.revisions(id);
      const drop = new Set(pruneRevisions(revs, { recent, max }));
      for (const k of drop) await this.a.dataDelete(k);
      cached.count = revs.length - drop.size;
      cached.pruneAt = cached.count >= max ? 0 : cached.count + Math.max(5, Math.ceil(Math.min(recent, max) / 4));
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

  /**
   * A new page: `{title, folder, type, template, markdown, body, properties}` (newMarkdown says how its text is
   * made). Gives the page (in review mode, for an agent: the proposal).
   */
  async create({ title, folder = "", type = null, template = null, markdown = null, body, properties } = {},
    opts = {}) {
    const t = String(title ?? "").trim();
    this.checkTitle(t);
    const where = this.spellFolder(folder ?? "");
    const md = this.newMarkdown({ title: t, type, template, markdown, body, properties });
    if (this.reviewing(opts)) {
      const clash = this.proposals().find((p) => p.op === "create" && keyOf(p.title) === keyOf(t));
      if (clash) throw new Error(`A new page "${clash.title}" is waiting for the user's review already: change that`);
      return this.propose({ op: "create", pageId: null, title: t, folder: where, markdown: md, base: null }, opts);
    }
    const { by, agent } = this.author(opts);
    const at = this.now();
    const value = { title: t, folder: where, markdown: md, by, agent, device: this.device, updated: at };
    const { id } = await this.a.dbInsert(PAGES, value);
    this.pages.set(id, parsePage(id, value, { createdAt: at }));
    this.index = null;
    await this.addRevision(id, { title: t, markdown: md, by, agent, at, note: opts.note ?? "created" });
    if (!opts.quiet) this.changed([id], where ? { folders: true } : {});
    return this.pages.get(id);
  }

  /** Replace a page's Markdown. Nothing is written when it is the same. */
  async save(id, markdown, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    const md = String(markdown ?? "");
    if (this.reviewing(opts)) {
      const mine = this.pendingSave(id, opts);
      if (mine ? md === mine.markdown : md === page.markdown) return mine ? { ...mine, proposal: true } : page;
      if (mine) return this.reviseProposal(mine.id, { markdown: md, note: opts.note ?? mine.note ?? null });
      return this.propose({ op: "save", pageId: id, title: page.title, folder: page.folder, markdown: md,
        base: page.markdown, note: opts.note ?? null }, opts);
    }
    if (md === page.markdown && !page.trashed) return page;
    const { by, agent } = this.author(opts);
    const value = this.recordOf(page, { markdown: md, by, agent, device: this.device, updated: this.now() });
    delete value.trashed;
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
    if (this.reviewing(opts)) {
      return this.propose({ op: "rename", pageId: id, title: page.title, folder: page.folder, newTitle: t,
        base: page.markdown }, opts);
    }
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
      await this.save(other.id, markdown,
        { by, agent, applying: true, quiet: true, note: `link renamed: ${old} → ${t}` });
    }
    const self = renameLinks(page.markdown, old, t).markdown;
    const value = this.recordOf(page,
      { title: t, markdown: self, by, agent, device: this.device, updated: this.now() });
    await this.write(id, value, { note: `renamed from ${old}` });
    this.changed(ids);
    return { page: this.pages.get(id), updated };
  }

  /** Move a page to the trash (it keeps its history and can come back). */
  async trash(id, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    if (this.reviewing(opts)) {
      return this.propose({ op: "trash", pageId: id, title: page.title, folder: page.folder, base: page.markdown },
        opts);
    }
    const { by, agent } = this.author(opts);
    const value = this.recordOf(page, { by, agent, device: this.device, updated: this.now(), trashed: this.now() });
    await this.a.dbUpdate(PAGES, id, value);
    this.pages.set(id, parsePage(id, value, { createdAt: page.created }));
    this.index = null;
    if (!opts.quiet) this.changed([id]);
    return this.pages.get(id);
  }

  /** Bring a page back from the trash (a free title is needed: else it gets " (restored)"). */
  async untrash(id, opts = {}) {
    const page = this.pages.get(id);
    if (!page) throw new Error(`No page ${id}`);
    let title = page.title;
    if (this.live().some((p) => keyOf(p.title) === keyOf(title))) title = `${title} (restored)`;
    const { by, agent } = this.author(opts);
    const value = this.recordOf(page, { title, by, agent, device: this.device, updated: this.now(), trashed: null });
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
    return this.save(id, setProperties(this.draft(page, opts), changes), opts);
  }

  /** `setProps` by another name. */
  setProperties(id, changes, opts = {}) {
    return this.setProps(id, changes, opts);
  }

  // ---------- review mode (proposals) ----------

  /** Does this change wait for review? Agents' changes do while the setting aiReview is on. */
  reviewing(opts = {}) {
    return this.review && !opts.applying && this.author(opts).by === "ai";
  }

  /** The changes waiting for review, oldest first. */
  proposals() {
    return [...this.pending.values()].sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  }

  /** The proposals about one page. */
  proposalsFor(pageId) {
    return this.proposals().filter((p) => p.pageId === pageId);
  }

  /** This author's pending text change of the page, or null. */
  pendingSave(pageId, opts = {}) {
    const { by, agent } = this.author(opts);
    return this.proposals().reverse().find((p) => p.op === "save" && p.pageId === pageId && p.by === by &&
      (p.agent ?? null) === agent) ?? null;
  }

  /**
   * The text a change by this author builds on: in review mode the agent's own pending version of the page (so its
   * edits add up before the user reviews them), else the page's.
   */
  draft(page, opts = {}) {
    if (!this.reviewing(opts)) return page.markdown;
    return this.pendingSave(page.id, opts)?.markdown ?? page.markdown;
  }

  /** Record a proposal. Gives it, marked `proposal: true`. */
  async propose(fields, opts = {}) {
    const { by, agent } = this.author(opts);
    // Strictly after the newest one, so proposals made in one burst keep their order.
    const at = Math.max(this.now(), ...this.proposals().map((p) => p.at + 1));
    const id = proposalId(at);
    const value = { id, ...fields, by, agent, at, note: fields.note ?? opts.note ?? null };
    await this.a.dataSet(proposalKey(id), value);
    this.pending.set(id, value);
    this.changed(value.pageId ? [value.pageId] : [], { proposals: true });
    return { ...value, proposal: true };
  }

  /**
   * Change a pending proposal (the agent changed its mind before the review): `{markdown, note, folder}`. It keeps
   * its place (`at`); `updated` says when it last changed.
   */
  async reviseProposal(id, changes) {
    const p = this.pending.get(id) ?? (await this.a.dataGet(proposalKey(id)));
    if (!p) throw new Error(`No proposal ${id}`);
    const value = { ...p, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      updated: this.now() };
    await this.a.dataSet(proposalKey(id), value);
    this.pending.set(id, value);
    this.changed(value.pageId ? [value.pageId] : [], { proposals: true });
    return { ...value, proposal: true };
  }

  /** The proposal of this id (in the cache or the data), or an error. */
  async proposal(id) {
    const p = this.pending.get(id) ?? (await this.a.dataGet(proposalKey(id)));
    if (!p) throw new Error(`No proposal ${id} (accepted or rejected already?)`);
    return p;
  }

  /**
   * Apply a proposal, as its author's change. A text change to a page that changed since it was proposed is merged
   * when the two touch different lines; else it fails and the proposal stays. Gives `{page, merged}`.
   */
  async accept(id) {
    const p = await this.proposal(id);
    const as = { by: p.by, agent: p.agent ?? null, applying: true };
    const page = p.pageId ? this.pages.get(p.pageId) : null;
    if (p.op !== "create" && (!page || page.trashed)) {
      throw new Error(`[[${p.title}]] ${page ? "is in the trash" : "is gone"}: reject this proposal`);
    }
    let result;
    let merged = false;
    if (p.op === "create") {
      result = await this.create({ title: p.title, folder: p.folder ?? "", markdown: p.markdown ?? "" },
        { ...as, note: "created (accepted from review)" });
    } else if (p.op === "save") {
      let text = p.markdown;
      if (p.base !== null && p.base !== undefined && page.markdown !== p.base) {
        const m = merge3(p.base, page.markdown, p.markdown);
        if (!m.ok) {
          throw new Error(`[[${page.title}]] changed since this was proposed, in the same lines (around line ` +
            `${m.conflicts[0].line}): it can't be applied as it is. Open the page and make the change by hand, or ` +
            "reject the proposal.");
        }
        text = m.text;
        merged = true;
      }
      result = await this.save(page.id, text, { ...as, note: "accepted from review" });
    } else if (p.op === "rename") {
      result = (await this.rename(page.id, p.newTitle, as)).page;
    } else if (p.op === "trash") {
      result = await this.trash(page.id, as);
    } else if (p.op === "move") {
      result = await this.move(page.id, p.folder ?? "", as);
    } else throw new Error(`Unknown proposal "${p.op}"`);
    await this.a.dataDelete(proposalKey(id));
    this.pending.delete(id);
    this.changed(result?.id ? [result.id] : [], { proposals: true });
    return { page: result, merged };
  }

  /** Drop a proposal: nothing changes. */
  async reject(id) {
    const p = await this.proposal(id);
    await this.a.dataDelete(proposalKey(id));
    this.pending.delete(id);
    this.changed(p.pageId ? [p.pageId] : [], { proposals: true });
    return p;
  }
}
