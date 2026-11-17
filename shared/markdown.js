// A page's Markdown as safe HTML, with what Obsidian adds: `[[links]]` (missing pages in red), `![[embeds]]` of
// pictures and files, `> [!note]` callouts, `==highlights==`, `%%comments%%`, `#tags`, and `$math$` (shown as written,
// in a math style). Built on the Notes plugin's small renderer. All raw HTML is escaped; only http(s), mailto and
// relative links survive. Pure: `renderMarkdown(text, options)` gives HTML text (tested in test/markdown.test.js).
//
// options.resolve(target) → {title, exists}: how a [[link]] shows (default: as written, existing).
import { isFileTarget, parseLink, slug } from "./links.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
export const isImageName = (name) => IMAGE.test(String(name ?? ""));

/** Only http(s), mailto, anchors and relative links; data: only for pictures; anything else becomes "#". */
function safeUrl(url) {
  const u = url.trim().replace(/&amp;/g, "&");
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return escapeHtml(u);
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(u)) return escapeHtml(u);
  return "#";
}

const external = (url) => (/^(https?:|mailto:)/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : "");

/** A `[[link]]` or `![[embed]]` as HTML. */
function wikiLink(inner, embed, opts) {
  const { target: raw, heading, label } = parseLink(inner);
  const target = raw.replace(/\.md$/i, "");
  if (!target) return escapeHtml(`[[${inner}]]`);
  if (isFileTarget(target)) {
    const name = escapeHtml(target);
    if (embed && isImageName(target)) {
      const width = /^\d{1,4}(x\d{1,4})?$/.test(label ?? "") ? ` style="width:${label.split("x")[0]}px"` : "";
      return `<img class="att" data-file="${name}" alt="${name}"${width}>`;
    }
    return `<a class="att-link" href="#" data-file="${name}">📎 ${escapeHtml(label && embed ? target : label ?? target)}</a>`;
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
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, alt, url, title) =>
    stash(`<img src="${safeUrl(url)}" alt="${alt}"${title ? ` title="${title}"` : ""}>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_m, label, url, title) =>
    `<a href="${stash(safeUrl(url))}"${title ? ` title="${title}"` : ""}${stash(external(url))}>${label}</a>`);
  s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url) =>
    stash(`<a href="${safeUrl(url)}"${external(url)}>${url}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (_m, pre, url) =>
    `${pre}${stash(`<a href="${safeUrl(url)}"${external(url)}>${url}</a>`)}`);
  s = s.replace(/(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_\-/]*)/gu, (_m, pre, tag) =>
    `${pre}${stash(`<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`)}`);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^*\w])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?=\S)([\s\S]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, "<mark>$1</mark>");
  s = s.replace(/(?: {2,}|\\)\n/g, "<br>\n");
  for (let n = 0; n < 3 && s.includes("\u0000"); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
  return s;
}

const RE = {
  fence: /^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/,
  math: /^ {0,3}\$\$\s*$/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?(.*)$/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  blank: /^\s*$/,
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const indentOf = (l) => l.match(/^\s*/)[0].length;

function renderList(lines, start, opts) {
  const first = RE.item.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
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
    items.push(body);
  }
  const html = items
    .map((body) => {
      let text = body[0];
      let task = "";
      const t = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (t) {
        task = `<input type="checkbox" disabled${t[1] !== " " ? " checked" : ""}> `;
        text = t[2];
      }
      const rest = body.slice(1);
      const nestedAt = rest.findIndex((l) => RE.blank.test(l) || RE.item.test(l) || RE.fence.test(l) || RE.quote.test(l));
      const para = [text, ...(nestedAt < 0 ? rest : rest.slice(0, nestedAt))].join("\n").trim();
      const nested = nestedAt < 0 ? "" : blocks(rest.slice(nestedAt), opts);
      return `<li${task ? ' class="task"' : ""}>${task}${inline(para, opts)}${nested}</li>`;
    })
    .join("\n");
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return { html: `<${tag}${startAttr}>\n${html}\n</${tag}>`, next: i };
}

const CALLOUT_ICONS = {
  note: "✎", info: "ℹ", tip: "💡", hint: "💡", important: "❗", warning: "⚠", caution: "⚠", danger: "⛔",
  question: "?", todo: "☐", example: "▸", quote: "❝", success: "✓", failure: "✗", bug: "🐞", abstract: "≡",
  summary: "≡",
};

/** A quote's lines as a callout (`[!kind] Title` on its first line), or null when it is a plain quote. */
function callout(q, opts) {
  const m = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(q[0] ?? "");
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const title = m[3] || kind[0].toUpperCase() + kind.slice(1);
  const icon = CALLOUT_ICONS[kind] ?? "✎";
  const body = blocks(q.slice(1), opts);
  return (
    `<div class="callout" data-callout="${escapeHtml(kind)}"><div class="callout-title">` +
    `<span class="callout-icon">${icon}</span><span>${inline(title, opts)}</span></div>` +
    `${body ? `<div class="callout-body">${body}</div>` : ""}</div>`
  );
}

function blocks(lines, opts) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = RE.fence.exec(line))) {
      const fence = m[1];
      const lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (RE.math.test(line)) {
      const math = [];
      i++;
      while (i < lines.length && !RE.math.test(lines[i])) math.push(lines[i++]);
      i++;
      out.push(`<div class="math block">${escapeHtml(math.join("\n"))}</div>`);
      continue;
    }
    if ((m = RE.heading.exec(line))) {
      const n = m[1].length;
      const id = slug(m[2].replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2"));
      out.push(`<h${n} id="${escapeHtml(id)}">${inline(m[2], opts)}</h${n}>`);
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
      out.push(callout(q, opts) ?? `<blockquote>${blocks(q, opts)}</blockquote>`);
      continue;
    }
    if (RE.item.test(line)) {
      const r = renderList(lines, i, opts);
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
        `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_h, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}` +
          "</tbody></table></div>",
      );
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
      !(RE.item.test(lines[i]) && para.length === 0)
    ) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n"), opts)}</p>`);
  }
  return out.join("\n");
}

/** A page's body (no properties block) → safe HTML. */
export function renderMarkdown(text, opts = {}) {
  return blocks(String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), opts);
}

/** One line of inline Markdown → safe HTML (info box values). */
export const renderInline = (text, opts = {}) => inline(String(text ?? ""), opts);
