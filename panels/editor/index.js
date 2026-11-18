// The wiki's editor: CodeMirror 6 with an Obsidian-style live preview (Markdown formatted while you write, the syntax
// showing only where the selection is), a source mode, completion of links, headings, tags and a "/" menu, a table
// editor, pictures and embedded pages, and a formatting toolbar for the PC and the phone. The text stays Markdown.
//
//   const ed = await createEditor(parent, {
//     doc, app, page,                  // the text; the panel's app (settings, files, wiki); the page edited
//     mode: "live" | "source",         // default: settings.editorMode
//     onChange(text),                  // every change made in the editor (not those made by setText)
//     onSave(),                        // Ctrl+S
//     resolve(target) → {title, exists},  // how a [[link]] shows (default: app.wiki.resolve)
//     upload(files) → Promise<names>,  // pasted/dropped/picked files (default: app.files.upload each)
//     readOnly,
//     onProperties() → true?,          // a click on the folded properties line; return true when handled (else the
//                                      //   YAML opens as text)
//   });
//   ed.getText(); ed.setText(text, {keepCursor}); ed.focus(); ed.destroy();
//   ed.exec(cmd, arg)   // bold italic strike underline highlight(color?|null) color(color|null) sup sub code
//                       // link(url?) heading(n) paragraph bullet numbered task toggleTask quote callout(kind)
//                       // table([cols, rows]?) hr codeblock(lang) math image embed indent outdent undo redo find replace
//   ed.selection() → {from, to, text}; ed.replaceSelection(text); ed.insert(text);
//   ed.on("selection" | "change" | "focus" | "blur", fn) → off
//       selection: {from, to, text, empty, rect: {left, top, right, bottom, width, height} | null} (viewport px),
//       also sent as app.emit("selection", {...that, editor: ed}); change: the text
//   ed.stats() → {words, chars, readingMinutes, selection?: {words, chars, readingMinutes}}
//   ed.toolbar(parent) → element      // element.destroy() removes it; it floats above the keyboard at phone width
//   ed.scrollToHeading(text); ed.setMode("live" | "source")
// More: ed.view (the EditorView), ed.mode(), ed.setReadOnly(bool), ed.refresh() (redraw links and embeds; also done
// on app "changed"), ed.upload(files), ed.formatState() (what the toolbar shows), ed.headingLevel(), ed.lineText().
//
// Also exported: `highlight(code, lang)` and `languageFor(name)` (code highlighting, classes `tok-*`), and
// `ensureStyles()` (adds editor.css, whose `tok-*` colours the reading view can use too).
import {
  Compartment, EditorSelection, EditorState, EditorView, GFM, Prec, Transaction, Annotation, classHighlighter,
  closeBrackets, closeBracketsKeymap, commonmarkLanguage, crosshairCursor, defaultKeymap, drawSelection, dropCursor,
  highlightSpecialChars, history, historyKeymap, indentUnit, keymap, languageFor, lineNumbers, markdown, placeholder,
  rectangularSelection, redoDepth, search, searchKeymap, syntaxHighlighting, undoDepth,
} from "../../vendor/editor.js";
import { normalizeSettings } from "../../shared/settings.js";
import { splitFrontmatter } from "../../shared/frontmatter.js";
import { keyOf, slug } from "../../shared/links.js";
import { isImageName, renderMarkdown } from "../../shared/markdown.js";
import { WIKI_SYNTAX } from "./syntax.js";
import { liveBase, livePreview, refreshEffect } from "./live.js";
import { commandTable, editorKeymap, inCode, insertText } from "./commands.js";
import { completion } from "./complete.js";
import { createToolbar } from "./toolbar.js";
import { htmlToMarkdown, worthConverting } from "./paste.js";
import { activeFormats, countWords, formatDate as ownFormatDate, headingsOf, listPrefix, sectionOf } from "./markdown-ops.js";
import { svg } from "./dom.js";

export { highlight, languageFor } from "../../vendor/editor.js";

