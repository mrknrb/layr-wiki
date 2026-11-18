// Pure text helpers of the page part: where the text starts after the properties, ticking a task by its line, turning
// unlinked mentions into links, the lines around a link (backlink context) and a three-way line merge (a change made
// elsewhere while the user was editing). No DOM; tested in test/markdown.test.js.
import { diffLines } from "../../shared/diff.js";
import { splitFrontmatter } from "../../shared/frontmatter.js";
import { keyOf, maskCode, parseLink } from "../../shared/links.js";

const lf = (text) => String(text ?? "").replace(/\r\n?/g, "\n");

/** How many lines of `markdown` come before its body (the properties block and the blank lines after it). */
export function bodyOffset(markdown) {
  const text = lf(markdown);
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === null) return 0;
  return text.split("\n").length - body.split("\n").length;
}

const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\]\s)/;

/** `markdown` with the task on line `bodyLine` of its body ticked or unticked (`done`: set; else flip); null if none. */
export function toggleTask(markdown, bodyLine, done = null) {
  const lines = lf(markdown).split("\n");
  const at = bodyOffset(markdown) + Number(bodyLine);
  const m = TASK.exec(lines[at] ?? "");
  if (!m) return null;
  const next = done === null ? (m[2] === " " ? "x" : " ") : done ? "x" : " ";
  lines[at] = lines[at].replace(TASK, `$1${next}$3`);
  return lines.join("\n");
}

const LINK = /!?\[\[[^\[\]\n]+?\]\]/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with code, links, URLs and the properties block blanked out (same length), so mentions in them don't count. */
function maskForMentions(markdown) {
  const text = lf(markdown);
  const { yaml } = splitFrontmatter(text);
  let masked = maskCode(text).replace(LINK, (m) => " ".repeat(m.length));
  masked = masked.replace(/!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+|%%[\s\S]*?%%/g, (m) => " ".repeat(m.length));
  if (yaml !== null) {
    const head = text.split("\n").slice(0, bodyOffset(text)).join("\n").length;
    masked = " ".repeat(head) + masked.slice(head);
  }
  // Headings stay: Obsidian links mentions in headings too.
  return masked;
}

/**
 * Where `markdown` names one of `names` (a page's title and aliases) as whole words, outside links and code:
 * `[{index, length, text, line}]` in text order; the longest name wins where two overlap.
 */
export function findMentions(markdown, names) {
  const text = lf(markdown);
  const masked = maskForMentions(text);
  const sorted = [...new Set(names.map((n) => String(n ?? "").trim()).filter((n) => n.length >= 3))]
    .sort((a, b) => b.length - a.length);
  const out = [];
  const taken = [];
  for (const name of sorted) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRe(name)})(?![\\p{L}\\p{N}_])`, "giu");
    for (const m of masked.matchAll(re)) {
      const index = m.index + m[1].length;
      const end = index + m[2].length;
      if (taken.some(([a, b]) => index < b && end > a)) continue;
      taken.push([index, end]);
      out.push({ index, length: m[2].length, text: text.slice(index, end) });
    }
  }
  out.sort((a, b) => a.index - b.index);
  for (const m of out) m.line = text.slice(0, m.index).split("\n").length - 1;
  return out;
}

/**
 * Turn mentions of the page `title` (`names`: its title and aliases) in `markdown` into links: `which` is the index
 * of one mention (in findMentions' order) or "all". Gives `{markdown, count}`.
 */
export function linkMentions(markdown, title, names, which = "all") {
  const text = lf(markdown);
  const found = findMentions(text, names);
  const pick = which === "all" ? found : found[which] ? [found[which]] : [];
  let out = text;
  for (const m of [...pick].sort((a, b) => b.index - a.index)) {
    const link = m.text === title ? `[[${title}]]` : `[[${title}|${m.text}]]`;
    out = out.slice(0, m.index) + link + out.slice(m.index + m.length);
  }
  return { markdown: out, count: pick.length };
}

/** The line around each link to `title` (or an alias) in `markdown`: `[{line, text}]`, at most `max`. */
export function linkContexts(markdown, names, max = 3) {
  const keys = new Set(names.map(keyOf));
  const text = lf(markdown);
  const body = splitFrontmatter(text).body;
  const lines = body.split("\n");
  const masked = maskCode(body).split("\n");
  const out = [];
  masked.forEach((line, i) => {
    if (out.length >= max) return;
    for (const m of line.matchAll(/!?\[\[([^\[\]\n]+?)\]\]/g)) {
      if (keys.has(keyOf(parseLink(m[1]).target.replace(/\.md$/i, "")))) {
        out.push({ line: i, text: lines[i].trim() });
        return;
      }
    }
  });
  if (!out.length) {
    // Linked only from the properties (`organism: "[[Mouse]]"`).
    const { yaml } = splitFrontmatter(text);
    const prop = (yaml ?? "").split("\n").find((l) => [...l.matchAll(/\[\[([^\[\]\n]+?)\]\]/g)]
      .some((m) => keys.has(keyOf(parseLink(m[1]).target))));
    if (prop) out.push({ line: -1, text: prop.trim() });
  }
  return out;
}

/**
 * Three-way merge by lines: the user's text (`mine`) and a version saved elsewhere (`theirs`), both from `base`.
 * Gives `{text, clean}`; when both changed the same lines it is not clean and `text` is `mine` (nothing is lost:
 * their version stays in the history).
 */
export function merge3(base, mine, theirs) {
  const b = lf(base);
  const a = lf(mine);
  const c = lf(theirs);
  if (a === c || c === b) return { text: a, clean: true };
  if (a === b) return { text: c, clean: true };
  const hunks = (other) => {
    // Each change as {from, to (in base lines), lines (the replacement)}.
    const out = [];
    let at = 0;
    let cur = null;
    for (const op of diffLines(b, other)) {
      if (op.op === "same") {
        if (cur) out.push(cur);
        cur = null;
        at++;
      } else {
        cur ??= { from: at, to: at, lines: [] };
        if (op.op === "del") {
          at++;
          cur.to = at;
        } else cur.lines.push(op.text);
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  const mineH = hunks(a);
  const theirH = hunks(c);
  // Overlapping (or touching insertions at the same place) hunks conflict, unless they are the same change.
  for (const x of mineH) {
    for (const y of theirH) {
      const same = x.from === y.from && x.to === y.to && x.lines.join("\n") === y.lines.join("\n");
      const overlap = x.from < y.to && y.from < x.to;
      const touch = x.from === y.from || (x.from === x.to && x.from > y.from && x.from < y.to) ||
        (y.from === y.to && y.from > x.from && y.from < x.to);
      if (!same && (overlap || touch)) return { text: a, clean: false };
    }
  }
  const all = [...mineH];
  for (const y of theirH) {
    if (!mineH.some((x) => x.from === y.from && x.to === y.to && x.lines.join("\n") === y.lines.join("\n"))) all.push(y);
  }
  all.sort((p, q) => q.from - p.from || q.to - p.to);
  const lines = b.split("\n");
  for (const h of all) lines.splice(h.from, h.to - h.from, ...h.lines);
  return { text: lines.join("\n"), clean: true };
}
