// Pasted HTML (from a web page, Word, Google Docs) as Markdown: headings, bold, italic, strike, code, links, lists,
// tasks, quotes, tables, rules and line breaks; everything else becomes its text. Used only when the HTML holds such
// structure (an editor's coloured code is pasted as its plain text). Small on purpose: the backend's importers use
// turndown for whole documents.

const SEMANTIC = /<(a\s|h[1-6]|strong|b[\s>]|em[\s>]|i[\s>]|ul|ol|li|table|blockquote|del|s[\s>]|pre)/i;

/** Should this clipboard HTML be converted (rather than pasting its plain text)? */
export const worthConverting = (html) => Boolean(html) && SEMANTIC.test(html) && !/<meta[^>]+vscode/i.test(html);

const inlineText = (s) => s.replace(/\s+/g, " ");

/** Clipboard HTML → Markdown (or null when it can't be read). */
export function htmlToMarkdown(html) {
  let docNode;
  try {
    docNode = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  for (const n of docNode.querySelectorAll("script, style, meta, link, title, noscript")) n.remove();

  const inline = (node) => {
    let out = "";
    for (const c of node.childNodes) out += inl(c);
    return out;
  };
  const wrapMark = (m, s) => {
    const t = s.trim();
    if (!t) return s;
    const lead = s.match(/^\s*/)[0];
    const trail = s.match(/\s*$/)[0];
    return `${lead}${m}${t}${m}${trail}`;
  };
  function inl(n) {
    if (n.nodeType === 3) return inlineText(n.nodeValue);
    if (n.nodeType !== 1) return "";
    const tag = n.tagName.toLowerCase();
    const style = n.getAttribute("style") ?? "";
    switch (tag) {
      case "br":
        return "\n";
      case "strong":
      case "b":
        return /font-weight:\s*(normal|[1-4]00)/.test(style) ? inline(n) : wrapMark("**", inline(n));
      case "em":
      case "i":
        return wrapMark("*", inline(n));
      case "del":
      case "s":
      case "strike":
        return wrapMark("~~", inline(n));
      case "u":
        return `<u>${inline(n)}</u>`;
      case "sup":
        return `<sup>${inline(n)}</sup>`;
      case "sub":
        return `<sub>${inline(n)}</sub>`;
      case "mark":
        return wrapMark("==", inline(n));
      case "code":
        return `\`${n.textContent}\``;
      case "img": {
        const src = n.getAttribute("src") ?? "";
        return /^https?:/i.test(src) ? `![${n.getAttribute("alt") ?? ""}](${src})` : "";
      }
      case "a": {
        const href = n.getAttribute("href") ?? "";
        const text = inline(n).trim();
        if (!/^(https?:|mailto:)/i.test(href)) return text;
        return text && text !== href ? `[${text}](${href})` : `<${href}>`;
      }
      case "span": {
        const s = inline(n);
        if (/font-weight:\s*(bold|[6-9]00)/.test(style)) return wrapMark("**", s);
        if (/font-style:\s*italic/.test(style)) return wrapMark("*", s);
        return s;
      }
      default:
        return BLOCK.has(tag) ? `\n${block(n).trim()}\n` : inline(n);
    }
  }

  const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre",
    "table", "hr", "section", "article", "header", "footer", "main", "figure"]);

  function list(n, depth) {
    const ordered = n.tagName.toLowerCase() === "ol";
    let i = Number(n.getAttribute("start") ?? 1) || 1;
    const lines = [];
    for (const li of n.children) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const box = li.querySelector(":scope > input[type=checkbox]");
      const parts = [];
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) nested.push(list(c, depth + 1));
        else if (c !== box) parts.push(c.nodeType === 1 && BLOCK.has(c.tagName.toLowerCase()) ? block(c) : inl(c));
      }
      const marker = ordered ? `${i++}.` : "-";
      const task = box ? (box.checked ? "[x] " : "[ ] ") : "";
      lines.push(`${"    ".repeat(depth)}${marker} ${task}${parts.join("").replace(/\s*\n\s*/g, " ").trim()}`);
      lines.push(...nested);
    }
    return lines.join("\n");
  }

  function table(n) {
    const rows = [...n.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()));
    if (!rows.length) return "";
    const cols = Math.max(...rows.map((r) => r.length));
    const fill = (r) => Array.from({ length: cols }, (_x, i) => r[i] ?? "");
    const out = [`| ${fill(rows[0]).join(" | ")} |`, `| ${Array(cols).fill("---").join(" | ")} |`];
    for (const r of rows.slice(1)) out.push(`| ${fill(r).join(" | ")} |`);
    return out.join("\n");
  }

  function block(n) {
    const out = [];
    let para = "";
    const flush = () => {
      const t = para.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
      if (t) out.push(t);
      para = "";
    };
    for (const c of n.childNodes) {
      const tag = c.nodeType === 1 ? c.tagName.toLowerCase() : null;
      if (!tag || !BLOCK.has(tag)) {
        para += inl(c);
        continue;
      }
      flush();
      if (/^h[1-6]$/.test(tag)) out.push(`${"#".repeat(Number(tag[1]))} ${inline(c).replace(/\s+/g, " ").trim()}`);
      else if (tag === "ul" || tag === "ol") out.push(list(c, 0));
      else if (tag === "blockquote") out.push(block(c).split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
      else if (tag === "pre") out.push(`\`\`\`\n${c.textContent.replace(/\n$/, "")}\n\`\`\``);
      else if (tag === "table") out.push(table(c));
      else if (tag === "hr") out.push("---");
      else out.push(block(c));
    }
    flush();
    return out.filter(Boolean).join("\n\n");
  }

  const md = block(docNode.body).replace(/\n{3,}/g, "\n\n").trim();
  return md || null;
}
