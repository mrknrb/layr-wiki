// Live preview: the Markdown formatted while you write, the way Obsidian does it. Marks (`**`, `[[`, `#`, `>`…) are
// hidden and the text styled, except where the selection touches them, so the syntax shows exactly where you edit.
// Inline things are decorations of the visible part (a view plugin); tables, `$$` math and the properties block are
// block widgets (a state field, as CodeMirror wants block decorations). `ctx` is the editor's context (index.js).
import {
  Decoration, EditorView, StateEffect, StateField, ViewPlugin, WidgetType, syntaxTree,
} from "../../vendor/editor.js";
import { isFileTarget, parseLink } from "../../shared/links.js";
import { isImageName } from "../../shared/markdown.js";
import { htmlSpans, parseEmbed, setEmbedWidth } from "./markdown-ops.js";
import { h, svg } from "./dom.js";
import { TableWidget } from "./table.js";

/** Redraw the decorations (the wiki changed: links resolve differently, an embedded page changed). */
export const refreshEffect = StateEffect.define();

// The selection only shows the syntax once the user has been in the editor: a page opens fully formatted even though
// its cursor starts at the top.
const touched = StateEffect.define();
export const engaged = StateField.define({
  create: () => false,
  update: (v, tr) => v || tr.effects.some((e) => e.is(touched)) || (tr.selection !== undefined && tr.isUserEvent("select")),
});
const engage = EditorView.focusChangeEffect.of((state, focusing) => (focusing && !state.field(engaged) ? touched.of(true) : null));

/** Does the selection touch [from, to]? Then its syntax shows. */
export function revealed(state, from, to) {
  if (!state.field(engaged, false)) return false;
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}
const lineRevealed = (state, pos) => {
  const line = state.doc.lineAt(pos);
  return revealed(state, line.from, line.to);
};

export const CALLOUT_ICONS = {
  note: "pencil", info: "info", tip: "flame", hint: "flame", important: "flame", success: "check", check: "check",
  done: "check", question: "circle-help", help: "circle-help", faq: "circle-help", warning: "triangle-alert",
  caution: "triangle-alert", attention: "triangle-alert", failure: "x", fail: "x", missing: "x", danger: "zap",
  error: "zap", bug: "bug", example: "list", quote: "quote", cite: "quote", abstract: "clipboard-list",
  summary: "clipboard-list", tldr: "clipboard-list", todo: "circle-check",
};

// ---------- small widgets ----------

class BulletWidget extends WidgetType {
  toDOM() {
    return h("span", { class: "cm-bullet", "aria-hidden": "true" }, "•");
  }
  eq() {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(o) {
    return o.checked === this.checked;
  }
  toDOM(view) {
    const box = h("input", { type: "checkbox", class: "cm-task-box", "aria-label": "Done" });
    box.checked = this.checked;
    const wrap = h("span", { class: "cm-task-wrap" }, box);
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(wrap);
      const ch = view.state.sliceDoc(pos + 1, pos + 2);
      if (view.state.sliceDoc(pos, pos + 1) !== "[") return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: ch === " " ? "x" : " " }, userEvent: "input.task" });
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class TextWidget extends WidgetType {
  constructor(text, cls) {
    super();
    this.text = text;
    this.cls = cls;
  }
  eq(o) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    return h("span", { class: this.cls }, this.text);
  }
}

class CalloutWidget extends WidgetType {
  constructor(kind, title) {
    super();
    this.kind = kind;
    this.title = title;
  }
  eq(o) {
    return o.kind === this.kind && o.title === this.title;
  }
  toDOM() {
    return h("span", { class: "cm-callout-head" },
      h("span", { class: "cm-callout-icon", html: svg(CALLOUT_ICONS[this.kind] ?? "pencil") }),
      this.title ? h("span", { class: "cm-callout-title cm-callout-default" }, this.title) : null);
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return h("span", { class: "cm-hr", "aria-hidden": "true" });
  }
}

