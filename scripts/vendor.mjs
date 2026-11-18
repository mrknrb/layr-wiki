// Builds the editor's third-party code into one file the panel can load (layr's panel CSP allows no CDN):
// `vendor/editor.js`, an ES module with CodeMirror 6, the Markdown parser, the code languages fenced blocks use and
// `highlight(code, lang)` (code highlighting for the reading view, classes `tok-*`, colours in panels/editor/editor.css).
// Also writes `panels/editor/icons.js`, the few Lucide icons the editor's toolbar draws, so the editor doesn't depend
// on the shell's icon set. Run `npm run build` in plugins/wiki after changing this file or the packages; both outputs
// are committed.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fence names → a language. Only these are bundled (no language-data, which would pull in every language).
const ENTRY = String.raw`
export * from "@codemirror/state";
export * from "@codemirror/view";
export * from "@codemirror/commands";
export * from "@codemirror/language";
export * from "@codemirror/search";
export * from "@codemirror/autocomplete";
export { markdown, commonmarkLanguage, markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward }
  from "@codemirror/lang-markdown";
export { GFM, Table, TaskList, Strikethrough, Autolink, parser as markdownParser } from "@lezer/markdown";
export { tags, Tag, classHighlighter, highlightCode, styleTags } from "@lezer/highlight";

import { StreamLanguage } from "@codemirror/language";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { sql, PostgreSQL, MySQL, SQLite } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { r } from "@codemirror/legacy-modes/mode/r";
// The C family and Rust through legacy-modes: a fraction of the Lezer grammars' size (about 230 KB less).
import { c, cpp, java, csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { rust } from "@codemirror/legacy-modes/mode/rust";

const MAKERS = {
  javascript: () => javascript().language,
  jsx: () => javascript({ jsx: true }).language,
  typescript: () => javascript({ typescript: true }).language,
  tsx: () => javascript({ jsx: true, typescript: true }).language,
  python: () => python().language,
  json: () => json().language,
  css: () => css().language,
  html: () => html().language,
  sql: () => sql().language,
  postgresql: () => sql({ dialect: PostgreSQL }).language,
  mysql: () => sql({ dialect: MySQL }).language,
  sqlite: () => sql({ dialect: SQLite }).language,
  rust: () => StreamLanguage.define(rust),
  java: () => StreamLanguage.define(java),
  kotlin: () => StreamLanguage.define(kotlin),
  c: () => StreamLanguage.define(c),
  cpp: () => StreamLanguage.define(cpp),
  csharp: () => StreamLanguage.define(csharp),
  yaml: () => yaml().language,
  markdown: () => markdown().language,
  shell: () => StreamLanguage.define(shell),
  r: () => StreamLanguage.define(r),
};
const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript", javascript: "javascript",
  jsx: "jsx", ts: "typescript", mts: "typescript", typescript: "typescript", tsx: "tsx",
  py: "python", python: "python", python3: "python", json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css", html: "html", htm: "html", xml: "html", svg: "html", vue: "html",
  sql: "sql", postgres: "postgresql", postgresql: "postgresql", psql: "postgresql", mysql: "mysql",
  sqlite: "sqlite", rust: "rust", rs: "rust", java: "java", kotlin: "kotlin", kt: "kotlin", c: "c", h: "c",
  cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", csharp: "csharp", "c#": "csharp",
  yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown", sh: "shell", bash: "shell", shell: "shell",
  zsh: "shell", console: "shell", shellsession: "shell", r: "r", rscript: "r",
};
const made = new Map();

/** The language a fence's info string names (\`py\`, \`TypeScript\`, \`c++ title\`…), or null. */
export function languageFor(info) {
  const key = ALIASES[String(info ?? "").trim().split(/[\s{]/)[0].toLowerCase()];
  if (!key) return null;
  if (!made.has(key)) made.set(key, MAKERS[key]());
  return made.get(key);
}

/** The fence names \`languageFor\` knows. */
export const languageNames = () => Object.keys(ALIASES);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Code as highlighted HTML (escaped text in \`<span class="tok-…">\`; \`classHighlighter\`'s classes, coloured by
 * editor.css). Unknown languages give the escaped text.
 */
export function highlight(code, lang) {
  const text = String(code ?? "");
  const language = languageFor(lang);
  if (!language) return esc(text);
  let out = "";
  try {
    highlightCode(text, language.parser.parse(text), classHighlighter,
      (part, cls) => (out += cls ? '<span class="' + cls + '">' + esc(part) + "</span>" : esc(part)),
      () => (out += "\n"));
  } catch {
    return esc(text);
  }
  return out;
}
`;

const result = await build({
  stdin: { contents: ENTRY, resolveDir: root, sourcefile: "editor-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "none",
  outfile: join(root, "vendor/editor.js"),
  banner: { js: "// CodeMirror 6 (MIT) and the Lezer parsers (MIT), bundled by scripts/vendor.mjs. Do not edit." },
  metafile: true,
  logLevel: "warning",
});
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`vendor/editor.js: ${(bytes / 1024).toFixed(0)} KB`);

// The toolbar's and the editor's icons (Lucide, ISC licence): name → the SVG's inner elements.
const ICONS = [
  "undo-2", "redo-2", "heading", "pilcrow", "bold", "italic", "underline", "strikethrough", "baseline", "highlighter",
  "superscript", "subscript", "link", "list", "list-ordered", "list-todo", "quote", "message-square-quote", "table",
  "code", "square-code", "image", "sigma", "minus", "chevron-down", "pencil", "info", "flame", "check",
  "circle-help", "triangle-alert", "x", "zap", "bug", "clipboard-list", "circle-check", "arrow-up", "arrow-down",
  "arrow-left", "arrow-right", "trash-2", "plus", "align-left", "align-center", "align-right", "external-link",
  "file-text", "file", "paperclip", "copy", "eraser", "between-horizontal-start", "between-vertical-start",
  "file-code", "calendar", "clock", "layout-template", "heading-1", "heading-2", "heading-3", "rows-3", "columns-3",
  "ellipsis", "remove-formatting", "keyboard", "maximize-2", "file-symlink",
];
const lines = ICONS.map((name) => {
  const svg = readFileSync(join(root, `node_modules/lucide-static/icons/${name}.svg`), "utf8");
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").replace(/\s*\n\s*/g, "").trim();
  return `  ${JSON.stringify(name)}: ${JSON.stringify(inner.replace(/ \/>/g, "/>"))},`;
});
mkdirSync(join(root, "panels/editor"), { recursive: true });
writeFileSync(join(root, "panels/editor/icons.js"),
  "// Lucide icons (https://lucide.dev, ISC licence) the editor draws: name → the SVG's inner elements.\n" +
  "// Generated by scripts/vendor.mjs; do not edit.\n" +
  `export const ICONS = {\n${lines.join("\n")}\n};\n`);
console.log(`panels/editor/icons.js: ${ICONS.length} icons`);
