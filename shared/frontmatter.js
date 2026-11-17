// A page's properties: the YAML block at the top of its Markdown (`---` lines around it), the way Obsidian writes
// them. Only the flat subset Obsidian's properties use is read: `key: value`, quoted strings, numbers, true/false,
// inline lists `[a, "b c"]` and block lists (`- item` lines). Anything else (nested maps, `|` blocks) stays in the text
// as it is: `setProperties` changes only the lines of the keys it is given, so nothing it doesn't understand is lost.
// Pure functions, used by the panel and the backend (tested in test/frontmatter.test.js).

const FENCE = /^---[ \t]*$/;

/** `markdown` → `{yaml, body, props}`: the YAML text (null without a block), the rest, and the parsed properties. */
export function splitFrontmatter(markdown) {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (!FENCE.test(lines[0] ?? "")) return { yaml: null, body: text, props: {} };
  const end = lines.findIndex((line, i) => i > 0 && (FENCE.test(line) || /^\.\.\.[ \t]*$/.test(line)));
  if (end < 0) return { yaml: null, body: text, props: {} };
  const yaml = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { yaml, body, props: parseYaml(yaml) };
}

/** One scalar: a quoted string, a number, a boolean, null, or the plain text. */
function scalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replaceAll("''", "'");
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s)) return Number(s);
  return s;
}

/** `a, "b, c", d` → the items, commas inside quotes kept. */
function splitInline(inner) {
  const items = [];
  let cur = "";
  let quote = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "]") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) items.push(cur);
  return items.map(scalar).filter((v) => v !== null);
}

/** A value after `key:`: an inline list, a link written without quotes (`[[X]]`), or a scalar. */
function value(raw) {
  const s = raw.trim();
  if (s.startsWith("[[")) return s; // Obsidian quotes links, but people don't always
  if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1));
  return scalar(s.replace(/\s+#.*$/, ""));
}

/** The top-level keys of a YAML block: each with the line it starts on and how many lines it spans. */
function blocksOf(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s#:][^:]*?):(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
    if (m) blocks.push({ key: m[1].trim(), start: i, end: i + 1, rest: m[2] ?? "" });
    else if (blocks.length && (/^\s|^-\s/.test(lines[i]) || lines[i] === "")) blocks[blocks.length - 1].end = i + 1;
  }
  return blocks;
}

/** The YAML text → `{key: value}` (values: strings, numbers, booleans, null, or lists of those). */
export function parseYaml(yaml) {
  const lines = String(yaml ?? "").split("\n");
  const props = {};
  for (const block of blocksOf(lines)) {
    const rest = block.rest.trim();
    if (rest && rest !== "|" && rest !== ">") {
      props[block.key] = value(rest);
      continue;
    }
    const inner = lines.slice(block.start + 1, block.end);
    const items = inner.map((l) => /^\s*-\s+(.*)$/.exec(l)).filter(Boolean);
    if (items.length) props[block.key] = items.map((m) => value(m[1])).filter((v) => v !== null);
    else if (rest === "|" || rest === ">") {
      const text = inner.map((l) => l.replace(/^ {2}/, "")).join(rest === "|" ? "\n" : " ").trim();
      props[block.key] = text;
    } else props[block.key] = null;
  }
  return props;
}

/** Does this string need quotes in YAML to come back as the same string? */
function needsQuotes(s) {
  if (s === "" || s !== s.trim()) return true;
  if (/^[\[\]{}#&*!|>'"%@`,?:-]/.test(s) || /:\s|\s#|:$/.test(s) || s.includes("\n")) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s) || /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return true;
  return false;
}

/** One value as YAML text (after `key:`; lists as block lists, the way Obsidian writes them). */
function yamlScalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return needsQuotes(s) ? JSON.stringify(s) : s;
}

/** A property as YAML lines. */
export function propertyLines(key, v) {
  if (Array.isArray(v)) {
    if (!v.length) return [`${key}: []`];
    return [`${key}:`, ...v.map((item) => `  - ${yamlScalar(item)}`)];
  }
  const s = yamlScalar(v);
  return [s === "" ? `${key}:` : `${key}: ${s}`];
}

/** Properties → a whole YAML block's text (without the `---` lines). */
export function stringifyYaml(props) {
  return Object.entries(props)
    .flatMap(([k, v]) => propertyLines(k, v))
    .join("\n");
}

/** `yaml` (text or null) and `body` → the page's Markdown. */
export function joinFrontmatter(yaml, body) {
  const rest = String(body ?? "").replace(/^\n+/, "");
  if (yaml === null || yaml === undefined || !String(yaml).trim()) return rest;
  return `---\n${String(yaml).replace(/\n+$/, "")}\n---\n\n${rest}`;
}

/**
 * Change some properties of a page, leaving every other line as it was. `changes`: `{key: value}`; `null` or
 * `undefined` removes the key. New keys go at the end of the block; a page without one gets it.
 */
export function setProperties(markdown, changes) {
  const { yaml, body } = splitFrontmatter(markdown);
  const lines = yaml === null || yaml === "" ? [] : yaml.split("\n");
  const blocks = blocksOf(lines);
  const replacements = new Map();
  const added = [];
  for (const [key, v] of Object.entries(changes ?? {})) {
    if (!/^[^\s#:][^:\n]*$/.test(key)) throw new Error(`Not a property name: "${key}"`);
    const block = blocks.find((b) => b.key === key);
    const remove = v === null || v === undefined;
    if (block) replacements.set(block, remove ? [] : propertyLines(key, v));
    else if (!remove) added.push(...propertyLines(key, v));
  }
  const out = [];
  let i = 0;
  for (const block of blocks) {
    while (i < block.start) out.push(lines[i++]);
    if (replacements.has(block)) {
      out.push(...replacements.get(block));
      i = block.end;
    }
  }
  while (i < lines.length) out.push(lines[i++]);
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  out.push(...added);
  return joinFrontmatter(out.length ? out.join("\n") : null, body);
}
