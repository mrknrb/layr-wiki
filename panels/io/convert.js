// Pure pieces of the wiki's import, export and public links, used by the panel (panels/io) and the backend
// (backend/io-tools.js) alike: Notion export names and links → wiki pages, one self-contained HTML file from rendered
// pages, a Markdown zip (a small zip writer that stores, so it works on the phone too), and the shape of a public
// page. No DOM, no Node APIs (tested in test/io.test.js).
import { cleanFileName } from "../../shared/files.js";
import { cleanTitle, keyOf, slug } from "../../shared/links.js";
import { escapeHtml, isImageName } from "../../shared/markdown.js";

// ---------- bytes ----------

/** Bytes → base64 (in chunks, so a big file doesn't overflow the call stack). */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 (a data URL's too) → bytes. */
export function base64ToBytes(text) {
  const bin = atob(String(text ?? "").replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const dataUrl = (bytes, mime) => `data:${mime || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;

const utf8 = (s) => new TextEncoder().encode(String(s));

// ---------- a zip that stores (no compression) ----------

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * `[{name: "Folder/Page.md", data: Uint8Array | string}]` → the bytes of a .zip that stores them (UTF-8 names).
 * Markdown and pictures hardly shrink worth the code a deflater would add to the panel; any unzip tool reads it.
 */
export function zipStore(files, now = new Date()) {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const data = typeof f.data === "string" ? utf8(f.data) : f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A page's file path in an export or the folder copy: `Folder/Sub/Title.md`. */
export const pageFile = (page) => `${page.folder ? `${page.folder}/` : ""}${page.title}.md`;

/**
 * The files of a Markdown export: every page as `folder/Title.md` (links stay `[[Title]]`, as Obsidian reads them)
 * and the attachments they embed in `attachments/`. `attachments`: `[{name, bytes}]`.
 */
export function markdownFiles(pages, attachments = []) {
  const files = pages.map((p) => ({ name: pageFile(p), data: p.markdown }));
  for (const a of attachments) files.push({ name: `attachments/${a.name}`, data: a.bytes });
  return files;
}

// ---------- one HTML file from rendered pages ----------

/** Content styles for exports, prints and public pages: light by default, dark when the reader's system is. */
export const EXPORT_CSS = `
:root { --bg: #ffffff; --bg-2: #f6f7f9; --bg-3: #eceef2; --fg: #1d2026; --fg-dim: #626a76; --border: #dadde3;
  --accent: #3b6fd8; --danger: #c93c3c; --success: #2f8a4c; --warning: #b7791f; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not(.light) { --bg: #17191d; --bg-2: #1f2227; --bg-3: #2a2e35; --fg: #e5e7eb; --fg-dim: #9aa1ac;
    --border: #343941; --accent: #7aa2f7; --danger: #ef6b6b; --success: #5cc47e; --warning: #e3a33b; color-scheme: dark; }
}
:root.dark { --bg: #17191d; --bg-2: #1f2227; --bg-3: #2a2e35; --fg: #e5e7eb; --fg-dim: #9aa1ac; --border: #343941;
  --accent: #7aa2f7; --danger: #ef6b6b; --success: #5cc47e; --warning: #e3a33b; color-scheme: dark; }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0; font: 16px/1.65 -apple-system, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word; }
.wiki-export { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
.wiki-export article + article { margin-top: 56px; padding-top: 32px; border-top: 1px solid var(--border); }
.page-title { font-size: 2em; line-height: 1.2; margin: 0 0 12px; }
.page-meta { color: var(--fg-dim); font-size: 0.85em; margin: 0 0 20px; }
.toc { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px;
  margin: 0 0 32px; }
.toc h2 { font-size: 1em; margin: 0 0 6px; }
.toc ol { margin: 0; padding-left: 20px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; } h4, h5, h6 { font-size: 1em; }
p, ul, ol, blockquote, pre, table, .callout { margin: 0 0 1em; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
a.wl.missing, .wl-out.missing { color: var(--danger); }
.wl-out { color: inherit; border-bottom: 1px dotted var(--fg-dim); }
.tag { color: var(--accent); background: var(--bg-3); border-radius: 999px; padding: 0 7px; font-size: 0.88em; }
code { font: 0.9em ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--bg-3); border-radius: 4px;
  padding: 1px 5px; }
pre { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
  overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid var(--border); margin-left: 0; padding: 2px 0 2px 14px; color: var(--fg-dim); }
mark { background: #fff3a3; color: #1d2026; border-radius: 3px; padding: 0 2px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
figure { margin: 0 0 1em; } figcaption { color: var(--fg-dim); font-size: 0.88em; text-align: center; }
.table-wrap { overflow-x: auto; margin: 0 0 1em; }
table { border-collapse: collapse; min-width: 50%; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--bg-2); }
.props { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); margin: 0 0 20px;
  font-size: 0.92em; }
.props th, .props td { border: 0; border-bottom: 1px solid var(--border); background: none; }
.props tr:last-child th, .props tr:last-child td { border-bottom: 0; }
.props th { color: var(--fg-dim); font-weight: 500; width: 30%; }
.callout { border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px;
  background: var(--bg-2); padding: 10px 14px; }
.callout-title { font-weight: 600; display: flex; gap: 8px; align-items: center; }
.callout-body > :last-child { margin-bottom: 0; }
.callout[data-callout="warning"], .callout[data-callout="caution"] { border-left-color: var(--warning); }
.callout[data-callout="danger"], .callout[data-callout="error"], .callout[data-callout="bug"] {
  border-left-color: var(--danger); }
.callout[data-callout="tip"], .callout[data-callout="success"], .callout[data-callout="check"] {
  border-left-color: var(--success); }
.math { font-family: "Cambria Math", "STIX Two Math", serif; font-style: italic; }
.att-file, .missing-image { color: var(--fg-dim); background: var(--bg-3); border-radius: 6px; padding: 1px 8px;
  font-size: 0.9em; }
li.task { list-style: none; } input[type="checkbox"] { margin-right: 6px; }
@media (max-width: 600px) { body { font-size: 15px; } .wiki-export { padding: 20px 14px 48px; } }
@media print {
  :root, :root.dark { --bg: #fff; --bg-2: #f6f7f9; --bg-3: #eceef2; --fg: #000; --fg-dim: #555; --border: #ccc;
    color-scheme: light; }
  .wiki-export { max-width: none; padding: 0; }
  .wiki-export article + article { break-before: page; border: 0; margin: 0; padding: 0; }
  .toc { break-after: page; }
  a { color: inherit; } pre, table, img, .callout { break-inside: avoid; }
}
`;

const unescapeAttr = (s) =>
  String(s ?? "").replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

/** The anchor id of a page in an export (unique: `taken` collects them). */
export function anchorOf(title, taken = new Set()) {
  const base = `p-${slug(title) || "page"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Our renderer's HTML made to stand alone: links to pages in `anchors` (keyOf(title) → "#id" or an address) work,
 * other page links become plain text, tags become chips, pictures get their data URL from `images` (name, any case →
 * data URL) or a "[picture: name]" mark, file links become their names. Nothing else is touched: the HTML is our
 * renderer's, which escapes everything else.
 */
export function standaloneHtml(html, { anchors = new Map(), images = {} } = {}) {
  const imgs = new Map(Object.entries(images).map(([k, v]) => [k.toLowerCase(), v]));
  return String(html ?? "")
    .replace(/<a\b([^>]*?)\bdata-page="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_m, _a, target, _b, inner) => {
      const href = anchors.get(keyOf(unescapeAttr(target)));
      if (!href) return `<span class="wl-out">${inner}</span>`;
      const outside = /^https?:/i.test(href);
      return `<a class="wl" href="${escapeHtml(href)}"${outside ? ' target="_blank" rel="noopener"' : ""}>${inner}</a>`;
    })
    .replace(/<a\b[^>]*\bclass="tag"[^>]*>([\s\S]*?)<\/a>/g, (_m, inner) => `<span class="tag">${inner}</span>`)
    .replace(/<a\b[^>]*\bdata-file="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, _name, inner) =>
      `<span class="att-file">${inner}</span>`)
    .replace(/<img\b([^>]*?)\bdata-file="([^"]*)"([^>]*?)\/?>/g, (_m, before, name, after) => {
      const url = imgs.get(unescapeAttr(name).toLowerCase());
      const attrs = `${before} ${after}`.replace(/\s(src|srcset)="[^"]*"/g, "").replace(/\s+/g, " ").trim();
      if (!url || !/^data:image\//i.test(url)) return `<span class="missing-image">[picture: ${name}]</span>`;
      return `<img ${attrs} src="${url}">`;
    });
}

/** The names of the pictures some rendered HTML embeds (`img[data-file]`). */
export function embeddedImages(html) {
  const out = new Set();
  for (const m of String(html ?? "").matchAll(/<img\b[^>]*\bdata-file="([^"]*)"/g)) out.add(unescapeAttr(m[1]));
  return [...out];
}

/** A page's properties as a small table (rendered values: `render(value)` → inline HTML). */
export function propsTable(props, render = escapeHtml) {
  const rows = Object.entries(props ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "" &&
    !(Array.isArray(v) && !v.length));
  if (!rows.length) return "";
  const show = (v) => (Array.isArray(v) ? v.map((x) => render(String(x))).join(", ") : render(String(v)));
  return `<table class="props"><tbody>${rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${show(v)}</td></tr>`).join("")}</tbody></table>`;
}

/**
 * One self-contained HTML file: `pages` = `[{title, html, propsHtml?}]` (rendered bodies), links between them work as
 * anchors, pictures inlined from `images`, styles inlined. More than one page gets a table of contents.
 */
export function exportDocument({ title, pages, images = {}, css = EXPORT_CSS, generated = new Date() }) {
  const taken = new Set();
  const anchors = new Map();
  const ids = pages.map((p) => {
    const id = anchorOf(p.title, taken);
    if (!anchors.has(keyOf(p.title))) anchors.set(keyOf(p.title), `#${id}`);
    return id;
  });
  const toc = pages.length > 1
    ? `<nav class="toc"><h2>Pages</h2><ol>${pages.map((p, i) =>
      `<li><a href="#${ids[i]}">${escapeHtml(p.title)}</a></li>`).join("")}</ol></nav>`
    : "";
  const articles = pages.map((p, i) =>
    `<article id="${ids[i]}"><h1 class="page-title">${escapeHtml(p.title)}</h1>` +
      `${standaloneHtml(p.propsHtml ?? "", { anchors, images })}${standaloneHtml(p.html, { anchors, images })}</article>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="layr Wiki">
<meta name="date" content="${generated.toISOString()}">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main class="wiki-export">
${toc}
${articles.join("\n")}
</main>
</body>
</html>
`;
}

