// Database views: a saved question over the pages ("every Paper in Projects/Thesis not read yet, newest first") shown
// as a table, board, gallery, calendar or list. Pure, for the panel and the backend (the `query` tool); tested in
// test/views.test.js.
//
// A view is plugin data `view/<id>` = {id, name, icon, source: {folder?, type?, tag?, query?}, filters: [{field, op,
// value}], sort: [{field, dir}], layout: "table"|"board"|"gallery"|"calendar"|"list", columns: [field], widths:
// {field: px}, groupBy, dateField, coverField}.
//
// Fields: the built-in ones (title, folder, type, tags, created, updated, links, backlinks) and every property, by its
// key. A property whose key is a built-in one's (a `created:` line, common in Obsidian vaults) is `prop:created`.
// Filter ops: is, isNot, contains, notContains, empty, notEmpty, gt, lt, before, after, within (the last N days);
// the spellings people and agents write ("=", "is not", ">", "within last") are understood too.
import { asList, keyOf, propertyLink } from "./links.js";

export const VIEW_PREFIX = "view/";
export const LAYOUTS = ["table", "board", "gallery", "calendar", "list"];
const DAY = 24 * 60 * 60 * 1000;

export const BUILT_IN_FIELDS = [
  { key: "title", label: "Title", kind: "title", builtIn: true },
  { key: "folder", label: "Folder", kind: "folder", builtIn: true },
  { key: "type", label: "Type", kind: "type", builtIn: true },
  { key: "tags", label: "Tags", kind: "tags", builtIn: true },
  { key: "created", label: "Created", kind: "datetime", builtIn: true },
  { key: "updated", label: "Updated", kind: "datetime", builtIn: true },
  { key: "links", label: "Links", kind: "count", builtIn: true },
  { key: "backlinks", label: "Backlinks", kind: "count", builtIn: true },
];
const BUILT_IN = new Map(BUILT_IN_FIELDS.map((f) => [f.key, f]));

export const OPS = [
  { op: "is", label: "is" },
  { op: "isNot", label: "is not" },
  { op: "contains", label: "contains" },
  { op: "notContains", label: "does not contain" },
  { op: "empty", label: "is empty", noValue: true },
  { op: "notEmpty", label: "is not empty", noValue: true },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
  { op: "before", label: "before" },
  { op: "after", label: "after" },
  { op: "within", label: "within the last … days" },
];
const OP_ALIASES = {
  "=": "is", "==": "is", eq: "is", equals: "is", "!=": "isNot", "<>": "isNot", "is not": "isNot", isnot: "isNot",
  not: "isNot", ne: "isNot", has: "contains", includes: "contains", "not contains": "notContains",
  "does not contain": "notContains", notcontains: "notContains", "is empty": "empty", "not empty": "notEmpty",
  "is not empty": "notEmpty", notempty: "notEmpty", ">": "gt", "<": "lt", ">=": "gt", "<=": "lt", "within last": "within",
  "within the last": "within", last: "within",
};
export const normalizeOp = (op) => {
  const raw = String(op ?? "is").trim();
  if (OPS.some((o) => o.op === raw)) return raw;
  return OP_ALIASES[raw.toLowerCase()] ?? OPS.find((o) => o.op.toLowerCase() === raw.toLowerCase())?.op ?? "is";
};

/** Which ops make sense for a field of this kind (the filter editor offers these). */
export function opsFor(kind) {
  const k = kindClass(kind);
  if (k === "date") return ["is", "isNot", "before", "after", "within", "empty", "notEmpty"];
  if (k === "number") return ["is", "isNot", "gt", "lt", "empty", "notEmpty"];
  if (k === "bool") return ["is", "isNot"];
  if (k === "list") return ["contains", "notContains", "is", "isNot", "empty", "notEmpty"];
  return ["is", "isNot", "contains", "notContains", "empty", "notEmpty"];
}

/** The family a kind compares as: list, number, date, bool or text. */
export function kindClass(kind) {
  if (["tags", "multiselect", "links", "list"].includes(kind)) return "list";
  if (kind === "number" || kind === "count") return "number";
  if (kind === "date" || kind === "datetime") return "date";
  if (kind === "checkbox") return "bool";
  return "text";
}

