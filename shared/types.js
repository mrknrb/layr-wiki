// Page types: what kind of thing a page is about (`type:` in its properties). The wiki starts with none: the user
// makes their own (the type editor, or an agent with wiki__define_type), kept as plugin data `type/<lowercase name>`:
// `{name, icon, color, description, fields: [{key, label, kind, options?, target?, multiple?, url?}], template}`.
// A type gives the info box its fields and labels, and a new page its properties and starting text (`template`,
// Markdown with the placeholders of templates.js). A page may name a type that isn't defined: it then shows with the
// default icon and its properties as they are.
//
// Field kinds: text, number, date (YYYY-MM-DD), checkbox, select (one of `options`), multiselect (a list, `options`
// suggested), link (`"[[Page]]"`, `target`: only pages of that type are suggested; `multiple`: a list of links), url,
// file (`"[[name.pdf]]"`, an attachment). `url` on a text field: a pattern with {} for the value, a link to a public
// database by a stable id ("https://doi.org/{}").
import { asList, keyOf, parseLink } from "./links.js";

export const KINDS = ["text", "number", "date", "checkbox", "select", "multiselect", "link", "url", "file"];
export const DEFAULT_TYPE_ICON = "file-text";
export const TYPE_PREFIX = "type/";
export const typeKey = (name) => `${TYPE_PREFIX}${keyOf(name)}`;

const NAME = /^[\p{L}][\p{L}\p{N} _-]{0,39}$/u;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|var\(--[\w-]+\)|[a-z]{3,20})$/i;

/** Wiki 0.1's field kinds → 0.2's (0.1 records keep working): list → multiselect, links → link (multiple). */
function oldKind(f) {
  if (KINDS.includes(f.kind)) return { kind: f.kind };
  if (f.kind === "list") return { kind: "multiselect" };
  if (f.kind === "links") return { kind: "link", multiple: true };
  if (!f.kind && Array.isArray(f.options) && f.options.length) return { kind: "select" };
  return { kind: "text" };
}

/** A stored type (0.1 or 0.2) → the 0.2 shape, filled in; never throws (for loading). */
export function normalizeType(raw) {
  if (!raw?.name) return null;
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .filter((f) => f && f.key)
    .map((f) => ({
      key: String(f.key),
      label: String(f.label ?? String(f.key).replace(/_/g, " ")),
      ...oldKind(f),
      ...(f.multiple ? { multiple: true } : {}),
      ...(Array.isArray(f.options) ? { options: f.options.map(String) } : {}),
      ...(f.target ? { target: String(f.target) } : {}),
      ...(f.url ? { url: String(f.url) } : {}),
    }));
  // 0.1 types had `sections` (headings a new page starts with) instead of a template.
  const template = typeof raw.template === "string" ? raw.template
    : (Array.isArray(raw.sections) ? raw.sections.map((s) => `## ${s}\n\n`).join("").replace(/\n+$/, "\n") : "");
  return {
    name: String(raw.name),
    icon: raw.icon ? String(raw.icon) : DEFAULT_TYPE_ICON,
    color: raw.color ? String(raw.color) : "",
    description: raw.description ? String(raw.description) : "",
    fields,
    template,
  };
}

/** A field as the user or an agent gave it → a checked field, or an error that says what is wrong. */
export function cleanField(f) {
  const key = String(f?.key ?? "").trim();
  if (!KEY.test(key)) throw new Error(`A field key: a lowercase letter, then lowercase letters, digits, _ ("${key}")`);
  if (["type", "aliases", "tags"].includes(key)) throw new Error(`"${key}" is a property every page has: not a field`);
  let kind = f.kind ?? "text";
  let multiple = Boolean(f.multiple);
  if (!KINDS.includes(kind)) {
    if (kind === "list") kind = "multiselect";
    else if (kind === "links") [kind, multiple] = ["link", true];
    else throw new Error(`Field ${key}: kind is one of ${KINDS.join(", ")} (not "${kind}")`);
  }
  const options = Array.isArray(f.options)
    ? [...new Set(f.options.map((o) => String(o).trim()).filter(Boolean))]
    : null;
  if (kind === "select" && !options?.length) throw new Error(`Field ${key}: a select field needs options`);
  return {
    key,
    label: String(f.label ?? "").trim() || key.replace(/_/g, " "),
    kind,
    ...(kind === "link" && multiple ? { multiple: true } : {}),
    ...(options && (kind === "select" || kind === "multiselect") ? { options } : {}),
    ...(kind === "link" && f.target ? { target: String(f.target).trim() } : {}),
    ...(f.url && kind === "text" ? { url: String(f.url) } : {}),
  };
}

