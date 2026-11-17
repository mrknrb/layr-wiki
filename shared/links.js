// Links between pages, the way Obsidian writes them: `[[Title]]`, `[[Title|label]]`, `[[Title#Heading]]`, and
// embeds `![[picture.png]]`. Tags: `tags:` in the properties and `#tag` in the text. Titles are the pages' names and
// their file names in the folder copy, so they may not hold characters Windows or Obsidian links can't. Pure functions
// for the panel and the backend (tested in test/links.test.js).

/** Characters a title may not hold: Obsidian's link syntax `[ ] # ^ |` and what Windows file names refuse. */
export const TITLE_FORBIDDEN = /[[\]#^|\\/:*?"<>\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Why `title` can't be a page's title, or null when it can. */
export function titleProblem(title) {
  const t = String(title ?? "");
  if (!t.trim()) return "A page needs a title";
  if (t !== t.trim()) return "A title can't start or end with a space";
  if (t.length > 200) return "A title can be at most 200 characters";
  if (TITLE_FORBIDDEN.test(t)) return 'A title can\'t hold any of  [ ] # ^ | \\ / : * ? " < >';
  if (t.endsWith(".")) return "A title can't end with a dot";
  if (RESERVED.test(t)) return `"${t}" is a name Windows keeps for itself`;
  return null;
}

/** A title made safe: forbidden characters become `-` (for imports and suggestions). */
export function cleanTitle(text) {
  let t = String(text ?? "")
    .replace(/[\[\]#^|\\/:*?"<>\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .slice(0, 200)
    .trim();
  if (RESERVED.test(t)) t = `${t}-`;
  return t || "Untitled";
}

/** The lowercase form titles and aliases are matched by. */
export const keyOf = (title) => String(title ?? "").trim().toLowerCase();

/** A heading's anchor id, for `[[Page#Heading]]`. */
export const slug = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/** `text` with fenced code blocks and inline code blanked out (same length), so links inside them are not counted. */
export function maskCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const lines = String(text ?? "").split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(```+|~~~+)/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      lines[i] = blank(lines[i]);
    } else if (m) {
      fence = m[1];
      lines[i] = blank(lines[i]);
    }
  }
  return lines.join("\n").replace(/(`+)[^`\n][^\n]*?\1/g, blank);
}

const LINK = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/** One link's parts: `Title#Heading|label` → `{target, heading, label}`. */
export function parseLink(inner) {
  const [left, ...labelParts] = String(inner).split("|");
  const label = labelParts.length ? labelParts.join("|").trim() : null;
  const hash = left.indexOf("#");
  const target = (hash < 0 ? left : left.slice(0, hash)).trim();
  const heading = hash < 0 ? null : left.slice(hash + 1).trim() || null;
  return { target, heading, label };
}

/** Is this link target a file (an embed or link to an attachment) rather than a page? */
export const isFileTarget = (target) => /\.(?!md$)[a-z0-9]{1,5}$/i.test(String(target ?? ""));

/** Every `[[link]]` in `markdown` (code left out): `{target, heading, label, embed, index}` in order. */
export function extractLinks(markdown) {
  const text = maskCode(markdown);
  const out = [];
  for (const m of text.matchAll(LINK)) {
    const link = parseLink(m[2]);
    if (!link.target) continue;
    out.push({ ...link, target: link.target.replace(/\.md$/i, ""), embed: m[1] === "!", index: m.index });
  }
  return out;
}

/** The distinct page targets `markdown` links to (files left out), in their first-seen spelling. */
export function linkTargets(markdown) {
  const seen = new Map();
  for (const link of extractLinks(markdown)) {
    if (isFileTarget(link.target)) continue;
    const key = keyOf(link.target);
    if (!seen.has(key)) seen.set(key, link.target);
  }
  return [...seen.values()];
}

/** The attachment names `markdown` embeds or links to. */
export function fileTargets(markdown) {
  const seen = new Map();
  for (const link of extractLinks(markdown)) {
    if (isFileTarget(link.target) && !seen.has(keyOf(link.target))) seen.set(keyOf(link.target), link.target);
  }
  return [...seen.values()];
}

const TAG = /(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_\-/]*)/gu;

/** Inline `#tags` of a page's body (code and headings left out), without the `#`. */
export function inlineTags(body) {
  const text = maskCode(body)
    .split("\n")
    .filter((line) => !/^ {0,3}#{1,6}\s/.test(line))
    .join("\n");
  const tags = [];
  for (const m of text.matchAll(TAG)) if (!tags.includes(m[2])) tags.push(m[2]);
  return tags;
}

/** A property value as a list of strings (a single value becomes one item). */
export const asList = (v) =>
  (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]).map((x) => String(x));

/** `[[Target]]` inside a property value → its target, else null. */
export function propertyLink(v) {
  const m = /^\s*\[\[([^\[\]\n]+)\]\]\s*$/.exec(String(v ?? ""));
  return m ? parseLink(m[1]).target : null;
}

/**
 * `markdown` with every link to `from` (any case, also with a heading or label) pointing to `to` instead. Gives
 * `{markdown, count}`. Code blocks are left alone.
 */
export function renameLinks(markdown, from, to) {
  const text = String(markdown ?? "");
  const masked = maskCode(text);
  const fromKey = keyOf(from);
  let count = 0;
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(LINK)) {
    const inner = text.slice(m.index + m[1].length + 2, m.index + m[0].length - 2);
    const { target } = parseLink(inner);
    if (keyOf(target.replace(/\.md$/i, "")) !== fromKey) continue;
    const pipe = inner.indexOf("|");
    const hash = inner.indexOf("#");
    const cut = [pipe, hash].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const rest = cut === undefined ? "" : inner.slice(cut);
    out += text.slice(last, m.index) + `${m[1]}[[${to}${rest}]]`;
    last = m.index + m[0].length;
    count++;
  }
  return { markdown: out + text.slice(last), count };
}

/** Does `body` mention `title` as a whole word (any case) outside links and code? */
export function mentions(body, title) {
  const t = String(title ?? "").trim();
  if (t.length < 3) return false;
  const text = maskCode(body).replace(LINK, (m) => " ".repeat(m.length));
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}
