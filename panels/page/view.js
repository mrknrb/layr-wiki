// The page view (route `page` {id, heading?, mode?}) and the missing page view (route `missing` {title}).
//
// A page: its folder path and type, its title (click to rename; links to it are fixed), the properties editor, then
// the text as it reads (reading view) or the editor (part A's live preview, or a plain text box when that can't load),
// switched with Ctrl+E, and a compact "Linked from" at the bottom. Typing saves after settings.autosaveMs; a change
// made elsewhere while typing (the AI, another tab or device) is merged in when it touches other lines, else the
// user's text is kept and a banner offers both versions. A change by the AI shows a banner with See changes / Undo.
// A status line shows the word count and reading time, and whether the text is saved.
import { textStats } from "../../shared/markdown.js";
import { keyOf, titleProblem } from "../../shared/links.js";
import { setProperties } from "../../shared/frontmatter.js";
import { diffLines, foldDiff } from "../../shared/diff.js";
import { el, icon, narrow } from "../app/dom.js";
import { openHistory } from "./history.js";
import { bodyOffset, linkContexts, merge3 } from "./lines.js";
import { folderList, newPageDialog } from "./newpage.js";
import { createPlainEditor } from "./plain-editor.js";
import { propertiesEditor } from "./props.js";
import { renderInto } from "./render.js";
import { selectionBar } from "./selection.js";
import { active, aiSeen, announce, fill, markAiSeen, pageUrl, safe, typeIcon, whoText } from "./util.js";

const AI_BANNER_MS = 3 * 86400000;

/** Modes chosen in this panel, per page, so coming back to a page (or a redraw) keeps it. */
const modes = new Map();

/** The shell scrolls the view's parent; find what scrolls. */
function scrollerOf(node) {
  for (let n = node.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n).overflowY;
    if (s === "auto" || s === "scroll") return n;
  }
  return document.scrollingElement;
}

let editorModule = null;
/** Part A's editor (panels/editor/index.js), or null when it can't load. */
function loadEditor() {
  editorModule ??= import("../editor/index.js").then((m) => (typeof m.createEditor === "function" ? m : null))
    .catch((error) => {
      console.warn("[wiki] the editor couldn't load; using a plain text box:", error);
      return null;
    });
  return editorModule;
}

