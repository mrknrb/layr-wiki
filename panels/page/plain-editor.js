// A plain text box with part A's editor API (PLAN.md › The editor), for when panels/editor/index.js can't load: the
// page can still be written, saved and formatted with the basic commands.
import { textStats } from "../../shared/markdown.js";
import { el, icon } from "../app/dom.js";

const WRAPS = {
  bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], underline: ["<u>", "</u>"], highlight: ["==", "=="],
  code: ["`", "`"], sup: ["<sup>", "</sup>"], sub: ["<sub>", "</sub>"], link: ["[[", "]]"], math: ["$", "$"],
};
const PREFIXES = { bullet: "- ", numbered: "1. ", task: "- [ ] ", quote: "> " };

export function createPlainEditor(parent, { doc = "", onChange, onSave, upload, readOnly = false, app } = {}) {
  const listeners = new Map();
  const fire = (type, data) => (listeners.get(type) ?? []).forEach((fn) => fn(data));
  const text = el("textarea", { class: "wiki-plain-editor", spellcheck: String(app?.settings?.get?.("spellcheck") ?? true),
    placeholder: "Write in Markdown. [[ links to a page, ![[picture.png]] shows a picture, # makes a heading." });
  text.value = doc;
  text.readOnly = readOnly;
  const grow = () => {
    text.style.height = "auto";
    text.style.height = `${Math.max(240, text.scrollHeight + 4)}px`;
  };
  const changed = () => {
    grow();
    onChange?.(text.value);
    fire("change", text.value);
  };
  text.addEventListener("input", changed);
  text.addEventListener("focus", () => fire("focus"));
  text.addEventListener("blur", () => fire("blur"));
  const selected = () => {
    const sel = { ...api.selection(), rect: null };
    sel.empty = sel.from === sel.to;
    // The app passes it on as its "selection" topic (the app.editor setter).
    fire("selection", sel);
  };
  text.addEventListener("select", selected);
  text.addEventListener("keyup", (e) => e.shiftKey && selected());
  text.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      api.exec("bold");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      api.exec("italic");
    }
  });
  const drop = async (list, e) => {
    if (!list.length || !upload) return;
    e.preventDefault();
    const names = await upload(list);
    api.insert(names.map((n) => `![[${n}]]`).join("\n"));
  };
  text.addEventListener("paste", (e) => drop([...(e.clipboardData?.files ?? [])], e));
  text.addEventListener("dragover", (e) => e.preventDefault());
  text.addEventListener("drop", (e) => drop([...(e.dataTransfer?.files ?? [])], e));
  parent.replaceChildren(text);
  setTimeout(grow, 0);

  const replace = (from, to, insert, selectInner = null) => {
    text.setRangeText(insert, from, to, "end");
    if (selectInner) text.setSelectionRange(selectInner[0], selectInner[1]);
    text.focus();
    changed();
  };
  const api = {
    plain: true,
    getText: () => text.value,
    setText(value, { keepCursor = false } = {}) {
      const [s, e] = [text.selectionStart, text.selectionEnd];
      text.value = value;
      if (keepCursor) text.setSelectionRange(Math.min(s, value.length), Math.min(e, value.length));
      grow();
    },
    focus: () => text.focus(),
    destroy: () => text.remove(),
    selection: () => ({ from: text.selectionStart, to: text.selectionEnd,
      text: text.value.slice(text.selectionStart, text.selectionEnd) }),
    replaceSelection: (s) => replace(text.selectionStart, text.selectionEnd, s),
    insert: (s) => replace(text.selectionStart, text.selectionEnd, s),
    exec(cmd, arg) {
      const { from, to, text: sel } = api.selection();
      if (cmd === "color" && arg) return replace(from, to, `<span style="color:${arg}">${sel}</span>`);
      if (cmd === "highlight" && arg) return replace(from, to, `<mark style="background:${arg}">${sel}</mark>`);
      if (WRAPS[cmd]) {
        const [a, b] = WRAPS[cmd];
        return replace(from, to, a + sel + b, [from + a.length, from + a.length + sel.length]);
      }
      const lineStart = text.value.lastIndexOf("\n", from - 1) + 1;
      if (cmd === "heading") return replace(lineStart, lineStart, `${"#".repeat(Number(arg) || 2)} `);
      if (PREFIXES[cmd]) return replace(lineStart, lineStart, PREFIXES[cmd]);
      if (cmd === "callout") return replace(lineStart, lineStart, `> [!${arg || "note"}] `);
      if (cmd === "hr") return replace(from, to, "\n---\n");
      if (cmd === "codeblock") return replace(from, to, `\n\`\`\`${arg ?? ""}\n${sel}\n\`\`\`\n`);
      if (cmd === "table") return replace(from, to, "\n| Column | Column |\n| --- | --- |\n|  |  |\n");
      if (cmd === "undo" || cmd === "redo") return document.execCommand(cmd);
      return undefined;
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    stats: () => textStats(text.value),
    toolbar(host) {
      const b = (name, title, cmd, arg) => el("button", { class: "layr-button ghost icon small", title,
        "aria-label": title, onmousedown: (e) => e.preventDefault(), onclick: () => api.exec(cmd, arg) }, icon(name));
      const bar = el("div", { class: "wiki-plain-toolbar" },
        b("bold", "Bold", "bold"), b("italic", "Italic", "italic"), b("strikethrough", "Strikethrough", "strike"),
        b("highlighter", "Highlight", "highlight"), b("heading-2", "Heading", "heading", 2), b("list", "List", "bullet"),
        b("list-checks", "Checklist", "task"), b("quote", "Quote", "quote"), b("link", "Link to a page", "link"),
        b("code", "Code", "code"));
      host.append(bar);
      return bar;
    },
    scrollToHeading(heading) {
      const at = text.value.split("\n").findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim() === heading);
      if (at < 0) return;
      const pos = text.value.split("\n").slice(0, at).join("\n").length + (at ? 1 : 0);
      text.focus();
      text.setSelectionRange(pos, pos);
      const line = parseFloat(getComputedStyle(text).lineHeight) || 20;
      text.scrollIntoView({ block: "nearest" });
      text.closest(".wiki-view-root")?.parentElement?.scrollBy?.({ top: at * line - 80 });
    },
    scrollToLine(line) {
      const lines = text.value.split("\n");
      const pos = lines.slice(0, Math.max(0, line)).join("\n").length + (line > 0 ? 1 : 0);
      text.focus();
      text.setSelectionRange(pos, pos);
    },
    setMode() {},
  };
  return api;
}