// ---------- public links ----------

export const SHARE_BUCKET = "lf-wiki-shares";
export const SHARE_MAX_BYTES = 20 * 1024 * 1024;
export const SHARE_MIGRATION_HINT =
  "Public links need the database update: the user runs supabase/migrations/lf_0005_wiki_shares.sql " +
  "(node scripts/db-migrate.mjs)";
const SLUG_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random slug of 24 letters and digits (~143 bits): nobody finds a public page without its link. */
export function newSlug(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(48);
  let out = "";
  // Rejection sampling keeps every character equally likely (62 doesn't divide 256).
  for (const b of bytes) {
    if (b < 248) out += SLUG_CHARS[b % 62];
    if (out.length === 24) return out;
  }
  return out.length === 24 ? out : out + newSlug(random).slice(out.length);
}

/** A Supabase project's ref from its address (`https://<ref>.supabase.co`). */
export const projectRef = (url) => /^https?:\/\/([a-z0-9]+)\./i.exec(String(url ?? ""))?.[1] ?? null;

/** Where a public page's JSON lives (public bucket: anyone with the address reads it). */
export const shareObjectUrl = (ref, uid, slugText) =>
  `https://${ref}.supabase.co/storage/v1/object/public/${SHARE_BUCKET}/${uid}/${slugText}.json`;