/** A type as the user or an agent gave it → a checked type (the stored shape), or an error. */
export function cleanType(type) {
  const name = String(type?.name ?? "").trim();
  if (!NAME.test(name)) throw new Error("A type's name: a letter, then up to 39 letters, digits, spaces, _ or -");
  const icon = String(type.icon ?? "").trim();
  if (icon.length > 40) throw new Error("A type's icon: an emoji or a Lucide icon name");
  const color = String(type.color ?? "").trim();
  if (color && !COLOR.test(color)) {
    throw new Error(`A type's colour: #hex, rgb(), var(--name) or a colour word ("${color}")`);
  }
  const fields = (Array.isArray(type.fields) ? type.fields : []).map(cleanField);
  const keys = new Set();
  for (const f of fields) {
    if (keys.has(f.key)) throw new Error(`The field ${f.key} is there twice`);
    keys.add(f.key);
  }
  let template = typeof type.template === "string" ? type.template : "";
  if (!template && Array.isArray(type.sections)) template = type.sections.map((s) => `## ${s}\n\n`).join("");
  return {
    name,
    icon: icon || DEFAULT_TYPE_ICON,
    color,
    description: String(type.description ?? "").trim(),
    fields,
    template: template.replace(/\n+$/, template ? "\n" : ""),
  };
}

/** The type of this name (any case) from `types`, or null. */
export const findType = (types, name) =>
  name ? types.find((t) => keyOf(t.name) === keyOf(name)) ?? null : null;

/** The empty value a new page's field starts with. */
export const emptyValue = (field) =>
  field.kind === "multiselect" || (field.kind === "link" && field.multiple) ? [] : null;

/** A new page's Markdown for `type`: its type, its fields empty, then its template (not yet filled in). */
export function templateFor(type, { stringify }) {
  if (!type) return "";
  const props = { type: type.name };
  for (const f of type.fields ?? []) props[f.key] = emptyValue(f);
  const body = String(type.template ?? "").replace(/^\n+/, "");
  return `---\n${stringify(props)}\n---\n\n${body}`.replace(/\n+$/, "\n");
}

// ---------- field values (for the info box, the properties editor and database views) ----------

/** `"[[Target|label]]"`, `"![[x]]"` or plain text → the target. */
function targetOf(v) {
  const m = /^\s*!?\[\[([^\[\]\n]+)\]\]\s*$/.exec(String(v));
  return m ? parseLink(m[1]).target : String(v).trim();
}

const TRUE = /^(true|yes|y|1|on|x|✓|checked)$/i;

/**
 * A page's value of `field`, by its kind: text/select/url/date → string or null; number → number or null;
 * checkbox → boolean; multiselect → [strings]; link/file → the target title or file name (a list when `multiple`,
 * or when the page holds a list).
 */
export function fieldValue(page, field) {
  const raw = (page?.props ?? page ?? {})[field.key];
  const empty = raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && !raw.length);
  switch (field.kind) {
    case "number": {
      if (empty) return null;
      const n = Number(Array.isArray(raw) ? raw[0] : raw);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return empty ? false : raw === true || TRUE.test(String(Array.isArray(raw) ? raw[0] : raw));
    case "multiselect":
      return asList(raw).map((s) => s.trim()).filter(Boolean);
    case "link":
    case "file": {
      if (empty) return field.multiple ? [] : null;
      if (Array.isArray(raw) || field.multiple) return asList(raw).map(targetOf).filter(Boolean);
      return targetOf(raw) || null;
    }
    case "date": {
      if (empty) return null;
      const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, s.length > 10 && s[10] === "T" ? 16 : 10) : s;
    }
    default:
      if (empty) return null;
      return Array.isArray(raw) ? asList(raw).join(", ") : String(raw);
  }
}

/** A field's value (fieldValue's) as text for people and for an input box ("" when empty). */
export function formatField(value, field = { kind: "text" }) {
  if (value === null || value === undefined) return "";
  if (field.kind === "checkbox") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * What the user typed into a field of this kind → the property value to store (null: remove it). Errors say what is
 * wrong (a number that isn't, a date not YYYY-MM-DD). `field` gives `multiple` for links.
 */
export function parseFieldInput(kind, text, field = {}) {
  if (kind === "checkbox") return typeof text === "boolean" ? text : TRUE.test(String(text ?? "").trim());
  const s = Array.isArray(text) ? text.join(", ") : String(text ?? "").trim();
  if (!s) return kind === "multiselect" || (kind === "link" && field.multiple) ? [] : null;
  const split = () => s.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  switch (kind) {
    case "number": {
      const n = Number(s.replace(/\s/g, "").replace(/,(?=\d+$)/, "."));
      if (!Number.isFinite(n)) throw new Error(`Not a number: ${s}`);
      return n;
    }
    case "date": {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(s);
      if (!m) throw new Error(`A date as YYYY-MM-DD: ${s}`);
      const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      return m[4] ? `${date}T${m[4].padStart(2, "0")}:${m[5]}` : date;
    }
    case "multiselect":
      return split();
    case "link": {
      const link = (t) => `[[${targetOf(t)}]]`;
      return field.multiple ? split().map(link) : link(s);
    }
    case "file":
      return `[[${targetOf(s)}]]`;
    default:
      return s;
  }
}