export class PageView {
  constructor(app, root, route) {
    this.app = app;
    this.root = root;
    this.id = route.id;
    this.heading = route.heading ?? null;
    // A line of the page's Markdown to open at (0-based, properties included): the Tasks view sends it.
    this.line = Number.isInteger(route.line) ? route.line : null;
    const settings = app.settings.all();
    this.mode = route.mode ?? modes.get(this.id) ?? settings.defaultMode ?? "read";
    this.editor = null;
    this.dirty = false;
    this.saving = null;
    this.saveTimer = null;
    this.conflict = null; // {theirs, how}
    this.merged = null; // {how}
    this.offs = [];
    this.scroller = scrollerOf(root);
    this.build();
    this.offs.push(app.on("changed", (d) => this.onChanged(d)));
    this.offs.push(app.on("settings", (d) => this.onSettings(d)));
    this.offs.push(app.on("leave", () => this.flush()));
    const onHide = () => document.hidden && this.flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onHide);
    this.offs.push(() => document.removeEventListener("visibilitychange", onHide),
      () => window.removeEventListener("beforeunload", onHide));
    const onScroll = () => announce("scroll");
    this.scroller.addEventListener("scroll", onScroll, { passive: true });
    this.offs.push(() => this.scroller.removeEventListener("scroll", onScroll));
    active.view = this;
    this.draw();
  }

  get page() {
    return this.app.wiki.pages.get(this.id) ?? null;
  }

  build() {
    this.banner = el("div", { class: "page-banners" });
    this.crumbs = el("div", { class: "page-crumbs" });
    this.titleEl = el("h1", { class: "page-title", title: "Click to rename" });
    this.titleEl.addEventListener("click", () => this.startRename());
    this.actions = el("div", { class: "page-actions" });
    this.meta = el("div", { class: "page-meta" });
    this.props = el("div", { class: "page-props-slot" });
    this.toolbar = el("div", { class: "page-toolbar" });
    this.body = el("div", { class: "page-body" });
    this.footer = el("footer", { class: "page-footer" });
    this.status = el("div", { class: "page-status", role: "status" });
    this.phonebar = el("div", { class: "page-phonebar" });
    this.article = el("article", { class: "wiki-page" },
      this.banner,
      el("header", { class: "page-head" }, el("div", { class: "page-head-row" }, this.crumbs, this.actions),
        this.titleEl, this.meta),
      this.props, this.toolbar, this.body, this.footer);
    this.root.classList.add("page-view-root");
    this.root.replaceChildren(this.article, this.status, this.phonebar);
  }

  // ---------- drawing ----------

  draw() {
    const page = this.page;
    if (!page) return this.drawGone();
    this.article.dataset.mode = this.mode;
    this.root.dataset.mode = this.mode;
    this.drawHead(page);
    this.drawProps(page);
    this.drawBanner();
    this.drawFooter(page);
    if (this.mode === "edit") this.openEditor();
    else this.drawReading(page, true);
    this.drawStatus();
    safe(() => layr.panel.setTitle(page.title).catch(() => {}));
  }

  drawGone() {
    this.closeEditor();
    this.root.replaceChildren(el("div", { class: "wiki-empty page-gone" }, icon("file-x", "big"),
      el("h2", {}, "This page isn't there any more"),
      el("p", { class: "layr-muted" }, "It was deleted. The trash has pages that were moved there."),
      el("button", { class: "layr-button", onclick: () => this.app.open({ view: "trash" }, { replace: true }) },
        "Open the trash")));
  }

  drawHead(page) {
    const app = this.app;
    const parts = String(page.folder ?? "").split("/").filter(Boolean);
    fill(this.crumbs,
      ...parts.flatMap((name, i) => {
        const path = parts.slice(0, i + 1).join("/");
        return [i ? el("span", { class: "crumb-sep" }, icon("chevron-right")) : null,
          el("button", { class: "crumb", title: `Show ${path} in the files`, onclick: () => {
            app.sidebar?.show?.("left", "files");
            app.emit("reveal-folder", path);
          } }, i === 0 ? icon("folder") : null, name)];
      }),
      page.type ? el("button", { class: "crumb type-chip", title: `Type: ${page.type}`,
        onclick: () => app.open({ view: "types", name: page.type }) }, typeIcon(app, page.type), page.type) : null,
    );
    if (page.trashed) this.crumbs.prepend(el("span", { class: "layr-badge warn" }, "In the trash"));
    if (!this.renaming) this.titleEl.textContent = page.title;
    const editing = this.mode === "edit";
    this.actions.replaceChildren(
      el("button", { class: `layr-button ghost small mode-btn${editing ? " on" : ""}`,
        title: editing ? "Read (Ctrl+E)" : "Edit (Ctrl+E)", "aria-pressed": String(editing),
        onclick: () => this.setMode(editing ? "read" : "edit") },
      icon(editing ? "book-open" : "pencil"), el("span", { class: "mode-label" }, editing ? "Read" : "Edit")),
      el("button", { class: "layr-button ghost icon small", title: "History", "aria-label": "History",
        onclick: () => this.history() }, icon("history")),
      el("button", { class: "layr-button ghost icon small", title: "More", "aria-label": "More",
        onclick: (e) => this.menu(e) }, icon("ellipsis")));
    fill(this.meta, el("span", { class: "layr-muted" }, `Edited ${app.ui.ago(page.updated)} by ${whoText(page)}`),
      ...pageBadges(app, page));
  }

  drawProps(page) {
    if (this.props.contains(document.activeElement) && document.activeElement.matches("input, select")) return;
    this.props.replaceChildren(propertiesEditor(this.app, page, (changes) => this.writeProps(changes)));
  }

  drawReading(page, scroll = false) {
    const body = page.body;
    if (!body.trim()) {
      this.body.replaceChildren(el("div", { class: "page-empty" },
        el("p", { class: "layr-muted" }, "This page is empty."),
        el("button", { class: "layr-button", onclick: () => this.setMode("edit") }, icon("pencil"), " Write something")));
      this.reading = null;
    } else {
      const md = el("div", { class: "page-text" });
      this.body.replaceChildren(md);
      renderInto(this.app, md, page.markdown, { page });
      this.reading = md;
    }
    announce("render");
    if (scroll && this.line !== null) {
      const line = this.line;
      requestAnimationFrame(() => this.scrollToLine(line));
    } else if (scroll && this.heading) {
      const id = this.heading;
      requestAnimationFrame(() => this.scrollToHeading(id));
    }
  }

  drawFooter(page) {
    const back = this.app.wiki.backlinks(page.id);
    if (!back.length) return this.footer.replaceChildren();
    const names = [page.title, ...page.aliases];
    fill(this.footer,
      el("div", { class: "footer-head" }, icon("link"), `Linked from ${back.length} page${back.length === 1 ? "" : "s"}`),
      el("div", { class: "footer-links" }, ...back.slice(0, 40).map((p) => el("a", { class: "footer-link", href: "#",
        "data-page": p.title, title: linkContexts(p.markdown, names, 1)[0]?.text ?? p.title },
      typeIcon(this.app, p.type), el("span", {}, p.title)))),
      back.length > 40 ? el("button", { class: "layr-button ghost small", onclick: () => this.app.sidebar?.show?.("right",
        "backlinks") }, `All ${back.length}`) : null);
  }

  drawStatus(stats = null) {
    const page = this.page;
    if (!page) return;
    const settings = this.app.settings.all();
    const s = stats ?? (this.mode === "edit" && this.editor ? safe(() => this.editor.stats()) : null) ?? textStats(page.body);
    const state = this.mode !== "edit" ? null : this.saveError ? el("span", { class: "status-bad" }, "Not saved")
      : this.dirty || this.saving ? el("span", {}, "Saving…") : el("span", { class: "status-ok" }, "Saved");
    fill(this.status,
      state,
      settings.wordCount !== false ? el("span", {}, `${s.words.toLocaleString()} word${s.words === 1 ? "" : "s"}`) : null,
      settings.wordCount !== false && s.words ? el("span", {}, `${s.readingMinutes || 1} min read`) : null);
    this.status.hidden = !this.status.childElementCount;
  }

  /** The banner: a conflict, a merge, proposals waiting for review, or the AI's latest change. */
  drawBanner() {
    const app = this.app;
    const page = this.page;
    this.banner.replaceChildren();
    if (!page) return;
    const bar = (kind, text, ...buttons) => this.banner.append(el("div", { class: `page-banner ${kind}` },
      icon(kind === "warn" ? "triangle-alert" : kind === "ai" ? "sparkles" : "info"), el("span", { class: "text" }, text),
      ...buttons));
    const btn = (label, run, cls = "") => el("button", { class: `layr-button small ${cls}`.trim(), onclick: run }, label);
    if (page.trashed) {
      bar("warn", "This page is in the trash.", btn("Restore", () => app.wiki.untrash(page.id, { by: "you" })
        .catch((e) => app.ui.fail(e))));
    }
    if (this.conflict) {
      const c = this.conflict;
      bar("warn", `This page was changed ${c.how} while you were writing, in the same lines. Your text is kept ` +
        "and saved; their version is in the history.",
      btn("Compare", () => this.compare()), btn("Use theirs", () => this.useTheirs()),
      btn("OK", () => ((this.conflict = null), this.drawBanner()), "ghost"));
    } else if (this.merged) {
      bar("info", `A change made ${this.merged.how} was merged into your text.`,
        btn("See changes", () => this.history()), btn("OK", () => ((this.merged = null), this.drawBanner()), "ghost"));
    }
    const waiting = safe(() => app.wiki.proposalsFor?.(page.id), []) ?? [];
    if (waiting.length) {
      bar("ai", `${waiting.length === 1 ? "A change by the AI waits" : `${waiting.length} changes by the AI wait`} for ` +
        "your review.", btn("Review", () => app.open({ view: "review", id: waiting[0].id })));
    }
    if (page.by === "ai" && Date.now() - page.updated < AI_BANNER_MS && !aiSeen(page) && !this.conflict) {
      bar("ai", `Changed by AI ${app.ui.ago(page.updated)}.`,
        btn("See changes", () => this.history()),
        btn("Undo", async () => {
          try {
            await this.flush();
            await app.wiki.restore(page.id, null, { by: "you" });
            app.ui.notify("Went back to the version before the AI's change", "success");
          } catch (error) {
            app.ui.fail(error);
          }
        }),
        btn("OK", () => {
          markAiSeen(page);
          this.drawBanner();
        }, "ghost"));
    }
  }

  // ---------- modes and the editor ----------

  async setMode(mode) {
    if (mode === this.mode) return;
    if (this.mode === "edit") await this.flush();
    this.mode = mode;
    modes.set(this.id, mode);
    safe(() => this.app.updateRoute?.({ mode }));
    const page = this.page;
    if (!page) return;
    this.article.dataset.mode = mode;
    this.root.dataset.mode = mode;
    this.drawHead(page);
    if (mode === "edit") await this.openEditor(true);
    else {
      this.closeEditor();
      // A merge or conflict is about the text being written: done with that once reading.
      this.conflict = null;
      this.merged = null;
      this.drawBanner();
      this.drawReading(page);
    }
    this.drawStatus();
    announce("mode");
  }

  async openEditor(focus = false) {
    const page = this.page;
    if (!page || this.editor || this.opening) return;
    this.opening = true;
    const host = el("div", { class: "page-editor" });
    this.body.replaceChildren(host);
    this.reading = null;
    this.base = page.markdown;
    const app = this.app;
    const settings = app.settings.all();
    const options = {
      doc: page.markdown,
      app,
      page,
      mode: settings.editorMode ?? "live",
      readOnly: Boolean(page.trashed),
      onChange: () => this.typed(),
      onSave: () => this.flush(),
      resolve: (target) => {
        const p = app.wiki.resolve(target);
        return p ? { title: p.title, exists: true } : { title: target, exists: false };
      },
      upload: (list) => this.upload(list),
      onProperties: () => this.showProperties(),
    };
    let editor = null;
    const mod = await loadEditor();
    if (this.destroyed || this.mode !== "edit" || !host.isConnected) {
      this.opening = false;
      return;
    }
    if (mod) {
      try {
        editor = await mod.createEditor(host, options);
      } catch (error) {
        console.warn("[wiki] the editor failed; using a plain text box:", error);
        editor = null;
      }
    }
    editor ??= createPlainEditor(host, options);
    this.opening = false;
    if (this.destroyed || this.mode !== "edit") {
      safe(() => editor.destroy());
      return;
    }
    this.editor = editor;
    app.editor = editor;
    this.placeToolbar();
    this.offSelection = selectionBar(app, editor, { toolbarHost: this.phonebar, scroller: this.scroller });
    if (focus && !narrow()) safe(() => editor.focus());
    if (this.line !== null) this.scrollToLine(this.line);
    else if (this.heading) safe(() => editor.scrollToHeading(this.heading));
    this.drawStatus();
    announce("render");
  }

  /** The formatting toolbar: above the text on the PC; on the phone part A's bar floats above the keyboard. */
  placeToolbar() {
    this.toolbar.replaceChildren();
    this.phonebar.replaceChildren();
    if (!this.editor?.toolbar) return;
    const phone = narrow();
    safe(() => this.editor.toolbar(phone ? this.phonebar : this.toolbar));
    this.root.classList.toggle("with-phonebar", phone && this.phonebar.childElementCount > 0);
  }

  /** The editor's folded properties line was clicked: open the properties editor above instead. */
  showProperties() {
    const box = this.props.querySelector(".page-props");
    if (!box) return false;
    box.classList.remove("folded");
    box.querySelector(".page-props-head")?.setAttribute("aria-expanded", "true");
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    box.querySelector(".prop-input, .prop-select, .page-props-add")?.focus({ preventScroll: true });
    return true;
  }

  closeEditor() {
    this.offSelection?.();
    this.offSelection = null;
    if (!this.editor) return;
    const editor = this.editor;
    this.editor = null;
    if (this.app.editor === editor) this.app.editor = null;
    safe(() => editor.destroy());
    this.toolbar.replaceChildren();
    this.phonebar.replaceChildren();
    this.root.classList.remove("with-phonebar");
  }

  typed() {
    this.dirty = true;
    this.saveError = false;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.app.settings.get("autosaveMs") ?? 800);
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => this.drawStatus(), 300);
  }

  /** Save the editor's text now when it changed (and wait for a save under way). */
  async flush() {
    clearTimeout(this.saveTimer);
    if (this.saving) await this.saving;
    const page = this.page;
    if (!this.dirty || !this.editor || !page) return;
    // A page moved to the trash while it was open: saving would bring it back.
    if (page.trashed) {
      this.dirty = false;
      return;
    }
    const markdown = this.editor.getText();
    this.dirty = false;
    this.saving = this.app.wiki.save(page.id, markdown, { by: "you" })
      .then(() => {
        this.base = markdown;
        this.saveError = false;
      })
      .catch((error) => {
        this.dirty = true;
        this.saveError = true;
        this.app.ui.fail(error);
      })
      .finally(() => {
        this.saving = null;
        this.drawStatus();
      });
    this.drawStatus();
    await this.saving;
  }

  async upload(list) {
    const names = [];
    for (const file of list) {
      try {
        this.status.replaceChildren(el("span", {}, `Uploading ${file.name || "a picture"}…`));
        const name = file.name && file.name !== "image.png" ? file.name
          : `Pasted ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
        const record = await this.app.files.upload(name, await file.arrayBuffer(), file.type || null);
        names.push(record.name);
      } catch (error) {
        this.app.ui.fail(error);
      }
    }
    this.drawStatus();
    return names;
  }

  /** Write properties; while editing, the editor's text is saved first and takes the new properties. */
  async writeProps(changes) {
    const page = this.page;
    if (!page) return;
    const wiki = this.app.wiki;
    if (this.mode === "edit" && this.editor) {
      await this.flush();
      const next = setProperties(this.editor.getText(), changes);
      this.editor.setText(next, { keepCursor: true });
      this.base = next;
      await wiki.save(page.id, next, { by: "you" });
    } else if (typeof wiki.setProperties === "function") await wiki.setProperties(page.id, changes, { by: "you" });
    else await wiki.setProps(page.id, changes, { by: "you" });
    const now = this.page;
    if (now) {
      this.drawProps(now);
      this.drawHead(now);
    }
  }

  // ---------- changes from elsewhere ----------

  onChanged(data) {
    const ids = data?.ids ?? [];
    const page = this.page;
    if (!page) {
      if (ids.includes(this.id) || !ids.length) this.drawGone();
      return;
    }
    if (!ids.includes(this.id)) {
      // Another page changed: links to it may have turned red or blue, embeds of it changed.
      const embedded = new Set([...(this.reading?.querySelectorAll(".page-embed[data-embed]") ?? [])]
        .map((n) => keyOf(n.dataset.embed)));
      const touched = ids.some((id) => {
        const p = this.app.wiki.pages.get(id);
        return !p || embedded.has(keyOf(p.title)) || p.links.some((t) => keyOf(t) === keyOf(page.title));
      });
      if (touched || data?.types) {
        this.drawFooter(page);
        if (this.mode === "read" && this.reading && embedded.size) this.drawReading(page);
      }
      if (data?.types) this.drawProps(page);
      return;
    }
    this.drawHead(page);
    this.drawFooter(page);
    if (page.trashed && this.dirty) this.dirty = false;
    if (this.mode === "edit" && this.editor) this.mergeIn(page);
    else if (this.mode === "read") {
      if (!this.reading || this.reading._wikiSource !== page.body) this.drawReading(page);
    }
    this.drawProps(page);
    this.drawBanner();
    this.drawStatus();
  }

  /** The page was saved elsewhere while the editor is open. */
  mergeIn(page) {
    const theirs = page.markdown;
    const mine = this.editor.getText();
    if (theirs === this.base) return;
    if (theirs === mine) {
      this.base = theirs;
      this.dirty = false;
      return;
    }
    const how = page.by === "ai" ? "by the AI"
      : page.device && page.device !== safe(() => layr.info.device?.id) ? "on another device" : "in another tab";
    if (!this.dirty && mine === this.base) {
      this.editor.setText(theirs, { keepCursor: true });
      this.base = theirs;
      return;
    }
    const { text, clean } = merge3(this.base, mine, theirs);
    this.base = theirs;
    if (clean) {
      this.editor.setText(text, { keepCursor: true });
      this.merged = { how };
      this.conflict = null;
      if (text !== theirs) this.typed();
      else this.dirty = false;
    } else {
      this.conflict = { theirs, how };
      this.typed();
    }
  }

  compare() {
    const c = this.conflict;
    if (!c || !this.editor) return;
    const mine = this.editor.getText();
    this.app.ui.modal("Their version and yours", (body, close) => {
      body.classList.add("page-history");
      const ops = foldDiff(diffLines(c.theirs, mine));
      body.append(el("p", { class: "layr-muted" }, `− lines only in the version saved ${c.how}, + lines only in yours.`),
        el("pre", { class: "diff" }, ...ops.map((o) => o.op === "skip"
          ? el("div", { class: "skip" }, `… ${o.count} unchanged lines …`)
          : el("div", { class: o.op }, el("span", { class: "sign" }, o.op === "add" ? "+" : o.op === "del" ? "−" : " "),
            o.text || " "))),
        el("div", { class: "modal-actions" },
          el("button", { class: "layr-button", onclick: () => (close(), this.useTheirs()) }, "Use theirs"),
          el("button", { class: "layr-button primary", onclick: () => {
            close();
            this.conflict = null;
            this.drawBanner();
          } }, "Keep mine")));
      return { wide: true };
    });
  }

  useTheirs() {
    const c = this.conflict;
    if (!c || !this.editor) return;
    this.editor.setText(c.theirs, { keepCursor: true });
    this.conflict = null;
    this.typed();
    this.drawBanner();
  }

  onSettings() {
    const page = this.page;
    if (!page) return;
    if (this.mode === "read") this.drawReading(page);
    else safe(() => this.editor?.setMode?.(this.app.settings.get("editorMode")));
    this.drawStatus();
  }

  // ---------- rename, menu, history ----------

  startRename() {
    const page = this.page;
    if (!page || this.renaming || page.trashed) return;
    this.renaming = true;
    const input = el("input", { class: "page-title-input", value: page.title, spellcheck: "false",
      "aria-label": "Title" });
    const problem = el("div", { class: "page-title-problem layr-error" });
    const done = async (commit) => {
      if (!this.renaming) return;
      const t = input.value.trim();
      this.renaming = false;
      input.replaceWith(this.titleEl);
      problem.remove();
      const now = this.page;
      if (!commit || !now || t === now.title) return this.drawHead(now ?? page);
      try {
        await this.flush();
        const { updated } = await this.app.wiki.rename(now.id, t, { by: "you" });
        this.app.ui.notify(updated ? `Renamed; links fixed in ${updated} page${updated === 1 ? "" : "s"}` : "Renamed",
          "success");
        if (this.mode === "edit" && this.editor) {
          // The page's own links to itself were renamed too.
          const fresh = this.page;
          if (fresh && fresh.markdown !== this.editor.getText() && !this.dirty) {
            this.editor.setText(fresh.markdown, { keepCursor: true });
            this.base = fresh.markdown;
          }
        }
      } catch (error) {
        this.app.ui.fail(error);
      }
      this.drawHead(this.page ?? page);
    };
    input.addEventListener("input", () => {
      const t = input.value.trim();
      const clash = t && keyOf(t) !== keyOf(page.title) ? this.app.wiki.resolve(t) : null;
      problem.textContent = titleProblem(t) ?? (clash ? `There is a page “${clash.title}” already` : "");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(!problem.textContent);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    });
    input.addEventListener("blur", () => done(!problem.textContent));
    this.titleEl.replaceWith(input);
    input.after(problem);
    input.focus();
    input.select();
  }

  history(select = 0) {
    const page = this.page;
    if (page) openHistory(this.app, page, { before: () => this.flush(), select });
  }

  async menu(e) {
    const app = this.app;
    const page = this.page;
    if (!page) return;
    const has = (id) => Boolean(app.commands?.get?.(id));
    const mark = { kind: "page", target: page.id, title: page.title };
    const marks = safe(() => app.wiki.bookmarks?.(), []) ?? [];
    const marked = marks.some((b) => b.kind === "page" && (b.target === page.id || keyOf(b.target) === keyOf(page.title)));
    const items = [
      { label: this.mode === "edit" ? "Read" : "Edit", icon: this.mode === "edit" ? "visibility" : "edit",
        shortcut: "Ctrl+E", run: () => this.setMode(this.mode === "edit" ? "read" : "edit") },
      { label: "Rename", icon: "drive_file_rename_outline", shortcut: "F2", run: () => this.startRename() },
      { label: "Move to folder…", icon: "drive_file_move", run: () => (has("move-page")
        ? app.commands.run("move-page") : this.moveDialog()) },
      { label: marked ? "Remove bookmark" : "Bookmark", icon: "bookmark", run: () => (has("bookmark")
        ? app.commands.run("bookmark") : this.toggleBookmark(mark, marked)) },
      "-",
      { label: "Copy link", icon: "link", run: () => this.copy(pageUrl(page.title), "Link copied: paste it in a " +
        "Claude thread or another page") },
      { label: "Copy as [[link]]", icon: "data_array", run: () => this.copy(`[[${page.title}]]`, "Copied") },
      { label: "Open in a new tab", icon: "open_in_new", run: () => app.openPage(page.id, { newTab: true }) },
      { label: "History", icon: "history", run: () => this.history() },
      has("reveal-page") ? { label: "Show in the file tree", icon: "account_tree",
        run: () => app.commands.run("reveal-page") } : null,
      ...(safe(() => app.pageMenu?.items?.(page), []) ?? []),
      "-",
      { label: "Move to the trash", icon: "delete", danger: true, run: () => this.trash() },
    ].filter(Boolean);
    await app.ui.menu(items, e).catch((err) => app.ui.fail(err));
  }

  copy(text, message) {
    navigator.clipboard?.writeText(text).then(() => this.app.ui.notify(message), (e) => this.app.ui.fail(e));
  }

  async toggleBookmark(mark, marked) {
    const wiki = this.app.wiki;
    const list = safe(() => wiki.bookmarks?.(), []) ?? [];
    const next = marked ? list.filter((b) => !(b.kind === "page" && b.target === mark.target)) : [...list, mark];
    await wiki.setBookmarks?.(next);
    this.app.emit("bookmarks");
    this.app.ui.notify(marked ? "Bookmark removed" : `Bookmarked “${mark.title}”`);
  }

  moveDialog() {
    const page = this.page;
    if (!page) return;
    this.app.ui.modal(`Move “${page.title}”`, (body, close) => {
      const select = el("select", { class: "layr-select" }, el("option", { value: "" }, "Top (no folder)"),
        ...folderList(this.app).map((f) => el("option", { value: f, selected: f === page.folder }, f.replaceAll("/", " › "))));
      body.append(el("label", { class: "layr-label" }, "Folder"), select);
      return { ok: "Move", focus: select, run: async () => {
        await this.app.wiki.move(page.id, select.value, { by: "you" });
        close();
      } };
    });
  }

  async trash() {
    const page = this.page;
    if (!page) return;
    if (this.app.commands?.get?.("trash-page")) return this.app.commands.run("trash-page");
    if (this.app.settings.get("confirmDelete") !== false &&
      !(await this.app.ui.confirm(`Move “${page.title}” to the trash?`, { ok: "Move to the trash", danger: true }))) return;
    await this.flush();
    this.dirty = false;
    await this.app.wiki.trash(page.id, { by: "you" });
    this.app.ui.notify(`“${page.title}” is in the trash`);
    if (!this.app.back?.()) this.app.open({ view: "home" }, { replace: true });
  }

  // ---------- outline support ----------

  /** Show line `line` of the page's Markdown: the cursor there in the editor, else the nearest block that reads. */
  scrollToLine(line) {
    const page = this.page;
    if (!page) return;
    if (this.mode === "edit" && this.editor) {
      const view = this.editor.view;
      if (view?.state?.doc) {
        const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
        const pos = view.state.doc.line(n).from;
        safe(() => view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }));
        safe(() => view.focus());
      } else safe(() => this.editor.scrollToLine?.(line));
      return;
    }
    if (!this.reading) return;
    const want = line - bodyOffset(page.markdown);
    let best = null;
    for (const node of this.reading.querySelectorAll("[data-line]")) {
      if (node.closest(".page-embed") || node.matches("input")) continue;
      const at = Number(node.dataset.line);
      if (at <= want && (!best || at >= Number(best.dataset.line))) best = node;
    }
    if (!best) return;
    const top = best.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    this.scroller.scrollTo({ top: Math.max(0, top - 24) });
    best.classList.add("flash");
    setTimeout(() => best.classList.remove("flash"), 1200);
  }

  scrollToHeading(id) {
    if (this.mode === "edit" && this.editor) {
      const h = this.page ? (this.page.body.split("\n").find((l) => /^#{1,6}\s/.test(l) &&
        slugText(l) === id) ?? null) : null;
      safe(() => this.editor.scrollToHeading(h ? h.replace(/^#+\s*/, "").replace(/\s*#*\s*$/, "") : id));
      return;
    }
    const target = this.reading?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) return;
    const top = target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    this.scroller.scrollTo({ top: Math.max(0, top - 12), behavior: "smooth" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  }

  destroy() {
    this.destroyed = true;
    this.flush();
    clearTimeout(this.statsTimer);
    this.closeEditor();
    for (const off of this.offs) safe(off);
    if (active.view === this) active.view = null;
    announce("render");
  }
}

/** The badges other parts put by the title (app.pageBadges: E's "Public", …). */
function pageBadges(app, page) {
  const list = safe(() => app.pageBadges?.items?.(page), []) ?? [];
  return list.map((b) => el(b.run ? "button" : "span", {
    class: `page-badge${b.run ? " clickable" : ""}`, title: b.title ?? b.text,
    onclick: b.run ? (e) => Promise.resolve().then(() => b.run(page, app, e)).catch((err) => app.ui.fail(err)) : null,
  }, b.icon ? icon(b.icon) : null, b.text ? el("span", {}, b.text) : null));
}

const slugText = (line) => line.replace(/^#+\s*/, "").replace(/\s*#*\s*$/, "").toLowerCase()
  .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/** The missing page view: a link to a page nobody wrote yet. */
export function renderMissing(app, root, route) {
  const title = String(route.title ?? "");
  const wanted = safe(() => app.wiki.wanted(), []) ?? [];
  const from = wanted.find((w) => keyOf(w.title) === keyOf(title))?.from ?? [];
  const problem = titleProblem(title);
  const create = async () => {
    try {
      const page = await app.wiki.create({ title, folder: safe(() => app.defaultFolder?.(), "") ?? "" }, { by: "you" });
      await app.openPage(page.id, { mode: "edit", replace: true });
    } catch (error) {
      app.ui.fail(error);
    }
  };
  root.replaceChildren(el("article", { class: "wiki-page missing-page" },
    el("h1", { class: "page-title missing" }, title || "New page"),
    el("p", { class: "layr-muted" }, problem ? `This can't be a page's title: ${problem}`
      : "There is no page with this title yet."),
    el("div", { class: "missing-actions" },
      problem ? null : el("button", { class: "layr-button primary", onclick: create }, icon("file-plus"), " Create it"),
      el("button", { class: "layr-button", onclick: () => newPageDialog(app, { title: problem ? "" : title }) },
        "Create with a type or template…")),
    from.length ? el("section", { class: "missing-from" }, el("h3", {}, `Linked from ${from.length} page` +
      `${from.length === 1 ? "" : "s"}`),
    el("div", { class: "footer-links" }, ...from.map((p) => el("a", { class: "footer-link", href: "#", "data-page": p.title },
      typeIcon(app, p.type), el("span", {}, p.title))))) : null));
}
