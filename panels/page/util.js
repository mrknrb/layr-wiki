// Small things the page part's files share: icons of types, who changed a page, attachments as addresses (cached),
// the active page view (the outline follows its scrolling), the code highlighter, and the stylesheet.
import { MIGRATION_HINT } from "../../shared/files.js";
import { keyOf } from "../../shared/links.js";
import { el, icon } from "../app/dom.js";

export { narrow } from "../app/dom.js";

/** The page view on screen (set by view.js): `{id, mode, scroller, body, editor}`; sidebar panels follow it. */
export const active = { view: null };
export const bus = new EventTarget();
export const announce = (type, detail = null) => bus.dispatchEvent(new CustomEvent(type, { detail }));

/** A type's icon: an emoji as text, a Lucide name as the icon. */
export function typeIcon(app, typeName, cls = "") {
  const type = typeName ? safe(() => app.wiki.type(typeName)) : null;
  const name = type?.icon || (typeName ? "file-text" : "file");
  const node = /^[a-z0-9-]+$/.test(name) ? icon(name, cls) : el("span", { class: `icon emoji ${cls}`.trim() }, name);
  if (type?.color) node.style.color = type.color;
  return node;
}

/** `node.replaceChildren` without the nulls (the DOM would show them as the text "null"). */
export const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined &&
  k !== false));

export const whoText = (r) =>
  r?.by === "ai" ? "AI" : r?.by === "you" || !r?.by ? "you" : String(r.by).replace(/^plugin:/, "");

export const pageUrl = (title) => `layr://wiki/page/${encodeURIComponent(title)}`;

export function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const shortError = (error) => {
  const text = error?.message ?? String(error);
  return text === MIGRATION_HINT ? "attachments need the database update" : text;
};

// ---------- attachments ----------

const urls = new Map();
const bytes = new Map();

/** The attachment's bytes (`{record, bytes}`), downloaded once per panel. */
export function fileBytes(app, name) {
  const key = keyOf(name);
  if (!bytes.has(key)) {
    const p = app.files.download(name);
    bytes.set(key, p);
    p.catch(() => bytes.delete(key));
  }
  return bytes.get(key);
}

/** A blob: address for the attachment (pictures), made once per panel. */
export function fileUrl(app, name) {
  const key = keyOf(name);
  if (!urls.has(key)) {
    const p = fileBytes(app, name).then(({ record, bytes: data }) =>
      URL.createObjectURL(new Blob([data], { type: record.mime || "application/octet-stream" })));
    urls.set(key, p);
    p.catch(() => urls.delete(key));
  }
  return urls.get(key);
}

/** Save the attachment to the user's downloads. */
export async function downloadFile(app, name) {
  const url = await fileUrl(app, name);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- the code highlighter (part A's bundle) ----------

let highlighter = null;
let highlighterLoad = null;

/** `highlight(code, lang) → html` once vendor/editor.js has loaded, else null (and it starts loading). */
export function highlightNow() {
  if (!highlighterLoad) loadHighlighter();
  return highlighter;
}

export function loadHighlighter() {
  highlighterLoad ??= import("../../vendor/editor.js")
    .then((m) => {
      highlighter = typeof m.highlight === "function" ? m.highlight : null;
      // Part A's stylesheet holds the token colours (tok-*) the reading view uses too.
      import("../editor/index.js").then((e) => e.ensureStyles?.()).catch(() => {});
      return highlighter;
    })
    .catch(() => null);
  return highlighterLoad;
}

// ---------- the stylesheet ----------

let cssDone = false;
export function loadCss() {
  if (cssDone) return;
  cssDone = true;
  document.head.append(el("link", { rel: "stylesheet", href: new URL("./page.css", import.meta.url).href }));
}

/** Seen "Changed by AI" banners (OK pressed): this screen's memory only. */
const SEEN_KEY = "wiki.seenAi";
const seen = new Set(safe(() => JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"), []));
export const aiSeen = (page) => seen.has(`${page.id}@${page.updated}`);
export function markAiSeen(page) {
  seen.add(`${page.id}@${page.updated}`);
  safe(() => localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300))));
}