/** Add editor.css to the page once (the editor does it itself; the reading view may call it for `tok-*`). */
export function ensureStyles() {
  if (typeof document === "undefined" || document.querySelector("link[data-wiki-editor-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./editor.css", import.meta.url).href;
  link.dataset.wikiEditorCss = "";
  document.head.append(link);
}
ensureStyles();

/** The search panel's words in the wiki's style. */
const PHRASES = {
  Find: "Find", Replace: "Replace with", next: "Next", previous: "Previous", all: "All", "match case": "Match case",
  regexp: "Regex", "by word": "Whole words", replace: "Replace", "replace all": "Replace all", close: "Close",
};

/** Changes made by setText (another device, the AI): not the user's typing, so no onChange. */
const External = Annotation.define();

let templatesModule;
const loadTemplates = () =>
  (templatesModule ??= import("../../shared/templates.js").catch(() => null));

const pastedName = (file) => {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new File([file], `Pasted ${stamp}.${ext}`, { type: file.type });
};

export async function createEditor(parent, opts = {}) {
  const app = opts.app ?? null;
  const templates = await loadTemplates();
  const listeners = new Map();
  const emit = (name, data) => {
    for (const fn of listeners.get(name) ?? []) {
      try {
        fn(data);
      } catch (error) {
        console.error(error);
      }
    }
  };
  const settings = () => normalizeSettings(app?.settings?.all?.() ?? null);
  let filesCache = null;

  const ctx = {
    app,
    page: opts.page ?? null,
    svg,
    settings,
    setting: (id) => settings()[id],
    onSave: () => opts.onSave?.(),
    onProperties: opts.onProperties,
    fail: (error) => (app?.ui?.fail ? app.ui.fail(error) : console.error(error)),
    pages: () => app?.wiki?.live?.() ?? [],
    findPage: (target) => app?.wiki?.resolve?.(target) ?? null,
    resolve: (target) => {
      if (opts.resolve) return opts.resolve(target);
      const p = app?.wiki?.resolve?.(target);
      return p ? { title: p.title, exists: true } : { title: target, exists: !app?.wiki };
    },
    attachments: async () => {
      if (!app?.files?.list) return [];
      if (!filesCache || Date.now() - filesCache.at > 20000) {
        filesCache = { at: Date.now(), list: app.files.list().catch(() => []) };
      }
      return filesCache.list;
    },
    openLink: (target, heading, newTab) => app?.openPage?.(target, { heading: heading ?? undefined, newTab: !!newTab }),
    openTag: (tag) => app?.open?.({ view: "search", query: `#${tag}` }),
    openUrl: (url) => (app?.openUrl ? app.openUrl(url) : window.open(url, "_blank", "noopener,noreferrer")),
    renderEmbed: (el, page, heading) => {
      const text = heading ? sectionOf(page.body, heading) : page.body;
      if (text === null || text === undefined) {
        el.innerHTML = `<p class="cm-embed-note">No heading “${heading.replace(/[<&]/g, "")}” on this page.</p>`;
        return;
      }
      if (!text.trim()) {
        el.innerHTML = '<p class="cm-embed-note">This page is empty.</p>';
        return;
      }
      try {
        if (app?.markdown) return app.markdown(el, text, { page, depth: 1 });
      } catch (error) {
        console.error(error);
      }
      el.innerHTML = renderMarkdown(text, { resolve: ctx.resolve });
    },
    formatDate: (date, format) => (templates?.formatDate ?? ownFormatDate)(date, format),
    templates: () => {
      try {
        return app?.wiki?.templates?.(settings()) ?? [];
      } catch {
        return [];
      }
    },
    insertTemplate: (t) => {
      const body = t.body ?? splitFrontmatter(t.markdown ?? "").body;
      const filled = templates?.fillTemplate
        ? templates.fillTemplate(body, { title: ctx.page?.title ?? "", date: new Date(), settings: settings() })
        : body.replace(/\{\{title\}\}/g, ctx.page?.title ?? "")
          .replace(/\{\{date(?::([^}]+))?\}\}/g, (_m, f) => ctx.formatDate(new Date(), f || settings().dateFormat))
          .replace(/\{\{time(?::([^}]+))?\}\}/g, (_m, f) => ctx.formatDate(new Date(), f || settings().timeFormat));
      insertText(view, filled, "input.template");
    },
    exec: (cmd, arg) => api.exec(cmd, arg),
    insert: (text) => insertText(view, text),
    pickAndUpload: () => {
      pickFiles().then((files) => files?.length && uploadFiles(files)).catch(ctx.fail);
      return true;
    },
  };

  async function pickFiles() {
    if (app?.pickFiles) return [...((await app.pickFiles({ multiple: true })) ?? [])];
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
      input.style.display = "none";
      input.addEventListener("change", () => {
        resolve([...input.files]);
        input.remove();
      });
      document.body.append(input);
      input.click();
    });
  }

  /** Upload files and put a link to each where they were dropped (or at the cursor): pictures and PDFs embedded. */
  async function uploadFiles(list, at = null) {
    const files = [...list].map(pastedName);
    if (!files.length || view.state.readOnly) return [];
    let names;
    try {
      if (opts.upload) names = await opts.upload(files);
      else if (app?.files?.upload) {
        names = [];
        for (const f of files) names.push((await app.files.upload(f.name, await f.arrayBuffer(), f.type || null)).name);
      } else throw new Error("Files can't be added here");
    } catch (error) {
      ctx.fail(error);
      return [];
    }
    names = (names ?? []).filter(Boolean);
    if (!names.length) return [];
    filesCache = null;
    const text = names.map((n) => (isImageName(n) || /\.pdf$/i.test(n) ? `![[${n}]]` : `[[${n}]]`)).join("\n");
    if (at !== null) {
      const pos = Math.min(at, view.state.doc.length);
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length }, userEvent: "input.drop" });
    } else insertText(view, text, "input.paste");
    return names;
  }

  // ---------- configuration ----------

  const s0 = settings();
  let mode = opts.mode ?? s0.editorMode ?? "live";
  let lastModeSetting = s0.editorMode;
  let readOnly = !!opts.readOnly;
  const c = {
    live: new Compartment(),
    attrs: new Compartment(),
    spell: new Compartment(),
    numbers: new Compartment(),
    tab: new Compartment(),
    pair: new Compartment(),
    ro: new Compartment(),
  };
  const conf = {
    live: () => (mode === "live" ? livePreview(ctx) : []),
    attrs: () => EditorView.editorAttributes.of({ class: `cm-wiki cm-mode-${mode}` }),
    spell: (s) => EditorView.contentAttributes.of({ spellcheck: s.spellcheck ? "true" : "false",
      autocorrect: s.spellcheck ? "on" : "off", autocapitalize: "sentences" }),
    numbers: (s) => (s.lineNumbers ? lineNumbers() : []),
    tab: (s) => [EditorState.tabSize.of(s.tabSize), indentUnit.of(" ".repeat(s.tabSize))],
    pair: (s) => (s.autoPair ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : []),
    ro: () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)],
  };

  let selTimer = 0;
  const sendSelection = (v) => {
    if (selTimer) return;
    selTimer = requestAnimationFrame(() => {
      selTimer = 0;
      if (destroyed) return;
      v.requestMeasure({
        read(view2) {
          const sel = view2.state.selection.main;
          const a = view2.coordsAtPos(sel.from, 1);
          const b = sel.empty ? a : view2.coordsAtPos(sel.to, -1);
          let rect = null;
          if (a && b) {
            const left = sel.empty || a.top === b.top ? Math.min(a.left, b.left) : view2.contentDOM.getBoundingClientRect().left;
            const right = sel.empty || a.top === b.top ? Math.max(a.right, b.right)
              : view2.contentDOM.getBoundingClientRect().right;
            rect = { left, top: a.top, right, bottom: b.bottom, width: right - left, height: b.bottom - a.top };
          }
          return { from: sel.from, to: sel.to, text: view2.state.sliceDoc(sel.from, sel.to), empty: sel.empty, rect };
        },
        write(data) {
          // The shell passes the active editor's selections on as app "selection" (app.editor's setter).
          emit("selection", data);
        },
      });
    });
  };

  let destroyed = false;
  const commands = commandTable(ctx);
  const state = EditorState.create({
    doc: String(opts.doc ?? ""),
    extensions: [
      liveBase,
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      rectangularSelection(),
      crosshairCursor(),
      EditorView.lineWrapping,
      markdown({ base: commonmarkLanguage, extensions: [GFM, ...WIKI_SYNTAX], codeLanguages: (info) => languageFor(info),
        addKeymap: false, completeHTMLTags: false }),
      syntaxHighlighting(classHighlighter),
      search({ top: true }),
      EditorState.phrases.of(PHRASES),
      completion(ctx),
      Prec.high(keymap.of(editorKeymap(ctx, (_view, cmd, arg) => api.exec(cmd, arg)))),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
      placeholder("Start writing… “/” for blocks, “[[” to link a page"),
      c.live.of(conf.live()),
      c.attrs.of(conf.attrs()),
      c.spell.of(conf.spell(s0)),
      c.numbers.of(conf.numbers(s0)),
      c.tab.of(conf.tab(s0)),
      c.pair.of(conf.pair(s0)),
      c.ro.of(conf.ro()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const own = u.transactions.some((tr) => tr.docChanged && !tr.annotation(External));
          if (own) {
            const text = u.state.doc.toString();
            opts.onChange?.(text);
            emit("change", text);
          }
        }
        if (u.selectionSet || u.docChanged || u.focusChanged) sendSelection(u.view);
        if (u.focusChanged) emit(u.view.hasFocus ? "focus" : "blur");
      }),
      EditorView.domEventHandlers({
        paste(e, v) {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length) {
            e.preventDefault();
            uploadFiles(files);
            return true;
          }
          const html = e.clipboardData?.getData("text/html");
          if (html && worthConverting(html) && !inCode(v.state, v.state.selection.main.head)) {
            const md = htmlToMarkdown(html);
            if (md) {
              e.preventDefault();
              insertText(v, md, "input.paste");
              return true;
            }
          }
          return false;
        },
        drop(e, v) {
          const files = [...(e.dataTransfer?.files ?? [])];
          if (!files.length) return false;
          e.preventDefault();
          uploadFiles(files, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head);
          return true;
        },
      }),
    ],
  });
  const view = new EditorView({ state, parent });

  const applySettings = () => {
    if (destroyed) return;
    const s = settings();
    const effects = [
      c.spell.reconfigure(conf.spell(s)),
      c.numbers.reconfigure(conf.numbers(s)),
      c.tab.reconfigure(conf.tab(s)),
      c.pair.reconfigure(conf.pair(s)),
    ];
    view.dispatch({ effects });
    if (s.editorMode !== lastModeSetting) {
      lastModeSetting = s.editorMode;
      api.setMode(s.editorMode);
    } else view.dispatch({ effects: refreshEffect.of(null) });
  };
  const offSettings = app?.settings?.on?.(applySettings);
  let refreshTimer = null;
  const offChanged = app?.on?.("changed", () => {
    clearTimeout(refreshTimer);
    filesCache = null;
    refreshTimer = setTimeout(() => !destroyed && view.dispatch({ effects: refreshEffect.of(null) }), 120);
  });
  const toolbars = new Set();

  const api = {
    view,
    getText: () => view.state.doc.toString(),
    setText(text, { keepCursor = true } = {}) {
      const next = String(text ?? "");
      const old = view.state.doc.toString();
      if (old === next) return;
      let a = 0;
      while (a < old.length && a < next.length && old[a] === next[a]) a++;
      let b = 0;
      while (b < old.length - a && b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
      view.dispatch({
        changes: { from: a, to: old.length - b, insert: next.slice(a, next.length - b) },
        selection: keepCursor ? undefined : EditorSelection.cursor(0),
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
      });
    },
    focus() {
      // A cursor still at the very top would open the properties block as text: start after it instead.
      const sel = view.state.selection.main;
      if (sel.empty && sel.head === 0 && !view.hasFocus) {
        const m = /^---[ \t]*\n[\s\S]*?\n(---|\.\.\.)[ \t]*(\n|$)/.exec(view.state.sliceDoc(0, 200000));
        if (m) view.dispatch({ selection: { anchor: Math.min(m[0].length, view.state.doc.length) } });
      }
      view.focus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offSettings?.();
      offChanged?.();
      clearTimeout(refreshTimer);
      for (const t of toolbars) t.destroy();
      listeners.clear();
      view.destroy();
    },
    exec(cmd, arg) {
      const fn = commands[cmd];
      if (!fn) throw new Error(`No editor command ${cmd}`);
      return fn(view, arg);
    },
    selection() {
      const { from, to } = view.state.selection.main;
      return { from, to, text: view.state.sliceDoc(from, to) };
    },
    replaceSelection: (text) => insertText(view, String(text ?? "")),
    insert(text) {
      const { head } = view.state.selection.main;
      if (view.state.readOnly) return false;
      view.dispatch({ changes: { from: head, insert: String(text ?? "") }, selection: { anchor: head + String(text ?? "").length },
        scrollIntoView: true, userEvent: "input" });
      return true;
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    stats() {
      const out = countWords(view.state.doc.toString());
      const { from, to } = view.state.selection.main;
      if (to > from) out.selection = countWords(view.state.sliceDoc(from, to));
      return out;
    },
    toolbar(toolbarParent) {
      const bar = createToolbar(api, ctx, toolbarParent);
      const destroy = bar.destroy;
      bar.destroy = () => {
        toolbars.delete(bar);
        destroy();
      };
      toolbars.add(bar);
      return bar;
    },
    scrollToHeading(text) {
      const want = slug(text);
      const wantKey = keyOf(text);
      const hd = headingsOf(view.state.doc.toString()).find((x) => slug(x.text) === want || keyOf(x.text) === wantKey);
      if (!hd) return false;
      const line = view.state.doc.line(hd.line + 1);
      view.dispatch({ selection: { anchor: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }) });
      return true;
    },
    mode: () => mode,
    setMode(next) {
      const m = next === "source" ? "source" : "live";
      if (m === mode) return;
      mode = m;
      view.dispatch({ effects: [c.live.reconfigure(conf.live()), c.attrs.reconfigure(conf.attrs())] });
    },
    setReadOnly(on) {
      readOnly = !!on;
      view.dispatch({ effects: c.ro.reconfigure(conf.ro()) });
    },
    refresh: () => view.dispatch({ effects: refreshEffect.of(null) }),
    upload: (files) => uploadFiles(files),
    lineText: () => view.state.doc.lineAt(view.state.selection.main.head).text,
    headingLevel: () => /^(#{1,6})\s/.exec(api.lineText())?.[1].length ?? 0,
    formatState() {
      const st = view.state;
      const sel = st.selection.main;
      const line = st.doc.lineAt(sel.from);
      const formats = sel.to <= line.to ? activeFormats(line.text, sel.from - line.from, sel.to - line.from) : new Set();
      const p = listPrefix(line.text);
      return {
        formats,
        heading: /^(#{1,6})\s/.exec(line.text)?.[1].length ?? 0,
        list: p?.marker ? (p.task ? "task" : p.number !== null ? "numbered" : "bullet") : null,
        quote: /^\s*>/.test(line.text),
        canUndo: undoDepth(st) > 0,
        canRedo: redoDepth(st) > 0,
      };
    },
  };
  return api;
}