class FenceWidget extends WidgetType {
  constructor(lang, end) {
    super();
    this.lang = lang;
    this.end = end;
  }
  eq(o) {
    return o.lang === this.lang && o.end === this.end;
  }
  toDOM(view) {
    if (this.end) return h("span", { class: "cm-fence-end" });
    const copy = h("button", { class: "cm-fence-copy", type: "button", title: "Copy the code", html: svg("copy") });
    const wrap = h("span", { class: "cm-fence-head" }, h("span", { class: "cm-fence-lang" }, this.lang || ""), copy);
    copy.addEventListener("mousedown", (e) => e.preventDefault());
    copy.addEventListener("click", () => {
      const pos = view.posAtDOM(wrap);
      let node = syntaxTree(view.state).resolve(pos, 1);
      while (node && node.name !== "FencedCode") node = node.parent;
      if (!node) return;
      const code = node.getChildren("CodeText").map((n) => view.state.sliceDoc(n.from, n.to)).join("\n");
      navigator.clipboard?.writeText(code).then(() => {
        copy.innerHTML = svg("check");
        setTimeout(() => (copy.innerHTML = svg("copy")), 1200);
      }).catch(() => {});
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------- images, files and embedded pages ----------

const imageCache = new Map();
/** An attachment's blob URL (loaded once per panel). */
export function imageUrl(app, name) {
  const key = String(name).toLowerCase();
  if (!imageCache.has(key)) {
    const p = Promise.resolve()
      .then(() => {
        if (!app?.files?.download) throw new Error("Attachments aren't available here");
        return app.files.download(name);
      })
      .then(({ record, bytes }) => URL.createObjectURL(new Blob([bytes], { type: record?.mime || undefined })));
    p.catch(() => imageCache.delete(key));
    imageCache.set(key, p);
  }
  return imageCache.get(key);
}

/** Open an attachment: the page part's viewer when there is one, else the file in a new window. */
export async function openFile(ctx, name) {
  const app = ctx.app;
  try {
    if (app?.openAttachment) return await app.openAttachment(name);
    const url = await imageUrl(app, name);
    window.open(url, "_blank", "noopener");
  } catch (error) {
    ctx.fail(error);
  }
}

class ImageWidget extends WidgetType {
  constructor(ctx, inner, external = null) {
    super();
    this.ctx = ctx;
    this.inner = inner;
    this.external = external; // {url, alt} for ![alt](https://…)
    this.info = external ? { target: external.url, caption: null, width: external.width ?? null } : parseEmbed(inner);
  }
  eq(o) {
    return o.inner === this.inner && o.external?.url === this.external?.url;
  }
  get estimatedHeight() {
    return 200;
  }
  toDOM(view) {
    const { target, caption, width } = this.info;
    const showCaption = caption && this.ctx.setting("captions") !== false;
    const img = h("img", { alt: caption ?? target, draggable: "false" });
    if (width) img.style.width = `${width}px`;
    const handle = h("span", { class: "cm-image-resize", title: "Drag to resize" });
    const fig = h("span", { class: `cm-image${showCaption ? " has-caption" : ""}`, "data-file": target },
      h("span", { class: "cm-image-frame" }, img, this.external ? null : handle),
      showCaption ? h("span", { class: "cm-image-caption" }, caption) : null);
    if (this.external) img.src = this.external.url;
    else {
      fig.classList.add("loading");
      imageUrl(this.ctx.app, target)
        .then((url) => {
          img.src = url;
          fig.classList.remove("loading");
        })
        .catch((error) => {
          fig.classList.remove("loading");
          fig.classList.add("broken");
          fig.querySelector(".cm-image-frame").replaceChildren(h("span", { class: "cm-image-missing" },
            h("span", { html: svg("image") }), ` ${target}`, h("small", {}, ` ${error?.message ?? "can't be shown"}`)));
        });
    }
    img.addEventListener("dblclick", () => (this.ctx.app?.viewImage ? this.ctx.app.viewImage(target) : null));
    img.addEventListener("click", (e) => {
      // A click puts the cursor after the picture (its source shows); the page part's viewer opens on a double-click.
      if (e.detail > 1) return;
      const pos = view.posAtDOM(fig);
      const end = view.state.doc.lineAt(pos).text.indexOf("]]", pos - view.state.doc.lineAt(pos).from);
      const at = end >= 0 ? view.state.doc.lineAt(pos).from + end + 2 : pos;
      view.dispatch({ selection: { anchor: at }, userEvent: "select" });
      view.focus();
    });
    if (!this.external) this.resizable(view, fig, img, handle);
    return fig;
  }
  /** Dragging the corner sets the width, written back as `![[pic.png|caption|400]]`. */
  resizable(view, fig, img, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (view.state.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const max = view.contentDOM.getBoundingClientRect().width;
      fig.classList.add("resizing");
      const move = (ev) => {
        img.style.width = `${Math.round(Math.max(40, Math.min(max, startW + ev.clientX - startX)))}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        fig.classList.remove("resizing");
        const w = Math.round(img.getBoundingClientRect().width);
        const pos = view.posAtDOM(fig);
        const line = view.state.doc.lineAt(pos);
        const rest = line.text.slice(pos - line.from);
        const m = /^!\[\[([^\[\]\n]+)\]\]/.exec(rest);
        if (!m || Math.abs(w - startW) < 2) return;
        const inner = setEmbedWidth(m[1], w);
        view.dispatch({ changes: { from: pos + 3, to: pos + 3 + m[1].length, insert: inner }, userEvent: "input.resize" });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }
  ignoreEvent() {
    return true;
  }
}

const FILE_ICONS = { pdf: "file-text", doc: "file-text", docx: "file-text", txt: "file-text", md: "file-text" };

class FileWidget extends WidgetType {
  constructor(ctx, target) {
    super();
    this.ctx = ctx;
    this.target = target;
  }
  eq(o) {
    return o.target === this.target;
  }
  toDOM() {
    const ext = this.target.split(".").pop().toLowerCase();
    const open = h("button", { class: "cm-file-open", type: "button" }, h("span", { html: svg("external-link") }), "Open");
    open.addEventListener("mousedown", (e) => e.preventDefault());
    open.addEventListener("click", () => openFile(this.ctx, this.target));
    const card = h("span", { class: "cm-file-card", "data-file": this.target },
      h("span", { class: "cm-file-icon", html: svg(FILE_ICONS[ext] ?? "paperclip") }),
      h("span", { class: "cm-file-name" }, this.target),
      h("span", { class: "cm-file-ext" }, ext.toUpperCase()),
      open);
    const box = h("span", { class: "cm-file" }, card);
    if (ext === "pdf" && this.ctx.app?.renderEmbed && this.ctx.setting("pdfInline") !== false) {
      const body = h("span", { class: "cm-file-body" });
      box.append(body);
      Promise.resolve().then(() => this.ctx.app.renderEmbed(body, this.target)).catch(() => body.remove());
    }
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class PageEmbedWidget extends WidgetType {
  constructor(ctx, target, heading, stamp) {
    super();
    this.ctx = ctx;
    this.target = target;
    this.heading = heading;
    this.stamp = stamp;
  }
  eq(o) {
    return o.target === this.target && o.heading === this.heading && o.stamp === this.stamp;
  }
  get estimatedHeight() {
    return 120;
  }
  toDOM() {
    const ctx = this.ctx;
    const page = ctx.findPage(this.target);
    const title = page?.title ?? this.target;
    const open = h("button", { class: "cm-embed-open", type: "button", title: "Open the page", html: svg("external-link") });
    open.addEventListener("mousedown", (e) => e.preventDefault());
    open.addEventListener("click", (e) => ctx.openLink(this.target, this.heading, e.ctrlKey || e.metaKey));
    const body = h("div", { class: "cm-embed-body md" });
    const box = h("div", { class: `cm-embed${page ? "" : " missing"}` },
      h("div", { class: "cm-embed-head" }, h("span", { html: svg("file-symlink") }),
        h("span", { class: "cm-embed-title" }, this.heading ? `${title} › ${this.heading}` : title), open),
      body);
    if (!page) body.append(h("p", { class: "cm-embed-note" }, `No page “${this.target}” yet.`));
    else if (ctx.page && page.id === ctx.page.id) body.append(h("p", { class: "cm-embed-note" }, "A page can't show itself."));
    else ctx.renderEmbed(body, page, this.heading);
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(o) {
    return o.text === this.text;
  }
  toDOM(view) {
    const el = h("div", { class: "cm-math-block", title: "Click to edit" }, this.text.trim() || "$$ $$");
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + 3 }, userEvent: "select" });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class FrontmatterWidget extends WidgetType {
  constructor(ctx, keys) {
    super();
    this.ctx = ctx;
    this.keys = keys;
  }
  eq(o) {
    return o.keys.join() === this.keys.join();
  }
  toDOM(view) {
    const el = h("div", { class: "cm-frontmatter-fold", role: "button", tabindex: "-1",
      title: "Properties: click to edit them as text" },
    h("span", { html: svg("chevron-down", "cm-fold-chevron") }), h("span", { class: "cm-fm-label" }, "Properties"),
    h("span", { class: "cm-fm-keys" }, this.keys.length ? this.keys.join(" · ") : "none"));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (this.ctx.onProperties?.() === true) return;
      view.dispatch({ selection: { anchor: Math.min(4, view.state.doc.length) }, userEvent: "select" });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------- the block widgets (state field) ----------

function buildBlocks(state, ctx) {
  const out = [];
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      const name = node.name;
      if (name === "Document") return true;
      if (name === "Frontmatter") {
        if (!revealed(state, node.from, node.to)) {
          const yaml = state.sliceDoc(node.from, node.to).split("\n").slice(1, -1);
          const keys = yaml.map((l) => /^([^\s:#][^:]*):/.exec(l)?.[1].trim()).filter(Boolean);
          out.push(Decoration.replace({ widget: new FrontmatterWidget(ctx, keys), block: true }).range(node.from, node.to));
        } else addLines(state, out, node.from, node.to, "cm-frontmatter");
        return false;
      }
      if (name === "Table") {
        const line = state.doc.lineAt(node.from);
        const end = state.doc.lineAt(node.to);
        if (line.from === node.from && !revealed(state, node.from, node.to)) {
          const text = state.sliceDoc(line.from, end.to);
          out.push(Decoration.replace({ widget: new TableWidget(ctx, text), block: true }).range(line.from, end.to));
        } else addLines(state, out, node.from, node.to, "cm-table-src");
        return false;
      }
      if (name === "BlockMath") {
        if (!revealed(state, node.from, node.to)) {
          const text = state.sliceDoc(node.from, node.to).replace(/^\s*\$\$\s*\n?/, "").replace(/\n?\s*\$\$\s*$/, "");
          out.push(Decoration.replace({ widget: new MathWidget(text), block: true }).range(node.from, node.to));
        } else addLines(state, out, node.from, node.to, "cm-math-src");
        return false;
      }
      return name === "Blockquote" || name === "BulletList" || name === "OrderedList" || name === "ListItem";
    },
  });
  return Decoration.set(out, true);
}

function addLines(state, out, from, to, cls) {
  for (let pos = from; pos <= to;) {
    const line = state.doc.lineAt(pos);
    out.push(Decoration.line({ class: cls }).range(line.from));
    pos = line.to + 1;
  }
}

// ---------- inline decorations (view plugin) ----------

const hide = Decoration.replace({});
const mark = (cls, attributes) => Decoration.mark({ class: cls, attributes });
const SKIP = new Set(["Frontmatter", "Table", "BlockMath"]);

function buildInline(view, ctx) {
  const { state } = view;
  const out = [];
  const tree = syntaxTree(state);
  const doc = state.doc;
  const add = (deco, from, to = from) => {
    if (from <= to) out.push(deco.range(from, to));
  };
  const lineDeco = (pos, cls, attributes) => add(Decoration.line({ class: cls, attributes }), doc.lineAt(pos).from);
  const hideIf = (on, from, to) => {
    if (on && from < to) add(hide, from, to);
  };
  const doneLines = new Set();

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(ref) {
        const name = ref.name;
        const node = ref.node;
        if (SKIP.has(name)) return false;
        if (/^ATXHeading\d$/.test(name)) {
          const level = Number(name.slice(-1));
          lineDeco(node.from, `cm-h cm-h${level}`);
          const hm = node.getChild("HeaderMark");
          if (hm && !lineRevealed(state, node.from)) {
            let end = hm.to;
            while (end < node.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
            add(hide, hm.from, end);
            const marks = node.getChildren("HeaderMark");
            if (marks.length > 1) {
              const last = marks[marks.length - 1];
              let start = last.from;
              while (start > hm.to && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
              add(hide, start, last.to);
            }
          }
          return true;
        }
        if (/^SetextHeading\d$/.test(name)) {
          const level = Number(name.slice(-1));
          for (let p = node.from; p <= node.to;) {
            const line = doc.lineAt(p);
            const isMark = node.getChild("HeaderMark")?.from >= line.from;
            lineDeco(line.from, isMark ? "cm-setext-mark" : `cm-h cm-h${level}`);
            p = line.to + 1;
          }
          return true;
        }
        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
          case "Highlight":
          case "InlineMath": {
            const cls = { Emphasis: "cm-em", StrongEmphasis: "cm-strong", Strikethrough: "cm-strike",
              Highlight: "cm-highlight", InlineMath: "cm-imath" }[name];
            add(mark(cls), node.from, node.to);
            const show = revealed(state, node.from, node.to);
            for (const m of node.getChildren(`${name === "StrongEmphasis" ? "Emphasis" : name.replace("Inline", "")}Mark`)) {
              hideIf(!show, m.from, m.to);
            }
            return true;
          }
          case "InlineCode": {
            add(mark("cm-icode"), node.from, node.to);
            const show = revealed(state, node.from, node.to);
            for (const m of node.getChildren("CodeMark")) hideIf(!show, m.from, m.to);
            return false;
          }
          case "WikiLink":
          case "WikiEmbed":
            wikiLink(node, name === "WikiEmbed");
            return false;
          case "Link":
            mdLink(node);
            return false;
          case "Image":
            mdImage(node);
            return false;
          case "Autolink":
          case "URL": {
            if (ref.node.parent?.name === "Link" || ref.node.parent?.name === "Image") return false;
            const url = doc.sliceString(node.from, node.to).replace(/^<|>$/g, "");
            const show = revealed(state, node.from, node.to);
            add(mark(`cm-url${show ? "" : " cm-live"}`, { "data-url": url }), node.from, node.to);
            if (name === "Autolink") for (const m of node.getChildren("LinkMark")) hideIf(!show, m.from, m.to);
            return false;
          }
          case "HashTag": {
            const tag = doc.sliceString(node.from + 1, node.to);
            const show = revealed(state, node.from, node.to);
            add(mark(`cm-tag${show ? "" : " cm-live"}`, { "data-tag": tag }), node.from, node.to);
            return false;
          }
          case "WikiComment":
            add(mark("cm-wiki-comment"), node.from, node.to);
            return false;
          case "Blockquote":
            quote(node);
            return true;
          case "ListItem":
            listItem(node);
            return true;
          case "FencedCode":
            fenced(node);
            return false;
          case "CodeBlock":
            for (let p = node.from; p <= node.to;) {
              const line = doc.lineAt(p);
              lineDeco(line.from, "cm-codeblock cm-indented-code");
              p = line.to + 1;
            }
            return false;
          case "HorizontalRule": {
            lineDeco(node.from, "cm-hr-line");
            if (!lineRevealed(state, node.from)) add(Decoration.replace({ widget: new HrWidget() }), node.from, node.to);
            return false;
          }
          case "Paragraph":
          case "Document":
          case "BulletList":
          case "OrderedList":
          case "Task":
            return true;
          default:
            return true;
        }
      },
    });
    // Inline HTML the wiki keeps (<u>, <sup>, <sub>, <mark style>, <span style="color">), line by line.
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (doneLines.has(line.from) || !line.text.includes("<")) continue;
      doneLines.add(line.from);
      for (const s of htmlSpans(line.text)) {
        const a = line.from + s.from;
        if (tree.resolve(a, 1).name !== "HTMLTag") continue;
        const style = [s.color ? `color:${s.color}` : "", s.background ? `background:${s.background}` : ""]
          .filter(Boolean).join(";");
        const cls = { u: "cm-u", sup: "cm-sup", sub: "cm-sub", mark: "cm-mark", span: "cm-color" }[s.tag];
        add(mark(cls, style ? { style } : undefined), line.from + s.openEnd, line.from + s.closeStart);
        const show = revealed(state, a, line.from + s.to);
        add(mark("cm-html-tag"), a, line.from + s.openEnd);
        add(mark("cm-html-tag"), line.from + s.closeStart, line.from + s.to);
        hideIf(!show, a, line.from + s.openEnd);
        hideIf(!show, line.from + s.closeStart, line.from + s.to);
      }
    }
  }

  function wikiLink(node, embed) {
    const t = node.getChild("WikiTarget");
    if (!t) return;
    const inner = doc.sliceString(t.from, t.to);
    const show = revealed(state, node.from, node.to);
    const { target: raw, heading, label } = parseLink(inner);
    const target = raw.replace(/\.md$/i, "");
    if (embed && target) {
      const widget = embedWidget(ctx, inner, target, heading);
      if (widget && !show) {
        add(Decoration.replace({ widget }), node.from, node.to);
        return;
      }
      add(mark("cm-embed-src"), node.from, node.to);
      if (widget && widget instanceof ImageWidget) add(Decoration.widget({ widget, side: 1 }), node.to);
      return;
    }
    const file = isFileTarget(target);
    const info = file ? { exists: true, title: target } : ctx.resolve(target);
    const cls = `cm-wikilink${file ? " cm-filelink" : ""}${info.exists ? "" : " cm-missing"}${show ? "" : " cm-live"}`;
    const attrs = { "data-target": target, ...(heading ? { "data-heading": heading } : {}),
      title: info.exists ? (file ? target : info.title) : `${target}: no page yet (click to create it)` };
    if (show) {
      add(mark("cm-wiki-mark"), node.from, t.from);
      add(mark(cls, attrs), t.from, t.to);
      add(mark("cm-wiki-mark"), t.to, node.to);
      return;
    }
    add(hide, node.from, t.from);
    add(hide, t.to, node.to);
    if (label !== null) {
      const pipe = inner.indexOf("|");
      add(hide, t.from, t.from + pipe + 1);
      add(mark(cls, attrs), t.from + pipe + 1, t.to);
    } else if (heading) {
      const hash = inner.indexOf("#");
      const left = inner.slice(0, hash).trimEnd().length;
      if (left) add(mark(cls, attrs), t.from, t.from + left);
      add(Decoration.replace({ widget: new TextWidget(left ? " › " : "§ ", "cm-link-sep") }), t.from + left, t.from + hash + 1);
      add(mark(cls, attrs), t.from + hash + 1, t.to);
    } else add(mark(cls, attrs), t.from, t.to);
  }

  function mdLink(node) {
    const marks = node.getChildren("LinkMark");
    const urlNode = node.getChild("URL");
    const show = revealed(state, node.from, node.to);
    if (marks.length < 2) return;
    const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "";
    const labelFrom = marks[0].to;
    const labelTo = marks[1].from;
    add(mark(`cm-link${show ? "" : " cm-live"}`, { "data-url": url, title: url }), labelFrom, labelTo);
    if (show) {
      add(mark("cm-link-src"), labelTo, node.to);
      return;
    }
    add(hide, marks[0].from, marks[0].to);
    add(hide, labelTo, node.to);
  }

  function mdImage(node) {
    const urlNode = node.getChild("URL");
    if (!urlNode) return;
    const url = doc.sliceString(urlNode.from, urlNode.to);
    const marks = node.getChildren("LinkMark");
    const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
    if (!/^(https?:|data:image\/)/i.test(url)) return;
    const size = /\|(\d{1,5})$/.exec(alt);
    const widget = new ImageWidget(ctx, null, { url, alt, width: size ? Number(size[1]) : null });
    if (revealed(state, node.from, node.to)) add(Decoration.widget({ widget, side: 1 }), node.to);
    else add(Decoration.replace({ widget }), node.from, node.to);
  }

  function quote(node) {
    const first = doc.lineAt(node.from);
    const m = /^\s*>\s*\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(first.text);
    const kind = m ? m[1].toLowerCase() : null;
    const last = doc.lineAt(node.to);
    const visible = view.visibleRanges;
    for (let p = node.from; p <= node.to;) {
      const line = doc.lineAt(p);
      p = line.to + 1;
      if (!visible.some((r) => line.to >= r.from && line.from <= r.to)) continue;
      const cls = kind
        ? `cm-callout${line.from === first.from ? " cm-callout-first" : ""}${line.from === last.from ? " cm-callout-last" : ""}`
        : `cm-quote${line.from === first.from ? " cm-quote-first" : ""}${line.from === last.from ? " cm-quote-last" : ""}`;
      lineDeco(line.from, cls, kind ? { "data-callout": kind } : undefined);
    }
    for (const qm of node.getChildren("QuoteMark")) quoteMark(qm);
    // Lazy continuation lines and nested quotes have their marks deeper in the tree.
    const cursor = node.cursor();
    while (cursor.next() && cursor.from < node.to) {
      if (cursor.name === "QuoteMark" && cursor.node.parent?.name !== "Blockquote") quoteMark(cursor.node);
    }
    if (kind) {
      const show = lineRevealed(state, first.from);
      const start = first.from + first.text.indexOf("[!");
      const end = start + 3 + m[1].length + m[2].length;
      const titleFrom = first.from + first.text.length - m[3].length;
      if (!show) {
        const title = m[3].trim() ? null : kind[0].toUpperCase() + kind.slice(1);
        add(Decoration.replace({ widget: new CalloutWidget(kind, title) }), start, Math.max(end, titleFrom));
      }
      if (m[3]) add(mark("cm-callout-title"), titleFrom, first.to);
    }
  }

  function quoteMark(qm) {
    if (lineRevealed(state, qm.from)) {
      add(mark("cm-quote-mark"), qm.from, qm.to);
      return;
    }
    let end = qm.to;
    if (doc.sliceString(end, end + 1) === " ") end++;
    add(hide, qm.from, end);
  }

  function listItem(node) {
    const lm = node.getChild("ListMark");
    if (!lm) return;
    const task = node.getChild("Task");
    const tm = task?.getChild("TaskMarker");
    const ordered = node.parent?.name === "OrderedList";
    lineDeco(lm.from, ordered ? "cm-li cm-li-ordered" : "cm-li");
    if (tm && doc.lineAt(tm.from).number === doc.lineAt(lm.from).number) {
      const checked = /\[[xX]\]/.test(doc.sliceString(tm.from, tm.to));
      if (checked) lineDeco(lm.from, "cm-task-done");
      lineDeco(lm.from, "cm-task-line");
      if (!revealed(state, lm.from, tm.to)) {
        if (!ordered) add(hide, lm.from, tm.from);
        else add(mark("cm-list-number"), lm.from, lm.to);
        add(Decoration.replace({ widget: new CheckboxWidget(checked) }), tm.from, tm.to);
      }
      return;
    }
    if (ordered) add(mark("cm-list-number"), lm.from, lm.to);
    else if (!revealed(state, lm.from, lm.to)) add(Decoration.replace({ widget: new BulletWidget() }), lm.from, lm.to);
    else add(mark("cm-list-mark"), lm.from, lm.to);
  }

  function fenced(node) {
    const first = doc.lineAt(node.from);
    const last = doc.lineAt(node.to);
    const show = revealed(state, node.from, node.to);
    const info = node.getChild("CodeInfo");
    const lang = info ? doc.sliceString(info.from, info.to) : "";
    for (let p = first.from; p <= last.to;) {
      const line = doc.lineAt(p);
      p = line.to + 1;
      const cls = `cm-codeblock${line.from === first.from ? " cm-codeblock-begin" : ""}` +
        `${line.from === last.from && last.number > first.number ? " cm-codeblock-end" : ""}`;
      lineDeco(line.from, cls);
    }
    if (show) return;
    const marks = node.getChildren("CodeMark");
    if (marks[0]) add(Decoration.replace({ widget: new FenceWidget(lang, false) }), node.from, first.to);
    if (marks.length > 1 && last.number > first.number) {
      add(Decoration.replace({ widget: new FenceWidget("", true) }), Math.max(last.from, marks[1].from), last.to);
    }
  }

  return Decoration.set(out, true);
}

/** The widget for `![[target]]`: a picture, a file card or an embedded page. */
function embedWidget(ctx, inner, target, heading) {
  if (isFileTarget(target)) {
    if (isImageName(target)) return new ImageWidget(ctx, inner);
    return new FileWidget(ctx, target);
  }
  const page = ctx.findPage(target);
  return new PageEmbedWidget(ctx, target, heading, page ? `${page.id}:${page.updated}` : "missing");
}

// ---------- clicks on links ----------

/** Where a mouse event lands on a link: `{kind, el}` or null. */
function linkAt(target) {
  const el = target instanceof Element ? target.closest(".cm-wikilink, .cm-link, .cm-url, .cm-tag") : null;
  if (!el) return null;
  return el;
}

function openFrom(el, ctx, newTab) {
  if (el.classList.contains("cm-wikilink")) {
    const target = el.dataset.target;
    if (el.classList.contains("cm-filelink")) return openFile(ctx, target);
    return ctx.openLink(target, el.dataset.heading ?? null, newTab);
  }
  if (el.classList.contains("cm-tag")) return ctx.openTag(el.dataset.tag);
  if (el.dataset.url) return ctx.openUrl(el.dataset.url);
}

/**
 * A click on a formatted link opens it (as in Obsidian); on a link whose syntax shows (the cursor is in it), a click
 * places the cursor and Ctrl+click opens. Ctrl+click or a middle click opens a page in a new tab.
 */
function linkClicks(ctx) {
  let pending = null;
  let hoverTimer = null;
  return EditorView.domEventHandlers({
    mousedown(e) {
      const el = linkAt(e.target);
      if (!el) return false;
      const mod = e.ctrlKey || e.metaKey;
      if (e.button === 1) {
        e.preventDefault();
        openFrom(el, ctx, true);
        return true;
      }
      if (e.button !== 0 || e.shiftKey || e.altKey) return false;
      if (!mod && !el.classList.contains("cm-live")) return false;
      e.preventDefault();
      pending = { el, x: e.clientX, y: e.clientY, mod };
      return true;
    },
    mouseup(e) {
      const p = pending;
      pending = null;
      if (!p || Math.abs(e.clientX - p.x) > 6 || Math.abs(e.clientY - p.y) > 6) return false;
      if (linkAt(e.target) !== p.el) return false;
      openFrom(p.el, ctx, p.mod);
      return true;
    },
    mouseover(e) {
      const el = linkAt(e.target);
      clearTimeout(hoverTimer);
      if (!el?.classList.contains("cm-wikilink") || el.classList.contains("cm-filelink")) return false;
      if (!ctx.app?.hoverPreview || ctx.setting("hoverPreview") === false) return false;
      if (!el.classList.contains("cm-live") && !(e.ctrlKey || e.metaKey)) return false;
      hoverTimer = setTimeout(() => {
        if (el.isConnected && el.matches(":hover")) ctx.app.hoverPreview(el, el.dataset.target);
      }, 450);
      return false;
    },
    mouseout() {
      clearTimeout(hoverTimer);
      return false;
    },
  });
}

/** The live preview's extensions. */
export function livePreview(ctx) {
  // The value remembers the syntax tree it was built from: the first parse may finish after the field was created.
  const build = (state) => ({ deco: buildBlocks(state, ctx), tree: syntaxTree(state) });
  const blocks = StateField.define({
    create: build,
    update(value, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== value.tree ||
        tr.effects.some((e) => e.is(refreshEffect) || e.is(touched))) return build(tr.state);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
  const inline = ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = buildInline(view, ctx);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect) || e.is(touched)))) {
        this.decorations = buildInline(u.view, ctx);
      }
    }
  }, { decorations: (v) => v.decorations });
  return [blocks, inline, linkClicks(ctx), EditorView.editorAttributes.of({ class: "cm-wiki-live" })];
}

/** What both modes need: the engaged state (and its focus hook). */
export const liveBase = [engaged, engage];
