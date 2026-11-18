// Export and print: a page, a folder or picked pages as one HTML file (pictures and styles inside, links between the
// pages as anchors), Markdown (a .md, or a .zip with the attachments), Word (.docx, made by the backend's `export`
// tool from the same HTML), and a print view (PDF through the system's print dialog).
import { el, icon } from "../app/dom.js";
import { cleanFileName } from "../../shared/files.js";
import { keyOf } from "../../shared/links.js";
import { base64ToBytes, exportDocument, markdownFiles, zipStore } from "./convert.js";
import { attachmentsOf, backendError, bytesArgs, onPhone, renderPages, saveFile } from "./render.js";

export const FORMATS = [
  { id: "html", title: "HTML (one file)", icon: "file-code" },
  { id: "markdown", title: "Markdown", icon: "file-text" },
  { id: "docx", title: "Word (.docx)", icon: "file-type" },
  { id: "print", title: "Print or save as PDF", icon: "printer" },
];

const docTitle = (pages, title) => title ?? (pages.length === 1 ? pages[0].title : `${pages[0].title} and ${pages.length - 1} more`);

/** A progress note in the corner while an export runs; gives `{set(text), done()}`. */
function progress(text) {
  const box = el("div", { class: "io-progress", role: "status" }, el("span", { class: "layr-spinner" }), el("span", {}, text));
  document.body.append(box);
  return { set: (t) => (box.lastChild.textContent = t), done: () => box.remove() };
}

async function buildHtml(app, pages, title, p) {
  const { rendered, images, missing } = await renderPages(app, pages, { onProgress: p.set });
  return { html: exportDocument({ title: docTitle(pages, title), pages: rendered, images }), missing };
}

/** Export `pages` (in order) as `format`. */
export async function exportPages(app, pages, format, { title } = {}) {
  if (!pages.length) return app.ui.notify("No pages to export", "info");
  if (format === "print") return printPages(app, pages, { title });
  const name = cleanFileName(docTitle(pages, title)).replace(/\.bin$/, "");
  const p = progress("Preparing…");
  try {
    let note = "";
    let saved;
    if (format === "html") {
      const { html, missing } = await buildHtml(app, pages, title, p);
      if (missing) note = ` ${missing} picture(s) couldn't be loaded.`;
      p.set("Saving…");
      saved = await saveFile(`${name}.html`, html, { types: [".html"], mime: "text/html" });
    } else if (format === "markdown") {
      const { attachments, missing } = await attachmentsOf(app, pages, { onProgress: p.set });
      if (missing) note = ` ${missing} attachment(s) couldn't be loaded.`;
      p.set("Saving…");
      if (pages.length === 1 && !attachments.length) {
        saved = await saveFile(`${name}.md`, pages[0].markdown, { types: [".md"], mime: "text/markdown" });
      } else {
        saved = await saveFile(`${name}.zip`, zipStore(markdownFiles(pages, attachments)), { types: [".zip"],
          mime: "application/zip" });
      }
    } else if (format === "docx") {
      const { html, missing } = await buildHtml(app, pages, title, p);
      if (missing) note = ` ${missing} picture(s) couldn't be loaded.`;
      p.set("Making the Word file…");
      let result;
      try {
        const args = await bytesArgs(app, new TextEncoder().encode(html), { onProgress: p.set });
        result = await app.tools("export", { format: "docx", title: docTitle(pages, title),
          ...(args.upload ? { upload: args.upload } : { html }) });
      } catch (error) {
        throw backendError(error, "Word export");
      }
      p.set("Saving…");
      saved = await saveFile(`${name}.docx`, base64ToBytes(result.base64), { types: [".docx"], mime: result.mime });
    } else throw new Error(`No export format ${format}`);
    if (saved) app.ui.notify(`Exported ${pages.length} page${pages.length === 1 ? "" : "s"}.${note}`, note ? "info" : "success");
  } catch (error) {
    app.ui.fail(error);
  } finally {
    p.done();
  }
}

/** The print view: the pages as they would print, with Print and Close; printing goes through the system's dialog. */
export async function printPages(app, pages, { title } = {}) {
  if (onPhone()) {
    app.ui.notify("Printing isn't available on the phone: export as HTML or Word and print from there.", "info");
    return;
  }
  const p = progress("Preparing the print view…");
  let html;
  try {
    ({ html } = await buildHtml(app, pages, title, p));
  } catch (error) {
    app.ui.fail(error);
    return;
  } finally {
    p.done();
  }
  const frame = el("iframe", { class: "io-print-frame", title: "Print preview" });
  frame.srcdoc = html.replace("<html lang=\"en\">", "<html lang=\"en\" class=\"light\">");
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const print = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      app.ui.notify("This view can't print here: export as HTML and print it from your browser.", "error");
    }
  };
  const overlay = el("div", { class: "io-print", role: "dialog", "aria-label": "Print preview" },
    el("div", { class: "io-print-bar" },
      icon("printer"), el("strong", {}, docTitle(pages, title)),
      el("span", { class: "layr-muted" }, "Choose “Save as PDF” in the print dialog for a PDF."),
      el("span", { class: "layr-spacer" }),
      el("button", { class: "layr-button primary", onclick: print }, icon("printer"), "Print…"),
      el("button", { class: "layr-button", onclick: close }, "Close")),
    el("div", { class: "io-print-paper" }, frame));
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
}

