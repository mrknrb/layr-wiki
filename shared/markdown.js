// A page's Markdown as safe HTML, with what Obsidian adds: `[[links]]` (missing pages in red), `![[embeds]]` of
// pictures (sized, with captions), PDFs and other pages (or one of their sections), `> [!note]` callouts (foldable
// with `-` / `+`), `==highlights==`, `%%comments%%`, `#tags`, `$math$` (shown as written, in a math style) and task
// checkboxes that know their line. Raw HTML is escaped except a small formatting subset (HTML_SUBSET below: coloured
// text and highlights, underline, superscript, subscript), whose only attribute is a checked `style` of colours. Only
// http(s), mailto and relative links survive. Pure: `renderMarkdown(text, options)` gives HTML text (tested in
// test/markdown.test.js); the panel (panels/page/render.js) fills in what needs the network (pictures, PDFs).
//
// options:
//   resolve(target) → {title, exists}       how a [[link]] shows (default: as written, existing)
//   embed(target) → {title, markdown}|null  a page for `![[Page]]` (null: missing); without it embeds are links
//   page: {title}                           the page being shown (`[[#Heading]]`, embed loops)
//   depth                                   embeds nest at most MAX_EMBED_DEPTH deep (0 at the top)
//   highlight(code, lang) → html|null       code block highlighting (its output is trusted)
//   captions (true), pdfInline (true)       show image captions / PDFs inside the page
//   tasks (false)                           task checkboxes clickable (else disabled)
import { isFileTarget, parseLink, slug } from "./links.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
export const isImageName = (name) => IMAGE.test(String(name ?? ""));
export const isPdfName = (name) => /\.pdf$/i.test(String(name ?? ""));

export const MAX_EMBED_DEPTH = 3;

/** Only http(s), mailto, anchors and relative links; data: only for pictures; anything else becomes "#". */
function safeUrl(url) {
  const u = url.trim().replace(/&amp;/g, "&");
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return escapeHtml(u);
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return escapeHtml(u);
  return "#";
}

const external = (url) => (/^(https?:|mailto:)/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : "");

// ---------- the HTML subset ----------

/**
 * The raw HTML a page may hold, and the style properties each tag may carry (values: colours only). Everything else
 * (other tags, other attributes, other properties, `url(…)`, `expression(…)`, unbalanced tags) stays visible as text.
 */
export const HTML_SUBSET = {
  span: ["color", "background", "background-color"],
  mark: ["background", "background-color"],
  u: [],
  sup: [],
  sub: [],
};

/** A colour value: `#hex`, `rgb()`/`rgba()` of numbers, `var(--name)`, or a colour word. */
const COLOR =
  /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}(?:\.\d+)?%?(?:\s*[,\s]\s*\d{1,3}(?:\.\d+)?%?){2}(?:\s*[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)|var\(--[a-z0-9_-]{1,60}\)|[a-z]{3,30})$/i;

export const isSafeColor = (value) => COLOR.test(String(value ?? "").trim());

/** `style="…"` text → the canonical style of allowed colour properties, or null when anything in it is not allowed. */
function cleanStyle(style, allowed) {
  const out = [];
  for (const decl of style.split(";")) {
    if (!decl.trim()) continue;
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(decl);
    if (!m) return null;
    const prop = m[1].toLowerCase();
    if (!allowed.includes(prop) || !isSafeColor(m[2])) return null;
    out.push(`${prop}:${m[2].replace(/\s+/g, " ")}`);
  }
  return out.length ? out.join(";") : null;
}

/** One raw tag → its safe HTML, or null when it is not in the subset (it is then shown as text). */
function allowedTag(close, name, attrs) {
  const allowed = HTML_SUBSET[name];
  if (!allowed) return null;
  if (close) return attrs.trim() ? null : `</${name}>`;
  if (!attrs.trim()) return name === "span" ? null : `<${name}>`;
  if (!allowed.length) return null;
  const m = /^\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/i.exec(attrs);
  if (!m) return null;
  const style = cleanStyle(m[1] ?? m[2], allowed);
  return style ? `<${name} style="${escapeHtml(style)}">` : null;
}

const RAW_TAG = /<(\/?)([a-z][a-z0-9]*)(\s[^<>]*)?>/gi;

