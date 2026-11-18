// Completion while typing: `[[` → pages (titles and aliases, fuzzy), `[[Page#` → that page's headings, `![[` → pages
// and attachments, `#` at a word start → the wiki's tags, `/` at the start of a line → the slash menu (setting).
// Built on @codemirror/autocomplete with our own ranking (`fuzzyScore`), so a "new page" choice can stay last.
import { autocompletion, startCompletion } from "../../vendor/editor.js";
import { isFileTarget, keyOf } from "../../shared/links.js";
import { isImageName } from "../../shared/markdown.js";
import { inCode } from "./commands.js";
import { CALLOUTS, formatDate, fuzzyScore, headingsOf } from "./markdown-ops.js";

const MAX = 30;

/** Options ranked by fuzzy score on their `match` strings (best first). */
function rank(query, items) {
  return items
    .map((it) => ({ it, score: Math.max(...it.match.map((m) => fuzzyScore(query, m))) + (it.bonus ?? 0) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.it.label.localeCompare(b.it.label))
    .slice(0, MAX)
    .map((x) => x.it);
}

/** Insert `text` from `from` to the cursor, eating a `]]` that is already there. */
function closeWith(view, from, to, text) {
  const after = view.state.sliceDoc(to, to + 2);
  const insert = after === "]]" ? text : `${text}]]`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length + (after === "]]" ? 2 : 0) },
    userEvent: "input.complete",
  });
}