/** The link people open: the viewer's address with `#<project ref>/<user id>/<slug>`. */
export function shareLink(viewer, { ref, uid, slug: s }) {
  const base = String(viewer ?? "").trim().replace(/#.*$/, "");
  if (!base) return null;
  return `${base}#${ref}/${uid}/${s}`;
}

/** `#<ref>/<uid>/<slug>` → its parts, or null when it isn't one (the viewer checks the same way). */
export function parseShareHash(hash) {
  const m = /^#?([a-z0-9]{6,40})\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{16,64})$/i.exec(String(hash ?? "").trim());
  return m ? { ref: m[1], uid: m[2].toLowerCase(), slug: m[3] } : null;
}

/**
 * One request to the public bucket as the signed-in user: POST (create or replace, `body` = the JSON's bytes) or
 * DELETE `<user id>/<slug>.json`. `session` = `{url, key, accessToken, userId}`. Fails with a message that says
 * what to do (the database update, sign-in, a page too big).
 */
export async function shareRequest(session, method, slugText, body = null, fetchImpl = (...a) => globalThis.fetch(...a)) {
  if (!session?.accessToken) throw new Error("Sign in to layr to publish pages");
  const url = `${session.url}/storage/v1/object/${SHARE_BUCKET}/${session.userId}/${slugText}.json`;
  const headers = { authorization: `Bearer ${session.accessToken}`, apikey: session.key };
  if (body) Object.assign(headers, { "content-type": "application/json", "x-upsert": "true", "cache-control": "60" });
  const res = await fetchImpl(url, { method, headers, body });
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  if (method === "DELETE" && (res.status === 404 || /not.?found/i.test(text))) return res;
  if (/bucket not found|row-level security|not authorized|unauthorized/i.test(text)) throw new Error(SHARE_MIGRATION_HINT);
  if (res.status === 413 || /too large|maximum allowed size/i.test(text)) {
    throw new Error("The page is too big to publish (its pictures): at most 20 MB");
  }
  throw new Error(`Storage answered ${res.status}: ${text.slice(0, 200)}`);
}

/** The JSON a public page is: `{v, title, html, css, images: {name: data URL}, updated, published}`. */
export function shareDoc({ title, html, images = {}, css = EXPORT_CSS, updated, published = Date.now() }) {
  const pics = {};
  for (const [name, url] of Object.entries(images)) if (/^data:image\//i.test(url)) pics[name] = url;
  return { v: 1, title: String(title ?? ""), html: String(html ?? ""), css, images: pics, updated: updated ?? published,
    published, generator: "layr Wiki" };
}

// ---------- Notion exports ----------

/** A byte order mark at the start of a text (written as a code so it is visible here). */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

const HEX32 = /(?:^|[\s_-])[0-9a-f]{32}$/i;

/** A Notion file or folder name without its 32-hex id: `Some Page 1a2b….md` → `Some Page.md`. */
export function stripNotionId(name) {
  const s = String(name ?? "");
  const dot = /\.[a-z0-9]{1,5}$/i.exec(s);
  const ext = dot ? dot[0] : "";
  let base = ext ? s.slice(0, -ext.length) : s;
  let all = "";
  if (ext.toLowerCase() === ".csv" && /_all$/i.test(base)) {
    base = base.slice(0, -4);
    all = "_all";
  }
  const stripped = base.replace(HEX32, "").trim();
  return `${stripped || base}${all}${ext}`;
}

const norm = (p) => {
  const out = [];
  for (const part of String(p).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};
const pathKey = (p) => norm(p).toLowerCase();
const dirOf = (p) => norm(p).split("/").slice(0, -1).join("/");
const baseOf = (p) => norm(p).split("/").pop();
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * What a Notion export becomes. `paths`: every file's path in the zip or folder. `taken(title)` → true when a page of
 * that title exists already. `folder`: where it goes in the wiki ("" = the top). Gives `{pages: [{path, title,
 * folder, kind: "md"|"csv"}], files: [{path, name}], root}`: folders keep Notion's nesting without the ids, titles
 * are unique (" (2)" when taken), and `files` are the attachments to upload (their wanted names).
 */
export function planNotion(paths, { taken = () => false, folder = "" } = {}) {
  const all = paths.map(norm).filter((p) => p && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(p));
  // A zip often has one folder around everything (Export-…): drop it unless it is a page's own folder.
  let root = "";
  const firsts = new Set(all.map((p) => p.split("/")[0]));
  if (firsts.size === 1 && all.every((p) => p.includes("/"))) root = [...firsts][0];
  const rel = (p) => (root ? p.slice(root.length + 1) : p);
  const used = new Set();
  const unique = (t) => {
    let title = t;
    for (let n = 2; used.has(keyOf(title)) || taken(title); n++) title = `${t} (${n})`;
    used.add(keyOf(title));
    return title;
  };
  const folderOf = (p) => {
    const parts = dirOf(rel(p)).split("/").filter(Boolean).map((s) => cleanTitle(stripNotionId(s)));
    return [String(folder ?? "").replace(/^\/+|\/+$/g, ""), ...parts].filter(Boolean).join("/");
  };
  const csvs = all.filter((p) => /\.csv$/i.test(p));
  const hasAll = new Set(csvs.filter((p) => /_all\.csv$/i.test(p)).map((p) => pathKey(p.replace(/_all\.csv$/i, ".csv"))));
  const pages = [];
  const files = [];
  for (const p of all) {
    if (/\.md$/i.test(p)) {
      pages.push({ path: p, kind: "md", title: unique(cleanTitle(stripNotionId(baseOf(p)).replace(/\.md$/i, ""))),
        folder: folderOf(p) });
    } else if (/\.csv$/i.test(p)) {
      if (hasAll.has(pathKey(p))) continue; // the _all.csv twin has every row
      const name = stripNotionId(baseOf(p)).replace(/(_all)?\.csv$/i, "");
      pages.push({ path: p, kind: "csv", title: unique(cleanTitle(name)), folder: folderOf(p) });
    } else if (!/\.(html?)$/i.test(p)) {
      files.push({ path: p, name: cleanFileName(stripNotionId(baseOf(p))) });
    }
  }
  return { pages, files, root };
}

/** One CSV line set → rows of cells (quotes, doubled quotes and line breaks in quoted cells). */
export function parseCsv(text) {
  const s = String(text ?? "").replace(BOM, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const cellText = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * A Notion database (CSV) as a Markdown table. `linkOf(cell)` → a page title when the first column names a row page
 * (Notion exports each row as a page too), which then shows as `[[Title]]`.
 */
export function csvToMarkdown(text, { linkOf = () => null } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];
  const [head, ...body] = rows.map(pad);
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [
    line(head.map(cellText)),
    line(head.map(() => "---")),
    ...body.map((r) => line(r.map((c, i) => {
      const t = i === 0 ? linkOf(c.trim()) : null;
      return t ? (keyOf(t) === keyOf(c.trim()) ? `[[${t}]]` : `[[${t}\\|${cellText(c)}]]`) : cellText(c);
    }))),
  ].join("\n");
}

/**
 * A Notion page's Markdown as a wiki page: its `# Title` line dropped, links to other exported pages
 * (`[Text](Other%20Page%20<id>.md)`) as `[[Title]]` / `[[Title|Text]]`, pictures and files as `![[name]]` /
 * `[[name]]`, `<aside>` callouts as `> [!note]`. `path`: the page's path in the export; `titleOf(pathKey)` → the
 * title a page or database got; `fileOf(pathKey)` → the attachment name a file got (null: not uploaded).
 */
export function convertNotionMarkdown(markdown, { path = "", title = "", titleOf = () => null, fileOf = () => null } = {}) {
  let text = String(markdown ?? "").replace(/\r\n?/g, "\n").replace(BOM, "");
  const first = /^#\s+(.*)\n?/.exec(text);
  // Notion starts every page with its title; a title made unique (" (2)") still matches it.
  const names = [title, String(title).replace(/ \(\d+\)$/, "")].map(keyOf);
  if (first && (!title || names.includes(keyOf(cleanTitle(first[1]))) || names.includes(keyOf(first[1])))) {
    text = text.slice(first[0].length).replace(/^\n+/, "");
  }
  const dir = dirOf(path);
  const target = (href) => {
    const h = decode(href.replace(/[?#].*$/, ""));
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("/")) return null;
    return pathKey(dir ? `${dir}/${h}` : h);
  };
  const lines = text.split("\n");
  let fence = null;
  const out = [];
  let aside = null;
  for (const line of lines) {
    const f = /^ {0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    if (/^\s*<aside>\s*$/i.test(line)) {
      aside = [];
      continue;
    }
    if (aside && /^\s*<\/aside>\s*$/i.test(line)) {
      const body = aside.join("\n").trim().split("\n");
      out.push("> [!note]", ...body.map((l) => `> ${l}`.trimEnd()));
      aside = null;
      continue;
    }
    const converted = line.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, bang, label, href) => {
      const key = target(href);
      if (!key) return m;
      const page = titleOf(key);
      if (page) {
        const shown = label.trim();
        return !shown || keyOf(shown) === keyOf(page) || keyOf(cleanTitle(shown)) === keyOf(page)
          ? `[[${page}]]` : `[[${page}|${shown.replace(/[\[\]|]/g, "")}]]`;
      }
      const file = fileOf(key);
      if (file) return bang || isImageName(file) ? `![[${file}]]` : `[[${file}]]`;
      return m;
    });
    (aside ?? out).push(converted);
  }
  if (aside) out.push(...aside);
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "")}\n`;
}

/** Notion's pages and databases of a plan, keyed for convertNotionMarkdown: `{titleOf, fileOf}` lookups. */
export function notionLookups(plan, uploaded = new Map()) {
  const titles = new Map();
  for (const p of plan.pages) {
    titles.set(pathKey(p.path), p.title);
    // A database's folder of row pages and its .csv both point at the database page.
    if (p.kind === "csv") titles.set(pathKey(p.path.replace(/_all\.csv$/i, ".csv")), p.title);
  }
  return {
    titleOf: (key) => titles.get(key) ?? null,
    fileOf: (key) => uploaded.get(key) ?? null,
    key: pathKey,
  };
}