/** Replace the subset's tags in `s` by placeholders (`\u0001n\u0001`); a tag without its partner is not kept. */
function stashTags(s, tags) {
  const out = s.replace(RAW_TAG, (m, close, name, attrs) => {
    const html = allowedTag(Boolean(close), name.toLowerCase(), attrs ?? "");
    if (!html) return m;
    tags.push({ close: Boolean(close), name: name.toLowerCase(), html, raw: m, ok: false });
    return `\u0001${tags.length - 1}\u0001`;
  });
  const open = [];
  tags.forEach((t, i) => {
    if (!t.close) open.push(i);
    else if (open.length && tags[open[open.length - 1]].name === t.name) {
      t.ok = true;
      tags[open.pop()].ok = true;
    }
  });
  return out;
}

// ---------- links and embeds ----------

/** `caption|400`, `400x300`, `caption` → `{caption, width, height}` (an image embed's label). */
export function imageLabel(label) {
  const parts = label === null || label === undefined ? [] : String(label).split("|").map((p) => p.trim());
  let width = null;
  let height = null;
  const size = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(parts[parts.length - 1] ?? "");
  if (size) {
    parts.pop();
    width = Number(size[1]) || null;
    height = size[2] ? Number(size[2]) || null : null;
  }
  const caption = parts.join("|").trim() || null;
  return { caption, width, height };
}

/** A picture (an attachment by name, or an address) with its size and caption. */
function imageHtml({ file = null, src = null, label = null, opts }) {
  const { caption, width, height } = imageLabel(label);
  const size = [width ? `width:${width}px` : "", height ? `height:${height}px;object-fit:contain` : ""]
    .filter(Boolean)
    .join(";");
  const alt = escapeHtml(caption ?? file ?? "");
  const source = file ? ` class="att" data-file="${escapeHtml(file)}"` : ` src="${src}"`;
  const img = `<img${source} alt="${alt}"${size ? ` style="${size}"` : ""} loading="lazy">`;
  if (!caption || opts.captions === false) return img;
  return (
    `<span class="figure"${width ? ` style="width:${width}px"` : ""}>${img}` +
    `<span class="figure-caption">${escapeHtml(caption)}</span></span>`
  );
}

/** `page=3&height=500` (after a PDF's `#`) → `{page, height}`. */
function pdfOptions(heading, label) {
  const page = /(?:^|&)page=(\d{1,5})/.exec(heading ?? "")?.[1];
  const height = /(?:^|&)height=(\d{2,4})/.exec(heading ?? "")?.[1] ?? (/^\d{2,4}$/.test(label ?? "") ? label : null);
  return { page: page ? Number(page) : 1, height: height ? Number(height) : null };
}

const fileLink = (name, text) =>
  `<a class="att-link" href="#" data-file="${escapeHtml(name)}">📎 ${escapeHtml(text ?? name)}</a>`;

/** A `[[link]]` or `![[embed]]` as inline HTML. */
function wikiLink(inner, embed, opts) {
  const { target: raw, heading, label } = parseLink(inner);
  const target = raw.replace(/\.md$/i, "");
  if (!target) {
    // `[[#Heading]]`: a heading of this page.
    if (!heading || !opts.page?.title) return escapeHtml(`[[${inner}]]`);
    return (
      `<a class="wl" href="#" data-page="${escapeHtml(opts.page.title)}" data-heading="${escapeHtml(slug(heading))}" ` +
      `title="${escapeHtml(heading)}">${escapeHtml(label ?? heading)}</a>`
    );
  }
  if (isFileTarget(target)) {
    if (embed && isImageName(target)) return imageHtml({ file: target, label, opts });
    if (embed && isPdfName(target) && opts.pdfInline !== false) {
      const { page, height } = pdfOptions(heading, label);
      return (
        `<span class="pdf-embed" data-file="${escapeHtml(target)}" data-pdf-page="${page}"` +
        `${height ? ` data-height="${height}"` : ""}>${fileLink(target)}</span>`
      );
    }
    return fileLink(target, label && embed ? target : label ?? target);
  }
  const info = opts.resolve?.(target) ?? { title: target, exists: true };
  const text = label ?? (heading ? `${target} › ${heading}` : target);
  const cls = `wl${info.exists ? "" : " missing"}${embed ? " embed" : ""}`;
  const tip = info.exists ? info.title : `${target}: no page yet (click to create it)`;
  const h = heading ? ` data-heading="${escapeHtml(slug(heading))}"` : "";
  return (
    `<a class="${cls}" href="#" data-page="${escapeHtml(info.exists ? info.title : target)}"${h} ` +
    `title="${escapeHtml(tip)}">${escapeHtml(text)}</a>`
  );
}