function linkSource(ctx) {
  return (context) => {
    const before = context.matchBefore(/!?\[\[[^\[\]\n]*$/);
    if (!before || inCode(context.state, context.pos)) return null;
    const embed = before.text.startsWith("!");
    const inner = before.text.slice(embed ? 3 : 2);
    if (inner.includes("|")) return null;
    const start = before.from + (embed ? 3 : 2);
    const hash = inner.indexOf("#");
    const pages = ctx.pages();
    if (hash >= 0) {
      const page = ctx.findPage(inner.slice(0, hash).trim());
      if (!page) return null;
      const q = inner.slice(hash + 1);
      const options = rank(q, headingsOf(page.body).map((hd) => ({
        label: hd.text, match: [hd.text], detail: `H${hd.level}`, type: "heading",
        apply: (view, _c, from, to) => closeWith(view, from, to, hd.text),
      })));
      return { from: start + hash + 1, options, filter: false };
    }
    const items = [];
    for (const p of pages) {
      items.push({
        label: p.title, match: [p.title], detail: p.folder || p.type || "", type: "page",
        apply: (view, _c, from, to) => closeWith(view, from, to, p.title),
      });
      for (const alias of p.aliases ?? []) {
        items.push({
          label: alias, match: [alias], detail: `→ ${p.title}`, type: "alias", bonus: -5,
          apply: (view, _c, from, to) => closeWith(view, from, to, `${p.title}|${alias}`),
        });
      }
    }
    const finish = (files) => {
      for (const f of files) {
        items.push({
          label: f.name, match: [f.name], detail: isImageName(f.name) ? "picture" : "file", type: "file",
          bonus: embed ? 5 : 0, apply: (view, _c, from, to) => closeWith(view, from, to, f.name),
        });
      }
      const options = rank(inner, items);
      const q = inner.trim();
      const known = pages.some((p) => keyOf(p.title) === keyOf(q) || p.aliases?.some((a) => keyOf(a) === keyOf(q)));
      if (q && !isFileTarget(q) && !known) {
        options.push({ label: q, displayLabel: `New page “${q}”`, type: "new", detail: "",
          apply: (view, _c, from, to) => closeWith(view, from, to, q) });
      }
      return { from: start, options, filter: false };
    };
    // Attachments (loaded, so asynchronous): always for embeds, and for links once the query looks like a file name.
    return embed || /\.\w*$/.test(inner) ? ctx.attachments().then(finish) : finish([]);
  };
}

function tagSource(ctx) {
  return (context) => {
    const before = context.matchBefore(/(?:^|[\s(,;])#[\p{L}_][\p{L}\p{N}_\-/]*$|[\s(,;]#$/u);
    if (!before || inCode(context.state, context.pos)) return null;
    const at = before.from + before.text.indexOf("#");
    const q = context.state.sliceDoc(at + 1, context.pos);
    const counts = new Map();
    for (const p of ctx.pages()) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const options = rank(q, [...counts].map(([tag, n]) => ({
      label: `#${tag}`, match: [tag], detail: String(n), type: "tag", bonus: Math.min(20, n),
      apply: `#${tag}`,
    }))).filter((o) => o.label !== `#${q}` || counts.has(q));
    if (!options.length) return null;
    return { from: at, options, filter: false };
  };
}

/** The slash menu's entries: `{label, section, icon, keywords, run(view)}`. */
function slashItems(ctx) {
  const ex = (cmd, arg) => () => ctx.exec(cmd, arg);
  const s = ctx.settings();
  const items = [
    { label: "Heading 1", section: "Text", icon: "heading-1", keywords: "h1 title", run: ex("heading", 1) },
    { label: "Heading 2", section: "Text", icon: "heading-2", keywords: "h2", run: ex("heading", 2) },
    { label: "Heading 3", section: "Text", icon: "heading-3", keywords: "h3", run: ex("heading", 3) },
    { label: "Bullet list", section: "Text", icon: "list", keywords: "ul unordered", run: ex("bullet") },
    { label: "Numbered list", section: "Text", icon: "list-ordered", keywords: "ol ordered", run: ex("numbered") },
    { label: "Task", section: "Text", icon: "list-todo", keywords: "todo checkbox checklist", run: ex("task") },
    { label: "Quote", section: "Text", icon: "quote", keywords: "blockquote", run: ex("quote") },
    { label: "Table", section: "Blocks", icon: "table", keywords: "grid", run: ex("table") },
    { label: "Code block", section: "Blocks", icon: "square-code", keywords: "fence pre", run: ex("codeblock") },
    { label: "Math block", section: "Blocks", icon: "sigma", keywords: "latex equation formula", run: ex("math") },
    { label: "Divider", section: "Blocks", icon: "minus", keywords: "hr rule line separator", run: ex("hr") },
    ...CALLOUTS.map((kind) => ({
      label: `Callout: ${kind[0].toUpperCase()}${kind.slice(1)}`, section: "Callouts", icon: "message-square-quote",
      keywords: `callout admonition ${kind}`, run: ex("callout", kind),
    })),
    { label: "Picture or file", section: "Insert", icon: "image", keywords: "image upload attachment pdf",
      run: ex("image") },
    { label: "Link to a page", section: "Insert", icon: "link", keywords: "wikilink", run: ex("link") },
    { label: "Embed a page", section: "Insert", icon: "file-symlink", keywords: "transclude include", run: ex("embed") },
    { label: "Today's date", section: "Insert", icon: "calendar", keywords: "date today now",
      run: () => ctx.insert(ctx.formatDate(new Date(), s.dateFormat || "YYYY-MM-DD")) },
    { label: "Current time", section: "Insert", icon: "clock", keywords: "time now",
      run: () => ctx.insert(ctx.formatDate(new Date(), s.timeFormat || "HH:mm")) },
    { label: "Date and time", section: "Insert", icon: "calendar", keywords: "now timestamp",
      run: () => ctx.insert(`${ctx.formatDate(new Date(), s.dateFormat || "YYYY-MM-DD")} ` +
        `${ctx.formatDate(new Date(), s.timeFormat || "HH:mm")}`) },
  ];
  for (const t of ctx.templates()) {
    items.push({ label: t.title, section: "Templates", icon: "layout-template", keywords: "template",
      run: () => ctx.insertTemplate(t) });
  }
  return items;
}

// The menu's sections in this order (autocomplete sorts plain section names alphabetically).
const SECTIONS = Object.fromEntries(["Text", "Blocks", "Callouts", "Insert", "Templates"]
  .map((name, rank) => [name, { name, rank }]));

function slashSource(ctx) {
  return (context) => {
    if (!ctx.setting("slashMenu")) return null;
    const before = context.matchBefore(/^\s*\/[\p{L}\p{N} :'-]*$/u);
    if (!before || inCode(context.state, context.pos)) return null;
    const slash = before.from + before.text.indexOf("/");
    const q = context.state.sliceDoc(slash + 1, context.pos);
    if (q.length > 24 || /\s{2}/.test(q)) return null;
    const items = slashItems(ctx).map((it) => ({
      label: it.label, match: [it.label, ...(it.keywords ?? "").split(" ")], section: SECTIONS[it.section],
      type: `slash ${it.icon}`,
      apply: (view, _c, from, to) => {
        view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from }, userEvent: "input.complete" });
        it.run();
      },
    }));
    const options = q ? rank(q, items) : items;
    if (!options.length) return null;
    return { from: slash, options, filter: false };
  };
}

/** The completion extension. */
export function completion(ctx) {
  return autocompletion({
    override: [slashSource(ctx), linkSource(ctx), tagSource(ctx)],
    icons: true,
    closeOnBlur: true,
    maxRenderedOptions: 60,
    tooltipClass: () => "cm-wiki-complete",
    optionClass: (c) => (c.type === "new" ? "cm-complete-new" : ""),
    addToOptions: [{
      render: (c) => {
        if (!c.type?.startsWith("slash ")) return null;
        const span = document.createElement("span");
        span.className = "cm-slash-icon";
        span.innerHTML = ctx.svg(c.type.slice(6));
        return span;
      },
      position: 20,
    }],
  });
}

export { startCompletion, formatDate };
