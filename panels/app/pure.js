// The shell's pure logic (no DOM): fuzzy matching, search queries, the folder and tag trees, keys, saved tabs.
// test/shell.test.js covers it.

const lower = (s) => String(s ?? "").toLowerCase();
const keyOf = (s) => lower(s).trim();

// ---------- fuzzy matching (quick switcher, command palette) ----------

/**
 * How well `query` matches `text`, its letters in order: `{score, hits: [indexes]}` or null. Whole words, word
 * starts and runs of letters score higher, so "wb" finds "Western blot" before "Swab".
 */
export function fuzzy(query, text) {
  const q = lower(query).replace(/\s+/g, "");
  const t = lower(text);
  if (!q) return { score: 0, hits: [] };
  const direct = t.indexOf(lower(query).trim());
  if (direct >= 0) {
    const n = lower(query).trim().length;
    const atStart = direct === 0 ? 40 : /[\s/_\-.(]/.test(t[direct - 1]) ? 25 : 0;
    return { score: 100 + atStart + (n === t.length ? 50 : 0) - t.length * 0.1,
      hits: Array.from({ length: n }, (_, i) => direct + i) };
  }
  const hits = [];
  let score = 0;
  let last = -2;
  let ti = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s/_\-.(]/.test(t[at - 1]);
    score += at === last + 1 ? 6 : wordStart ? 8 : 1;
    hits.push(at);
    last = at;
    ti = at + 1;
  }
  return { score: score - t.length * 0.1, hits };
}