/** The lines of `body` under the heading `heading` (to the next heading of the same or a higher level). */
export function sectionOf(body, heading) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const want = slug(heading);
  let fence = null;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(```+|~~~+)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = RE.heading.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return { text: lines.slice(start, i).join("\n"), start };
    if (start < 0 && slug(stripLinks(m[2])) === want) {
      start = i;
      level = m[1].length;
    }
  }
  return start < 0 ? null : { text: lines.slice(start).join("\n"), start };
}

const stripLinks = (text) => String(text).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");

/** A page's headings in order (code left out): `[{level, text, id, line}]` (for the outline). */
export function headingsOf(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(```+|~~~+)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = RE.heading.exec(lines[i]);
    if (m) {
      const text = stripLinks(m[2]).replace(/[*_=~`]/g, "").trim();
      out.push({ level: m[1].length, text, id: slug(stripLinks(m[2])), line: i });
    }
  }
  return out;
}

/**
 * `![[Page]]` / `![[Page#Heading]]` on a line of its own: the page's text rendered inside a frame with a link to it.
 * Too deep, or a page embedding itself (directly or through others), shows as a link.
 */
function pageEmbed(inner, opts) {
  const { target: raw, heading, label } = parseLink(inner);
  const target = raw.replace(/\.md$/i, "");
  const depth = opts.depth ?? 0;
  const info = opts.resolve?.(target) ?? { title: target, exists: true };
  const title = info.exists ? info.title : target;
  const head = heading ? `${title} › ${heading}` : title;
  const link =
    `<a class="wl${info.exists ? "" : " missing"}" href="#" data-page="${escapeHtml(title)}"` +
    `${heading ? ` data-heading="${escapeHtml(slug(heading))}"` : ""} title="${escapeHtml(title)}">` +
    `${escapeHtml(label ?? head)}</a>`;
  const seen = opts.seen ?? (opts.page?.title ? [opts.page.title.toLowerCase()] : []);
  const looped = seen.includes(title.toLowerCase());
  if (depth >= MAX_EMBED_DEPTH || looped) {
    const why = looped ? "embeds itself" : "embedded too deep";
    return `<div class="page-embed stopped" title="${escapeHtml(`${head}: ${why}`)}">${link}</div>`;
  }
  const page = info.exists ? opts.embed(target) : null;
  if (!page) {
    return `<div class="page-embed missing"><div class="page-embed-head">${link}</div>` +
      `<div class="page-embed-body"><p class="page-embed-note">No page yet.</p></div></div>`;
  }
  const body = String(page.body ?? page.markdown ?? "");
  const section = heading ? sectionOf(body, heading) : { text: body, start: 0 };
  const content = section
    ? blocks(splitLines(section.text), {
      ...opts,
      depth: depth + 1,
      seen: [...seen, String(page.title ?? title).toLowerCase()],
      taskPage: page.title ?? title,
      headingIds: false,
    }, section.start)
    : `<p class="page-embed-note">No heading “${escapeHtml(heading)}” in this page.</p>`;
  return (
    `<div class="page-embed" data-embed="${escapeHtml(page.title ?? title)}"` +
    `${heading ? ` data-heading="${escapeHtml(slug(heading))}"` : ""}>` +
    `<div class="page-embed-head">${link}</div><div class="page-embed-body">${content}</div></div>`
  );
}

// ---------- inline ----------

function inline(text, opts) {
  const keep = [];
  const stash = (html) => {
    keep.push(html);
    return `\u0000${keep.length - 1}\u0000`;
  };
  let s = String(text).replace(/%%[\s\S]*?%%/g, "");
  // Code spans and math first, so nothing inside them is formatted.
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => stash(`<code>${escapeHtml(code.trim())}</code>`));
  s = s.replace(/(^|[^\\$])\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_m, pre, math) =>
    `${pre}${stash(`<span class="math">${escapeHtml(math)}</span>`)}`);
  s = s.replace(/(!?)\[\[([^\[\]\n]+?)\]\]/g, (_m, bang, inner) => stash(wikiLink(inner, bang === "!", opts)));
  const tags = [];
  s = stashTags(s, tags);
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, alt, url, title) => {
    const at = alt.indexOf("|");
    if (at >= 0 && /^\s*\d{1,4}(x\d{1,4})?\s*$/.test(alt.slice(at + 1))) {
      // `![alt|300](url)`: Obsidian's size in the alt text.
      return stash(imageHtml({ src: safeUrl(url), label: `${unescape(alt.slice(0, at))}|${alt.slice(at + 1).trim()}`,
        opts }));
    }
    return stash(`<img src="${safeUrl(url)}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy">`);
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, label, url, title) =>
    `<a href="${stash(safeUrl(url))}"${title ? ` title="${title}"` : ""}${stash(external(url))}>${label}</a>`);
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url) =>
    stash(`<a href="${safeUrl(url)}"${external(url)}>${url}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000\u0001]+[^\s<.,;:!?)\]'"\u0000\u0001])/g, (_m, pre, url) =>
    `${pre}${stash(`<a href="${safeUrl(url)}"${external(url)}>${url}</a>`)}`);
  s = s.replace(/(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_\-/]*)/gu, (_m, pre, tag) =>
    `${pre}${stash(`<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`)}`);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, "<mark>$1</mark>");
  s = s.replace(/(?: {2,}|\\)\n/g, "<br>\n");
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i) => (tags[i].ok ? tags[i].html : escapeHtml(tags[i].raw)));
  for (let n = 0; n < 3 && s.includes("\u0000"); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
  return s;
}

/** Undo escapeHtml (for a caption taken from already escaped text). */
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'" })[m]);

// ---------- blocks ----------

const RE = {
  fence: /^ {0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/,
  math: /^ {0,3}\$\$\s*$/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?(.*)$/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  // A list item that may interrupt a paragraph (CommonMark: a bullet, or a numbered list starting at 1).
  interrupt: /^ {0,3}([-*+]|1[.)])\s+\S/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  blank: /^\s*$/,
  embedLine: /^\s*!\[\[([^\[\]\n]+?)\]\]\s*$/,
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const indentOf = (l) => l.match(/^\s*/)[0].length;

/** A task's checkbox; `line` is its line in the page's text (after the properties), so a click can toggle it. */
function checkbox(checked, line, opts) {
  const where = opts.taskPage ? ` data-task-page="${escapeHtml(opts.taskPage)}"` : "";
  return `<input type="checkbox" class="task-box" data-line="${line}"${where}${opts.tasks ? "" : " disabled"}` +
    `${checked ? " checked" : ""}> `;
}

function renderList(lines, start, opts, base) {
  const first = RE.item.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const at = i;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (RE.blank.test(l)) {
        const next = lines[i + 1];
        if (next !== undefined && !RE.blank.test(next) && indentOf(next) > indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const sub = RE.item.exec(l);
      if (sub && sub[1].length <= indent) break;
      if (!sub && indentOf(l) <= indent) {
        if (RE.heading.test(l) || RE.fence.test(l) || RE.quote.test(l) || RE.hr.test(l)) break;
        body.push(l.trim());
        i++;
        continue;
      }
      body.push(l.slice(Math.min(indentOf(l), indent + 2)));
      i++;
    }
    items.push({ body, at });
  }
  const html = items
    .map(({ body, at }) => {
      let text = body[0];
      let task = "";
      let done = false;
      const t = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (t) {
        done = t[1] !== " ";
        task = checkbox(done, base + at, opts);
        text = t[2];
      }
      const rest = body.slice(1);
      const nestedAt = rest.findIndex((l) => RE.blank.test(l) || RE.item.test(l) || RE.fence.test(l) || RE.quote.test(l));
      const para = [text, ...(nestedAt < 0 ? rest : rest.slice(0, nestedAt))].join("\n").trim();
      const nested = nestedAt < 0 ? "" : blocks(rest.slice(nestedAt), opts, base + at + 1 + nestedAt);
      const cls = task ? ` class="task${done ? " done" : ""}"` : "";
      return `<li${cls} data-line="${base + at}">${task}${inline(para, opts)}${nested}</li>`;
    })
    .join("\n");
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  const cls = items.some((it) => /^\[[ xX]\]\s/.test(it.body[0])) ? ' class="contains-task-list"' : "";
  return { html: `<${tag}${startAttr}${cls}>\n${html}\n</${tag}>`, next: i };
}

const CALLOUT_ICONS = {
  note: "✎", info: "ℹ", tip: "💡", hint: "💡", important: "❗", warning: "⚠", caution: "⚠", danger: "⛔",
  error: "⛔", question: "?", faq: "?", help: "?", todo: "☐", example: "▸", quote: "❝", cite: "❝", success: "✓",
  check: "✓", done: "✓", failure: "✗", fail: "✗", missing: "✗", bug: "🐞", abstract: "≡", summary: "≡", tldr: "≡",
  attention: "⚠",
};

/** A quote's lines as a callout (`[!kind]± Title` on its first line), or null when it is a plain quote. */
function callout(q, opts, base) {
  const m = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(q[0] ?? "");
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const title = m[3] || kind[0].toUpperCase() + kind.slice(1);
  const icon = CALLOUT_ICONS[kind] ?? "✎";
  const body = blocks(q.slice(1), opts, base + 1);
  const head = `<span class="callout-icon">${icon}</span><span class="callout-text">${inline(title, opts)}</span>`;
  const inner = body ? `<div class="callout-body">${body}</div>` : "";
  if (m[2]) {
    // Foldable: `-` starts folded, `+` open.
    return (
      `<details class="callout" data-callout="${escapeHtml(kind)}" data-line="${base}"${m[2] === "+" ? " open" : ""}>` +
      `<summary class="callout-title">${head}<span class="callout-fold"></span></summary>${inner}</details>`
    );
  }
  return `<div class="callout" data-callout="${escapeHtml(kind)}" data-line="${base}"><div class="callout-title">${head}</div>` +
    `${inner}</div>`;
}

function blocks(lines, opts, base = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    let m;
    const at = base + i;
    if ((m = RE.fence.exec(line))) {
      const fence = m[1];
      const lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) &&
        /^\s*(`+|~+)\s*$/.test(lines[i]))) code.push(lines[i++]);
      i++;
      const text = code.join("\n");
      let html = null;
      if (lang && opts.highlight) {
        try {
          html = opts.highlight(text, lang);
        } catch {
          html = null;
        }
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const data = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      out.push(`<pre${data} data-line="${at}"><code${cls}>${typeof html === "string" ? html : escapeHtml(text)}</code></pre>`);
      continue;
    }
    if (RE.math.test(line)) {
      const math = [];
      i++;
      while (i < lines.length && !RE.math.test(lines[i])) math.push(lines[i++]);
      i++;
      out.push(`<div class="math block" data-line="${at}">${escapeHtml(math.join("\n"))}</div>`);
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const n = m[1].length;
      const id = slug(stripLinks(m[2]));
      const idAttr = opts.headingIds === false ? "" : ` id="${escapeHtml(id)}"`;
      out.push(`<h${n}${idAttr} data-line="${at}">${inline(m[2], opts)}</h${n}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const q = [];
      while (i < lines.length && !RE.blank.test(lines[i])) {
        const qm = RE.quote.exec(lines[i]);
        q.push(qm ? qm[1] : lines[i]);
        i++;
      }
      out.push(callout(q, opts, at) ?? `<blockquote data-line="${at}">${blocks(q, opts, at)}</blockquote>`);
      continue;
    }
    if (RE.item.test(line)) {
      const r = renderList(lines, i, opts, base);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !RE.blank.test(lines[i])) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c, opts)}</${tag}>`;
      out.push(
        `<div class="table-wrap" data-line="${at}"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_h, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}` +
          "</tbody></table></div>",
      );
      continue;
    }
    // Page embeds on lines of their own become blocks.
    if (opts.embed && (m = RE.embedLine.exec(line)) && !isFileTarget(parseLink(m[1]).target)) {
      out.push(pageEmbed(m[1], opts));
      i++;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      !RE.blank.test(lines[i]) &&
      !RE.fence.test(lines[i]) &&
      !RE.math.test(lines[i]) &&
      !RE.heading.test(lines[i]) &&
      !RE.quote.test(lines[i]) &&
      !RE.hr.test(lines[i]) &&
      !(RE.item.test(lines[i]) && (para.length === 0 || RE.interrupt.test(lines[i]))) &&
      !(para.length && opts.embed && RE.embedLine.test(lines[i]) &&
        !isFileTarget(parseLink(RE.embedLine.exec(lines[i])[1]).target))
    ) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(`<p data-line="${at}">${inline(para.join("\n"), opts)}</p>`);
  }
  return out.join("\n");
}

const splitLines = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");

/** A page's body (no properties block) → safe HTML. */
export function renderMarkdown(text, opts = {}) {
  return blocks(splitLines(text), opts, 0);
}

/** One line of inline Markdown → safe HTML (property values). */
export const renderInline = (text, opts = {}) => inline(String(text ?? ""), opts);

/** The words of a page's text without the Markdown signs (word count, reading time). */
export function plainText(body) {
  return String(body ?? "")
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/^ {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_=~`|#>]+/g, " ");
}

/** `{words, chars, readingMinutes}` of a page's text (about 230 words a minute). */
export function textStats(body) {
  const text = plainText(body);
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { words, chars: text.replace(/\s+/g, "").length, readingMinutes: Math.max(words ? 1 : 0, Math.round(words / 230)) };
}