/** Pages in a folder and its subfolders, A to Z. */
export function pagesInFolder(wiki, folder) {
  const f = keyOf(folder ?? "");
  return wiki.live().filter((p) => {
    const pf = keyOf(p.folder ?? "");
    return !f || pf === f || pf.startsWith(`${f}/`);
  }).sort((a, b) => (a.path ?? a.title).localeCompare(b.path ?? b.title));
}

/** The dialog for several pages: what (this page, with its links, a folder, picked pages) and the format. */
export function openExportDialog(app, { page = app.page?.(), format = "html" } = {}) {
  app.ui.modal("Export pages", (body, closeModal) => {
    body.classList.add("io-dialog");
    const folders = app.wiki.folders?.() ?? [...new Set(app.wiki.live().map((p) => p.folder).filter(Boolean))].sort();
    let scope = page ? "page" : "folder";
    const picked = new Set(page ? [page.id] : []);
    const folderSelect = el("select", { class: "layr-select" }, el("option", { value: "" }, "The whole wiki"),
      folders.map((f) => el("option", { value: f, selected: page?.folder === f ? true : null }, f)));
    const filter = el("input", { class: "layr-input", placeholder: "Filter pages…" });
    const list = el("div", { class: "io-pick-list" });
    const drawList = () => {
      const q = keyOf(filter.value);
      const pages = app.wiki.live().filter((p) => !q || keyOf(p.path ?? p.title).includes(q))
        .sort((a, b) => (a.path ?? a.title).localeCompare(b.path ?? b.title)).slice(0, 500);
      list.replaceChildren(...pages.map((p) => {
        const box = el("input", { type: "checkbox", checked: picked.has(p.id) ? true : null,
          onchange: (e) => (e.target.checked ? picked.add(p.id) : picked.delete(p.id), count()) });
        return el("label", { class: "io-pick-row" }, box, el("span", {}, p.title),
          p.folder ? el("span", { class: "layr-muted" }, p.folder) : null);
      }));
    };
    filter.oninput = drawList;
    const summary = el("span", { class: "layr-muted" });
    const chosen = () => {
      if (scope === "page") return page ? [page] : [];
      if (scope === "linked") {
        const out = new Map([[page.id, page]]);
        for (const t of page.links ?? []) {
          const p = app.wiki.resolve(t);
          if (p) out.set(p.id, p);
        }
        return [...out.values()];
      }
      if (scope === "folder") return pagesInFolder(app.wiki, folderSelect.value);
      return app.wiki.live().filter((p) => picked.has(p.id)).sort((a, b) => a.title.localeCompare(b.title));
    };
    const count = () => {
      const n = chosen().length;
      summary.textContent = `${n} page${n === 1 ? "" : "s"}`;
    };
    folderSelect.onchange = count;
    const radio = (value, label, extra = null) => el("label", { class: "io-scope" },
      el("input", { type: "radio", name: "io-scope", value, checked: scope === value ? true : null, onchange: () => {
        scope = value;
        pickBox.hidden = scope !== "pick";
        folderSelect.disabled = scope !== "folder";
        if (scope === "pick") drawList();
        count();
      } }), el("span", {}, label), extra);
    const pickBox = el("div", { class: "io-pick", hidden: true }, filter, list);
    folderSelect.disabled = scope !== "folder";
    const formatSelect = el("select", { class: "layr-select" },
      FORMATS.map((f) => el("option", { value: f.id, selected: f.id === format ? true : null }, f.title)));
    body.append(
      el("div", { class: "io-scopes" },
        page ? radio("page", `This page (${page.title})`) : null,
        page ? radio("linked", "This page and the pages it links to") : null,
        radio("folder", "A folder:", folderSelect),
        radio("pick", "Pages I pick")),
      pickBox,
      el("label", { class: "layr-label" }, "Format"), formatSelect,
      el("div", { class: "ai-modal-buttons" }, summary, el("span", { class: "layr-spacer" }),
        el("button", { class: "layr-button ghost", onclick: closeModal }, "Cancel"),
        el("button", { class: "layr-button primary", onclick: () => {
          const pages = chosen();
          if (!pages.length) return app.ui.notify("Pick at least one page", "info");
          closeModal();
          exportPages(app, pages, formatSelect.value, { title: scope === "folder" && folderSelect.value
            ? folderSelect.value.split("/").pop() : undefined });
        } }, icon("download"), "Export")));
    count();
  });
}