/** `items` (anything) ranked by `fuzzy` over `names(item)` (several names: the best counts), best first. */
export function rank(query, items, names, limit = 50) {
  const out = [];
  for (const item of items) {
    let best = null;
    for (const [i, name] of names(item).entries()) {
      const m = fuzzy(query, name);
      if (m && (!best || m.score - i * 2 > best.score)) best = { ...m, score: m.score - i * 2, name, nameIndex: i };
    }
    if (best) out.push({ item, ...best });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- search queries ----------

/**
 * A search box's text → `{words, tags, types, folders, notTags}`: `#tag`, `tag:x`, `type:x`, `folder:x` (quotes
 * for spaces: `folder:"My notes"`), `-#tag` leaves a tag out; the rest are words.
 */
export function parseQuery(text) {
  const out = { words: [], tags: [], notTags: [], types: [], folders: [] };
  const re = /(-?)(?:(tag|type|folder|path):)?("([^"]*)"|\S+)/gi;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const neg = m[1] === "-";
    const field = lower(m[2] ?? "");
    let value = m[4] ?? m[3];
    if (!field && value.startsWith("#") && value.length > 1) {
      (neg ? out.notTags : out.tags).push(value.slice(1));
      continue;
    }
    if (field === "tag") (neg ? out.notTags : out.tags).push(value.replace(/^#/, ""));
    else if (field === "type") out.types.push(value);
    else if (field === "folder" || field === "path") out.folders.push(value.replace(/^\/+|\/+$/g, ""));
    else {
      if (neg) value = `-${value}`;
      if (value) out.words.push(value);
    }
  }
  return out;
}

/** A page's tags hold `tag` itself or a tag under it (`#a` matches `#a/b`). */
export const hasTag = (tags, tag) => {
  const k = keyOf(tag).replace(/^#/, "");
  return (tags ?? []).some((t) => keyOf(t) === k || keyOf(t).startsWith(`${k}/`));
};

/** A page is in `folder` or a folder under it (`""`: everywhere). */
export const inFolder = (pageFolder, folder) => {
  const f = keyOf(folder);
  const p = keyOf(pageFolder ?? "");
  return !f || p === f || p.startsWith(`${f}/`);
};

/** Filter search results (`[{page}]`) by a parsed query's tags, types and folders. */
export function filterResults(rows, q) {
  return rows.filter(({ page }) =>
    q.tags.every((t) => hasTag(page.tags, t)) &&
    !q.notTags.some((t) => hasTag(page.tags, t)) &&
    (!q.types.length || q.types.some((t) => keyOf(page.type) === keyOf(t))) &&
    (!q.folders.length || q.folders.some((f) => inFolder(page.folder, f))));
}

/** The snippet with the words marked: HTML (escaped). */
export function markWords(text, words, escape) {
  const html = escape(String(text ?? ""));
  const ws = [...new Set(words.map((w) => escape(lower(w))).filter((w) => w.length > 1))];
  if (!ws.length) return html;
  const re = new RegExp(`(${ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return html.replace(/(<[^>]*>)|([^<]+)/g, (all, tag, txt) => tag ?? txt.replace(re, "<mark>$1</mark>"));
}

// ---------- folders ----------

/** Every folder path: the given ones and their parents, and every page's folder and its parents; sorted. */
export function allFolders(pages, folders = []) {
  const set = new Map();
  const add = (path) => {
    const parts = String(path ?? "").split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!set.has(keyOf(p))) set.set(keyOf(p), p);
    }
  };
  for (const f of folders) add(f);
  for (const p of pages) add(p.folder);
  return [...set.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

export const SORTS = {
  "name": { label: "Name (A to Z)", cmp: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) },
  "name-desc": { label: "Name (Z to A)", cmp: (a, b) => b.title.localeCompare(a.title, undefined, { numeric: true }) },
  "modified": { label: "Edited (newest first)", cmp: (a, b) => b.updated - a.updated },
  "modified-asc": { label: "Edited (oldest first)", cmp: (a, b) => a.updated - b.updated },
  "created": { label: "Created (newest first)", cmp: (a, b) => b.created - a.created },
  "created-asc": { label: "Created (oldest first)", cmp: (a, b) => a.created - b.created },
};

/**
 * The file tree: `{path: "", name: "", folders: [node], pages: [page]}`; folders by name (always first), pages by
 * `sort` (a SORTS key). Folder names compare without case, as titles do.
 */
export function buildTree(pages, folders = [], sort = "name") {
  const root = { path: "", name: "", folders: [], pages: [] };
  const byPath = new Map([["", root]]);
  for (const path of allFolders(pages, folders)) {
    const parts = path.split("/");
    const parent = byPath.get(keyOf(parts.slice(0, -1).join("/"))) ?? root;
    const node = { path, name: parts[parts.length - 1], folders: [], pages: [] };
    parent.folders.push(node);
    byPath.set(keyOf(path), node);
  }
  for (const p of pages) (byPath.get(keyOf(p.folder ?? "")) ?? root).pages.push(p);
  const cmp = (SORTS[sort] ?? SORTS.name).cmp;
  const order = (node) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    if (sort === "name-desc") node.folders.reverse();
    node.pages.sort(cmp);
    node.count = node.pages.length;
    for (const f of node.folders) node.count += order(f);
    return node.count;
  };
  order(root);
  return root;
}

/** `path` and every folder above it: "a/b/c" → ["a", "a/b", "a/b/c"]. */
export const folderChain = (path) => {
  const parts = String(path ?? "").split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** Moving folder `from` into `into` gives this path; null when it can't (into itself or under itself). */
export function movedFolderPath(from, into) {
  const name = String(from).split("/").pop();
  const target = into ? `${into}/${name}` : name;
  if (keyOf(into) === keyOf(from) || keyOf(into).startsWith(`${keyOf(from)}/`)) return null;
  if (keyOf(target) === keyOf(from)) return null;
  return target;
}

// ---------- tags ----------

/** Nested tags `#a/b` as a tree: `[{name, tag, count (pages with it or a tag under it), children}]`, by name. */
export function tagTree(pages) {
  const root = { children: new Map() };
  for (const p of pages) {
    const seen = new Set();
    for (const t of p.tags ?? []) {
      const parts = String(t).split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const tag = parts.slice(0, i + 1).join("/");
        const k = keyOf(parts[i]);
        if (!node.children.has(k)) node.children.set(k, { name: parts[i], tag, count: 0, children: new Map() });
        node = node.children.get(k);
        if (!seen.has(keyOf(tag))) {
          seen.add(keyOf(tag));
          node.count += 1;
        }
      }
    }
  }
  const out = (node) => [...node.children.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
    .map((n) => ({ name: n.name, tag: n.tag, count: n.count, children: out(n) }));
  return out(root);
}

// ---------- keys ----------

const CODE_KEYS = { Backslash: "\\", Slash: "/", Comma: ",", Period: ".", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", IntlBackslash: "\\" };

/** A keydown event (or a like object) → "ctrl+shift+k" (null for a lone modifier). Letters and digits by position. */
export function keyFromEvent(e) {
  let k = e.key ?? "";
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified", ""].includes(k)) return null;
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) k = code.slice(3);
  else if (/^Digit\d$/.test(code)) k = code.slice(5);
  else if (CODE_KEYS[code] && (e.ctrlKey || e.metaKey || e.altKey)) k = CODE_KEYS[code];
  else if (k === " ") k = "space";
  k = lower(k);
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  return [...mods, k].join("+");
}

/** "ctrl+shift+k" in the one order keyFromEvent writes (so user text compares). */
export function normalizeKey(key) {
  if (!key) return "";
  const parts = lower(key).replace(/\s+/g, "").split("+");
  let last = parts.pop();
  if (last === "" && parts[parts.length - 1] === "") {
    parts.pop();
    last = "+";
  }
  const mods = new Set(parts.map((p) => (p === "cmd" || p === "meta" || p === "mod" ? "ctrl" : p)));
  return [...["ctrl", "alt", "shift"].filter((m) => mods.has(m)), last].join("+");
}

const KEY_LABELS = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", escape: "Esc", "\\": "\\",
  space: "Space", enter: "Enter", tab: "Tab", backspace: "Backspace", delete: "Del" };

/** "ctrl+shift+k" → "Ctrl+Shift+K". */
export function keyLabel(key) {
  if (!key) return "";
  return normalizeKey(key).split("+").map((p) => KEY_LABELS[p] ?? (p.length === 1 ? p.toUpperCase()
    : p[0].toUpperCase() + p.slice(1))).join("+");
}

/** The key each command has: the user's (`""`: none) or its own. `{key → [ids]}` shows clashes too. */
export function effectiveKeys(commands, overrides = {}) {
  const byId = new Map();
  const byKey = new Map();
  for (const c of commands) {
    const own = Object.prototype.hasOwnProperty.call(overrides ?? {}, c.id) ? overrides[c.id] : c.key;
    const key = normalizeKey(own ?? "");
    byId.set(c.id, key);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), c.id]);
  }
  return { byId, byKey };
}

// ---------- tabs ----------

/** A route as a short text that tells two routes apart (the tab bar and history skip duplicates). */
export const routeKey = (r) => {
  if (!r) return "";
  const { view, ...rest } = r;
  delete rest.mode;
  delete rest.heading;
  const keys = Object.keys(rest).sort();
  return `${view}|${keys.map((k) => `${k}=${typeof rest[k] === "object" ?
    JSON.stringify(rest[k]) : rest[k]}`).join("&")}`;
};

const cleanRoute = (r) => (r && typeof r === "object" && typeof r.view === "string" ? r : null);

/**
 * Saved panel state → `{tabs: [{route, back, fwd}], active}`; 0.1's `{page, view, mode}` becomes one tab. Broken
 * parts are dropped, at most `max` tabs and `depth` history steps each.
 */
export function restoreTabs(saved, { max = 30, depth = 30 } = {}) {
  const s = saved && typeof saved === "object" ? saved : {};
  let tabs = [];
  if (Array.isArray(s.tabs)) {
    tabs = s.tabs.map((t) => {
      const route = cleanRoute(t?.route);
      if (!route) return null;
      const list = (a) => (Array.isArray(a) ? a.map(cleanRoute).filter(Boolean).slice(-depth) : []);
      return { route, back: list(t.back), fwd: list(t.fwd), pinned: Boolean(t.pinned) };
    }).filter(Boolean).slice(0, max);
  } else if (s.page) {
    tabs = [{ route: { view: "page", id: s.page, mode: s.mode === "edit" ? "edit" : undefined }, back: [], fwd: [] }];
  } else if (s.view === "trash") {
    tabs = [{ route: { view: "trash" }, back: [], fwd: [] }];
  }
  const active = Math.min(Math.max(0, Number.isInteger(s.active) ? s.active : 0), Math.max(0, tabs.length - 1));
  return { tabs, active };
}

/** A quick note's title: "Note 2026-11-18 14.05" (titles can't hold ":"); a number is added when it is taken. */
export function quickNoteTitle(date, taken = () => false) {
  const pad = (n) => String(n).padStart(2, "0");
  const base = `Note ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}.${pad(date.getMinutes())}`;
  let title = base;
  for (let i = 2; taken(title); i++) title = `${base} (${i})`;
  return title;
}