// ---------- dates ----------

const pad = (n) => String(n).padStart(2, "0");
/** A time (ms or Date) as its local day "YYYY-MM-DD". */
export const dayKey = (t) => {
  const d = t instanceof Date ? t : new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** "YYYY-MM-DD" (also with a time after it) → local midnight in ms, else null. */
export function parseDay(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text ?? "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
/** A value as a time in ms: numbers are ms already, text is a date. */
export function timeOf(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  const day = parseDay(v);
  if (day !== null) return day;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}
/** A filter's date operand: "today", "yesterday", "tomorrow", "+7" / "-7" (days from today), or a date. */
export function operandDay(value, now = Date.now()) {
  const s = String(value ?? "").trim().toLowerCase();
  const today = parseDay(dayKey(now));
  if (s === "today" || s === "") return today;
  if (s === "yesterday") return today - DAY;
  if (s === "tomorrow") return today + DAY;
  const rel = /^([+-]\d+)\s*d?$/.exec(s);
  if (rel) return parseDay(dayKey(today + Number(rel[1]) * DAY + DAY / 2));
  const t = timeOf(value);
  return t === null ? null : parseDay(dayKey(t));
}

// ---------- fields ----------

/** A property key or a built-in field's name → `{prop: key}` or `{builtIn: key}`. */
function splitField(field) {
  const f = String(field ?? "");
  if (f.startsWith("prop:")) return { prop: f.slice(5) };
  if (BUILT_IN.has(f)) return { builtIn: f };
  return { prop: f };
}

/** The value of `field` on `page` (a parsed page): text, numbers (ms for created/updated), lists, or null. */
export function valueOf(wiki, page, field) {
  const { prop, builtIn } = splitField(field);
  if (builtIn === "title") return page.title;
  if (builtIn === "folder") return page.folder ?? "";
  if (builtIn === "type") return page.type ?? null;
  if (builtIn === "tags") return page.tags ?? [];
  if (builtIn === "created") return page.created || null;
  if (builtIn === "updated") return page.updated || null;
  if (builtIn === "links") return page.links?.length ?? 0;
  if (builtIn === "backlinks") return wiki.backlinks?.(page.id)?.length ?? 0;
  const v = page.props?.[prop];
  return v === undefined ? null : v;
}

/** A property's kind guessed from the values pages hold. */
export function inferKind(values) {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (!vs.length) return "text";
  if (vs.some(Array.isArray)) return "multiselect";
  if (vs.every((v) => typeof v === "boolean")) return "checkbox";
  if (vs.every((v) => typeof v === "number")) return "number";
  if (vs.every((v) => /^\d{4}-\d{2}-\d{2}(\b|T)/.test(String(v)))) return "date";
  if (vs.every((v) => propertyLink(v))) return "link";
  if (vs.every((v) => /^https?:\/\//i.test(String(v)))) return "url";
  return "text";
}

/** A type's field in the shape the views use (old kinds `links`/`list` and option lists without a kind mapped). */
function fromTypeField(f, typeName) {
  let kind = f.kind ?? (Array.isArray(f.options) && f.options.length ? "select" : "text");
  if (kind === "list") kind = "multiselect";
  if (kind === "link" && f.multiple) kind = "links";
  return { key: f.key, label: f.label ?? f.key, kind, options: f.options ?? null, target: f.target ?? null, typeName };
}

/**
 * Every field the views can show for these pages: the built-in ones, then each property key (with its kind from the
 * user's types, preferring `typeName`'s, else guessed from the values). `[{key, label, kind, options?, target?}]`.
 */
export function fieldsOf(wiki, pages, { typeName = null } = {}) {
  const types = wiki.types?.() ?? [];
  const fromTypes = new Map();
  const preferred = typeName ? types.find((t) => keyOf(t.name) === keyOf(typeName)) : null;
  for (const t of [preferred, ...types].filter(Boolean)) {
    for (const f of t.fields ?? []) if (f?.key && !fromTypes.has(f.key)) fromTypes.set(f.key, fromTypeField(f, t.name));
  }
  const values = new Map();
  for (const p of pages) {
    for (const [k, v] of Object.entries(p.props ?? {})) {
      if (["type", "tags", "aliases"].includes(k)) continue;
      if (!values.has(k)) values.set(k, []);
      values.get(k).push(v);
    }
  }
  const out = [...BUILT_IN_FIELDS];
  const keys = [...new Set([...(preferred?.fields ?? []).map((f) => f.key), ...values.keys(),
    ...[...fromTypes.keys()].filter((k) => !preferred || fromTypes.get(k).typeName === preferred.name)])];
  for (const k of keys) {
    if (!k) continue;
    const key = BUILT_IN.has(k) ? `prop:${k}` : k;
    const typed = fromTypes.get(k);
    if (typed) out.push({ ...typed, key, label: BUILT_IN.has(k) ? `${typed.label} (property)` : typed.label });
    else out.push({ key, label: BUILT_IN.has(k) ? `${k} (property)` : k.replace(/_/g, " "), kind: inferKind(values.get(k) ?? []) });
  }
  return out;
}

/** The field `key` from `fields` (fieldsOf), or a text field of that name. */
export const fieldInfo = (fields, key) =>
  fields.find((f) => f.key === key) ?? BUILT_IN.get(key) ?? { key, label: String(key).replace(/^prop:/, ""), kind: "text" };

// ---------- values ----------

const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
/** A value as plain text: lists joined, `[[Page|label]]` as Page. */
export function textOf(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(textOf).join(", ");
  const link = propertyLink(v);
  return link ?? String(v);
}
const truthy = (v) => v === true || ["true", "yes", "1", "x", "on", "checked"].includes(String(v).trim().toLowerCase());
const numberOf = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

/** Does `value` (of a field of `kind`) pass `op value`? `now` for the relative date ops. */
export function matches(kind, value, op, operand, now = Date.now()) {
  const o = normalizeOp(op);
  if (o === "empty") return isEmpty(value);
  if (o === "notEmpty") return !isEmpty(value);
  const k = kindClass(kind);
  const want = keyOf(textOf(operand));
  if (k === "list") {
    const items = asList(value).map((x) => keyOf(textOf(x)));
    if (o === "is") return items.includes(want);
    if (o === "isNot") return !items.includes(want);
    if (o === "contains") return items.some((x) => x.includes(want));
    if (o === "notContains") return !items.some((x) => x.includes(want));
    return false;
  }
  if (k === "bool") {
    const yes = truthy(value);
    if (o === "is") return yes === truthy(operand);
    if (o === "isNot") return yes !== truthy(operand);
    return false;
  }
  if (k === "date") {
    const t = timeOf(value);
    if (o === "contains" || o === "notContains") {
      const has = t !== null && dayKey(t).includes(String(operand ?? "").trim());
      return o === "contains" ? has : !has;
    }
    if (t === null) return o === "isNot";
    const day = parseDay(dayKey(t));
    if (o === "within") {
      const n = Number(operand);
      if (!Number.isFinite(n)) return false;
      const today = parseDay(dayKey(now));
      return day <= today && day >= today - Math.round(n) * DAY;
    }
    const at = operandDay(operand, now);
    if (at === null) return false;
    if (o === "is") return day === at;
    if (o === "isNot") return day !== at;
    if (o === "before" || o === "lt") return day < at;
    if (o === "after" || o === "gt") return day > at;
    return false;
  }
  if (k === "number") {
    const n = numberOf(value);
    const m = numberOf(operand);
    if (o === "contains") return textOf(value).toLowerCase().includes(want);
    if (o === "notContains") return !textOf(value).toLowerCase().includes(want);
    if (n === null || m === null) return o === "isNot";
    if (o === "is") return n === m;
    if (o === "isNot") return n !== m;
    if (o === "gt" || o === "after") return n > m;
    if (o === "lt" || o === "before") return n < m;
    return false;
  }
  const text = keyOf(textOf(value));
  if (o === "is") return text === want;
  if (o === "isNot") return text !== want;
  if (o === "contains") return text.includes(want);
  if (o === "notContains") return !text.includes(want);
  if (o === "gt" || o === "lt" || o === "before" || o === "after") {
    if (isEmpty(value)) return false;
    const a = numberOf(value);
    const b = numberOf(operand);
    const c = a !== null && b !== null ? a - b : text.localeCompare(want, undefined, { numeric: true });
    return o === "gt" || o === "after" ? c > 0 : c < 0;
  }
  return false;
}

/** Compare two values of a field of `kind` for sorting (empty ones are left to the caller). */
export function compareValues(kind, a, b) {
  const k = kindClass(kind);
  if (k === "number") return (numberOf(a) ?? 0) - (numberOf(b) ?? 0);
  if (k === "date") return (timeOf(a) ?? 0) - (timeOf(b) ?? 0);
  if (k === "bool") return Number(truthy(a)) - Number(truthy(b));
  const x = k === "list" ? textOf(asList(a)[0] ?? "") : textOf(a);
  const y = k === "list" ? textOf(asList(b)[0] ?? "") : textOf(b);
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
}

// ---------- running a view ----------

/** A folder path as the model writes it ("" is the top). */
const cleanFolder = (f) => String(f ?? "").trim().replace(/^\/+|\/+$/g, "");
/** Is `page` in `folder` or one of its subfolders? */
export const inFolder = (page, folder) => {
  const f = keyOf(cleanFolder(folder));
  const p = keyOf(page.folder ?? "");
  return !f || p === f || p.startsWith(`${f}/`);
};
/** Does the page have `tag` (or a tag nested under it: `#project` takes `#project/thesis`)? */
export const hasTag = (page, tag) => {
  const t = keyOf(String(tag ?? "").replace(/^#/, ""));
  return !t || (page.tags ?? []).some((x) => keyOf(x) === t || keyOf(x).startsWith(`${t}/`));
};

/** The pages a view's source takes (before its filters): all live pages narrowed by folder, type, tag and query. */
export function sourcePages(wiki, source = {}) {
  let pages = wiki.live();
  if (source.folder) pages = pages.filter((p) => inFolder(p, source.folder));
  if (source.type) pages = pages.filter((p) => keyOf(p.type) === keyOf(source.type));
  if (source.tag) pages = pages.filter((p) => hasTag(p, source.tag));
  if (String(source.query ?? "").trim()) {
    const ids = new Set(wiki.search(source.query, { limit: 1e9 }).map((r) => r.page.id));
    pages = pages.filter((p) => ids.has(p.id));
  }
  return pages;
}

/**
 * The rows of a view: its source's pages that pass every filter, sorted (by title when it gives no sort). `search`:
 * words the view's search box narrows the rows to (not saved). Gives the pages.
 */
export function runView(wiki, view, { now = Date.now(), search = "", fields = null } = {}) {
  let pages = sourcePages(wiki, view?.source ?? {});
  const all = fields ?? fieldsOf(wiki, pages, { typeName: view?.source?.type });
  for (const f of view?.filters ?? []) {
    if (!f?.field) continue;
    // A filter still waiting for its value (just added in the editor) takes nothing away yet.
    const op = normalizeOp(f.op);
    if (op !== "empty" && op !== "notEmpty" && (f.value === "" || f.value === null || f.value === undefined)) continue;
    const kind = fieldInfo(all, f.field).kind;
    pages = pages.filter((p) => matches(kind, valueOf(wiki, p, f.field), f.op, f.value, now));
  }
  const q = keyOf(search);
  if (q) pages = pages.filter((p) => keyOf(p.title).includes(q) || p.aliases?.some((a) => keyOf(a).includes(q)));
  return sortPages(wiki, pages, view?.sort?.length ? view.sort : [{ field: "title", dir: "asc" }], all);
}

/** Pages sorted by several fields in turn; empty values go last either way. */
export function sortPages(wiki, pages, sort, fields = []) {
  const keys = sort.filter((s) => s?.field).map((s) => ({ ...s, kind: fieldInfo(fields, s.field).kind,
    sign: String(s.dir ?? "asc").toLowerCase().startsWith("d") ? -1 : 1 }));
  const decorated = pages.map((p) => ({ p, v: keys.map((k) => valueOf(wiki, p, k.field)) }));
  decorated.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const x = a.v[i];
      const y = b.v[i];
      if (isEmpty(x) !== isEmpty(y)) return isEmpty(x) ? 1 : -1;
      if (isEmpty(x)) continue;
      const c = compareValues(keys[i].kind, x, y);
      if (c) return c * keys[i].sign;
    }
    return a.p.title.localeCompare(b.p.title);
  });
  return decorated.map((d) => d.p);
}

/**
 * The pages in groups by `field` (a board's columns): `[{value, label, pages}]`. Select fields and types give every
 * option a column (in their order, empty ones too); list fields put a page in each of its values; the pages without a
 * value come last (value null, label "No <field>").
 */
export function groupPages(wiki, pages, field, fields = []) {
  const info = fieldInfo(fields, field);
  const k = kindClass(info.kind);
  const groups = new Map();
  const add = (value, label) => {
    const key = value === null ? "\u0000none" : keyOf(value);
    if (!groups.has(key)) groups.set(key, { value, label: label ?? String(value), pages: [] });
    return groups.get(key);
  };
  if (info.kind === "type") for (const t of wiki.types?.() ?? []) add(t.name, t.name);
  for (const o of info.options ?? []) add(String(o), String(o));
  for (const p of pages) {
    const v = valueOf(wiki, p, field);
    if (info.kind === "folder") {
      add(v, v || "Top folder").pages.push(p);
      continue;
    }
    const items = k === "list" ? asList(v).map(textOf) : isEmpty(v) ? [] : [k === "date" ? dayKey(timeOf(v) ?? 0) : textOf(v)];
    if (!items.length) add(null, `No ${info.label.toLowerCase()}`).pages.push(p);
    for (const item of items) add(item, item).pages.push(p);
  }
  const none = groups.get("\u0000none");
  groups.delete("\u0000none");
  const out = [...groups.values()];
  if (!info.options?.length && info.kind !== "type") out.sort((a, b) => compareValues(info.kind, a.value, b.value));
  return none ? [...out, none] : info.kind === "folder" ? out : [...out, { value: null, label: `No ${info.label.toLowerCase()}`, pages: [] }];
}

/**
 * What moving a card from the group `from` to `to` (board) changes on the page: `{props: {key: value}}`,
 * `{folder}`, or null when the field can't be changed that way (counts, dates of the record, the title).
 */
export function moveChange(wiki, page, field, from, to, fields = []) {
  const info = fieldInfo(fields, field);
  const { prop, builtIn } = splitField(field);
  if (builtIn === "folder") return { folder: to ?? "" };
  if (builtIn === "type") return { props: { type: to ?? null } };
  if (builtIn && builtIn !== "tags") return null;
  const key = builtIn === "tags" ? "tags" : prop;
  if (kindClass(info.kind) === "list") {
    const current = asList(page.props?.[key]);
    const kept = current.filter((x) => from === null || keyOf(textOf(x)) !== keyOf(from));
    if (to !== null && !kept.some((x) => keyOf(textOf(x)) === keyOf(to))) kept.push(to);
    return { props: { [key]: kept.length ? kept : null } };
  }
  return { props: { [key]: to === null ? null : editValue(info, to) } };
}

/** What a cell editor's input means as a property value for a field of `info.kind` (null removes it). */
export function editValue(info, input) {
  const kind = info?.kind ?? "text";
  if (input === null || input === undefined) return null;
  if (kind === "checkbox") return truthy(input);
  if (Array.isArray(input)) return input.length ? input.map(String) : null;
  const s = String(input).trim();
  if (!s) return null;
  if (kind === "number") return numberOf(s) ?? s;
  if (kind === "date") return parseDay(s) !== null ? s.slice(0, 10) : s;
  const link = (x) => (propertyLink(x) ? x : `[[${x.replace(/^\[\[|\]\]$/g, "")}]]`);
  if (kind === "multiselect" || kind === "tags" || kind === "links" || kind === "list") {
    const items = s.split(",").map((x) => x.trim()).filter(Boolean);
    return items.length ? (kind === "links" ? items.map(link) : items) : null;
  }
  if (kind === "link" || kind === "file") return link(s);
  return s;
}

/** A value as the short text a cell, a card or the `query` tool shows. */
export function displayValue(info, value) {
  if (isEmpty(value)) return "";
  const kind = info?.kind ?? "text";
  if (kind === "datetime") return dayKey(value);
  if (kind === "checkbox") return truthy(value) ? "✓" : "";
  if (kind === "folder") return value || "";
  return textOf(value);
}

/** The day "YYYY-MM-DD" a page sits on in a calendar by `field` (created/updated or a date property), or null. */
export function dayOf(wiki, page, field) {
  const t = timeOf(valueOf(wiki, page, field || "created"));
  return t === null ? null : dayKey(t);
}

// ---------- the saved views ----------

/** A view with every part present and checked. */
export function normalizeView(v = {}) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const source = {};
  for (const k of ["folder", "type", "tag", "query"]) if (v.source?.[k]) source[k] = String(v.source[k]);
  return {
    id: String(v.id ?? newViewId()),
    name: String(v.name ?? "").trim() || "Untitled view",
    icon: v.icon ? String(v.icon) : "table",
    source,
    filters: list(v.filters).filter((f) => f?.field).map((f) => ({ field: String(f.field), op: normalizeOp(f.op),
      value: f.value === undefined || f.value === null ? "" : f.value })),
    sort: list(v.sort).filter((s) => s?.field).map((s) => ({ field: String(s.field),
      dir: String(s.dir ?? "asc").toLowerCase().startsWith("d") ? "desc" : "asc" })),
    layout: LAYOUTS.includes(v.layout) ? v.layout : "table",
    columns: list(v.columns).length ? list(v.columns).map(String) : ["title", "type", "folder", "updated"],
    widths: v.widths && typeof v.widths === "object" ? { ...v.widths } : {},
    groupBy: v.groupBy ? String(v.groupBy) : null,
    dateField: v.dateField ? String(v.dateField) : null,
    coverField: v.coverField ? String(v.coverField) : null,
    created: v.created ?? Date.now(),
  };
}

export const newViewId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Every saved view (adapter: the wiki's data adapter), A to Z. */
export async function listViews(adapter) {
  const rows = await adapter.dataList({ prefix: VIEW_PREFIX, limit: 1000 });
  return rows.map((r) => r.value).filter((v) => v?.id).map(normalizeView)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A saved view by its id, else by its name (any case), or null. */
export async function findView(adapter, idOrName) {
  const want = String(idOrName ?? "");
  const direct = want ? await adapter.dataGet(VIEW_PREFIX + want) : null;
  if (direct?.id) return normalizeView(direct);
  return (await listViews(adapter)).find((v) => keyOf(v.name) === keyOf(want)) ?? null;
}

/** Save a view (wiki: the Wiki, whose adapter stores it and announces the change). Gives the stored view. */
export async function saveView(wiki, view) {
  const v = normalizeView(view);
  await wiki.a.dataSet(VIEW_PREFIX + v.id, v);
  wiki.changed?.([], { views: true });
  return v;
}

export async function deleteView(wiki, id) {
  await wiki.a.dataDelete(VIEW_PREFIX + id);
  wiki.changed?.([], { views: true });
}

/** A source in words: "Folder Projects · Type Paper · #tag · “words”" (or "All pages"). */
export function describeSource(source = {}) {
  const parts = [];
  if (source.folder) parts.push(`Folder ${source.folder}`);
  if (source.type) parts.push(`Type ${source.type}`);
  if (source.tag) parts.push(`#${String(source.tag).replace(/^#/, "")}`);
  if (source.query) parts.push(`“${source.query}”`);
  return parts.join(" · ") || "All pages";
}

/** Rows as a Markdown table (the `query` tool's answer). */
export function tableText(wiki, pages, columns, fields, { limit = 200 } = {}) {
  const cols = columns.length ? columns : ["title"];
  const infos = cols.map((c) => fieldInfo(fields, c));
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [`| ${infos.map((i) => cell(i.label)).join(" | ")} |`, `| ${infos.map(() => "---").join(" | ")} |`];
  for (const p of pages.slice(0, limit)) {
    lines.push(`| ${infos.map((i) => (i.key === "title" ? `[[${p.title}]]` : cell(displayValue(i, valueOf(wiki, p, i.key)))))
      .join(" | ")} |`);
  }
  if (pages.length > limit) lines.push("", `(${pages.length - limit} more rows: raise limit)`);
  return lines.join("\n");
}
