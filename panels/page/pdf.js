// PDFs inside a page (`![[paper.pdf]]`, `![[paper.pdf#page=3]]`): pdf.js (vendor/pdfjs, Mozilla, Apache-2.0; the
// legacy build, so older phone web views work) draws the pages onto canvases, only those scrolled into sight, with
// page buttons, zoom, download and "Open full" (the whole window; from there layr's PDF plugin when it is installed).
// The panel may not compile WebAssembly (no `wasm` permission), so pdf.js uses its JavaScript decoders for JPEG 2000
// and JBIG2 pictures (vendor/pdfjs/wasm/*_nowasm_fallback.js) and draws without colour profiles.
import { el, icon } from "../app/dom.js";
import { downloadFile, fileBytes, narrow, shortError } from "./util.js";

const BASE = new URL("../../vendor/pdfjs/", import.meta.url).href;
let lib = null;

function pdfjs() {
  lib ??= import(`${BASE}pdf.min.mjs`).then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
    return m;
  });
  lib.catch(() => (lib = null));
  return lib;
}

const docs = new Map();

/** The loaded PDF document of an attachment (shared by every embed of it in this panel). */
function loadDoc(app, name) {
  const key = name.toLowerCase();
  if (!docs.has(key)) {
    const p = Promise.all([pdfjs(), fileBytes(app, name)]).then(([m, { bytes }]) =>
      m.getDocument({
        // pdf.js hands the bytes to its worker (the buffer is moved): give it a copy, the cache keeps the original.
        data: new Uint8Array(bytes.slice(0)),
        isEvalSupported: false,
        useWasm: false,
        wasmUrl: `${BASE}wasm/`,
        useSystemFonts: true,
        enableXfa: false,
      }).promise);
    docs.set(key, p);
    p.catch(() => docs.delete(key));
  }
  return docs.get(key);
}

/** A PDF viewer in `host`: `{name, page, height, full}`. Gives `{destroy}`. */
class PdfView {
  constructor(app, host, { name, page = 1, height = null, full = false, onClose = null }) {
    this.app = app;
    this.name = name;
    this.start = page;
    this.full = full;
    this.zoom = 1; // 1: the pages as wide as the viewer
    this.pages = [];
    this.current = page;
    this.rendering = new Map();
    this.counter = el("span", { class: "pdf-count" }, "…");
    const btn = (name_, title, run, cls = "") => el("button", { class: `pdf-btn ${cls}`.trim(), title,
      "aria-label": title, onclick: (e) => (e.preventDefault(), e.stopPropagation(), run()) }, icon(name_));
    this.body = el("div", { class: "pdf-pages", tabindex: "0" }, el("div", { class: "pdf-loading" }, "Loading the PDF…"));
    if (!full) this.body.style.height = `${height ?? (narrow() ? 420 : 560)}px`;
    const tools = [
      btn("chevron-up", "Previous page", () => this.goTo(this.current - 1)),
      this.counter,
      btn("chevron-down", "Next page", () => this.goTo(this.current + 1)),
      el("span", { class: "pdf-sep" }),
      btn("zoom-out", "Zoom out", () => this.setZoom(this.zoom / 1.2)),
      btn("zoom-in", "Zoom in", () => this.setZoom(this.zoom * 1.2)),
      el("span", { class: "pdf-sep" }),
      btn("download", "Download", () => downloadFile(app, name).catch((e) => app.ui.fail(e))),
      full
        ? btn("external-link", "Open in layr's PDF viewer (saves a copy on this PC first)", () => openInPdfPlugin(app, name))
        : btn("maximize-2", "Open full", () => openPdfFull(app, name, this.current)),
      full ? btn("x", "Close (Esc)", () => onClose?.()) : null,
    ];
    this.root = el("div", { class: `pdf-view${full ? " full" : ""}` },
      el("div", { class: "pdf-bar" }, icon("file-text"), el("span", { class: "pdf-name", title: name }, name),
        el("span", { class: "pdf-spacer" }), ...tools),
      this.body);
    host.replaceChildren(this.root);
    this.body.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.body.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.body);
    this.load();
  }

  async load() {
    try {
      this.doc = await loadDoc(this.app, this.name);
      if (this.destroyed) return;
      const first = await this.doc.getPage(1);
      this.base = first.getViewport({ scale: 1 });
      this.body.replaceChildren();
      for (let n = 1; n <= this.doc.numPages; n++) {
        const canvas = el("canvas", { class: "pdf-canvas" });
        const holder = el("div", { class: "pdf-page", "data-page": String(n) }, canvas,
          el("span", { class: "pdf-page-no" }, String(n)));
        this.pages.push({ n, holder, canvas, size: null, drawn: 0 });
        this.body.append(holder);
      }
      this.observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.draw(Number(e.target.dataset.page));
      }, { root: this.body, rootMargin: "300px 0px" });
      for (const p of this.pages) this.observer.observe(p.holder);
      this.layout();
      if (this.start > 1) this.goTo(this.start, false);
      this.updateCounter();
    } catch (error) {
      if (this.destroyed) return;
      this.body.replaceChildren(el("div", { class: "pdf-error" }, icon("file-x"),
        ` Couldn't show ${this.name}: ${shortError(error)}`));
    }
  }

  /** The scale that makes a page as wide as the viewer, times the zoom. */
  scaleFor(width) {
    const avail = Math.max(120, this.body.clientWidth - 24);
    return (avail / width) * this.zoom;
  }

  /** Size every page's box (pages not drawn yet use the first page's size), keeping the place in the document. */
  layout() {
    if (!this.pages.length) return;
    const keep = this.current;
    const offset = this.pageOffset();
    for (const p of this.pages) {
      const vp = p.size ?? this.base;
      const s = this.scaleFor(vp.width);
      p.holder.style.width = `${Math.floor(vp.width * s)}px`;
      p.holder.style.height = `${Math.floor(vp.height * s)}px`;
      if (p.drawn && Math.abs(p.drawn - s) > 0.01) p.stale = true;
    }
    this.goTo(keep, false, offset);
    for (const p of this.pages) if (p.stale && this.visible(p)) this.draw(p.n);
  }

  visible(p) {
    const a = this.body.getBoundingClientRect();
    const b = p.holder.getBoundingClientRect();
    return b.bottom > a.top - 300 && b.top < a.bottom + 300;
  }

  async draw(n) {
    const p = this.pages[n - 1];
    if (!p || !this.doc || this.rendering.has(n)) return;
    const page = await this.doc.getPage(n);
    if (this.destroyed) return;
    const unscaled = page.getViewport({ scale: 1 });
    if (!p.size || p.size.width !== unscaled.width || p.size.height !== unscaled.height) {
      p.size = unscaled;
      const s0 = this.scaleFor(unscaled.width);
      p.holder.style.width = `${Math.floor(unscaled.width * s0)}px`;
      p.holder.style.height = `${Math.floor(unscaled.height * s0)}px`;
    }
    const s = this.scaleFor(unscaled.width);
    if (p.drawn && Math.abs(p.drawn - s) < 0.01 && !p.stale) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: s * ratio });
    const canvas = el("canvas", { class: "pdf-canvas" });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    this.rendering.set(n, task);
    try {
      await task.promise;
      if (this.destroyed) return;
      p.canvas.replaceWith(canvas);
      p.canvas = canvas;
      p.drawn = s;
      p.stale = false;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") console.warn("[wiki] pdf page", n, error);
    } finally {
      this.rendering.delete(n);
    }
  }

  /** How far into the current page the view is (0..1), to keep the place when sizes change. */
  pageOffset() {
    const p = this.pages[this.current - 1];
    if (!p) return 0;
    const top = p.holder.offsetTop - this.body.offsetTop;
    return Math.max(0, Math.min(1, (this.body.scrollTop - top) / Math.max(1, p.holder.offsetHeight)));
  }

  goTo(n, smooth = true, offset = 0) {
    const page = Math.max(1, Math.min(this.pages.length || 1, n));
    const p = this.pages[page - 1];
    this.current = page;
    if (p) {
      const top = p.holder.offsetTop - this.pages[0].holder.offsetTop + offset * p.holder.offsetHeight;
      this.body.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    }
    this.updateCounter();
  }

  onScroll() {
    const mid = this.body.scrollTop + this.body.clientHeight / 3;
    const start = this.pages[0]?.holder.offsetTop ?? 0;
    let at = 1;
    for (const p of this.pages) if (p.holder.offsetTop - start <= mid) at = p.n;
    if (at !== this.current) {
      this.current = at;
      this.updateCounter();
    }
  }

  updateCounter() {
    this.counter.textContent = this.doc ? `${this.current} / ${this.doc.numPages}` : "…";
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(5, z));
    this.layout();
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    this.resize?.disconnect();
    for (const t of this.rendering.values()) t.cancel?.();
  }
}

/** Show the PDF embed in `host` once it comes near the screen (pdf.js loads only for PDFs someone looks at). */
export function mountPdf(app, host, { name, page = 1, height = null }) {
  const placeholder = el("div", { class: "pdf-view pending" },
    el("div", { class: "pdf-bar" }, icon("file-text"), el("span", { class: "pdf-name" }, name)),
    el("div", { class: "pdf-pages", style: { height: `${height ?? (narrow() ? 420 : 560)}px` } },
      el("div", { class: "pdf-loading" }, "PDF")));
  host.replaceChildren(placeholder);
  let view = null;
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    view = new PdfView(app, host, { name, page, height });
  }, { rootMargin: "400px 0px" });
  io.observe(host);
  // Removed from the page (drawn again): stop. The host may not be in the page yet (the editor's widgets).
  let seen = host.isConnected;
  const gone = new MutationObserver(() => {
    if (host.isConnected) {
      seen = true;
      return;
    }
    if (!seen) return;
    gone.disconnect();
    io.disconnect();
    view?.destroy();
  });
  gone.observe(document.body, { childList: true, subtree: true });
}

/** The PDF over the whole panel. */
export function openPdfFull(app, name, page = 1) {
  document.querySelector(".wiki-pdf-full")?.remove();
  const back = el("div", { class: "wiki-pdf-full", role: "dialog", "aria-modal": "true", "aria-label": name });
  let view = null;
  const close = () => {
    view?.destroy();
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  view = new PdfView(app, back, { name, page, full: true, onClose: close });
  view.body.focus();
  return { close };
}

/**
 * Open the PDF in layr's PDF plugin. That plugin opens files on this PC, so the user saves a copy first (the save
 * dialog); without the dialog (or the plugin) the PDF is downloaded instead.
 */
async function openInPdfPlugin(app, name) {
  try {
    const ref = await layr.files.saveAs({ name, types: [".pdf"] });
    if (!ref) return;
    const { bytes } = await fileBytes(app, name);
    const file = await layr.files.write(ref.id, new Uint8Array(bytes.slice(0)));
    await layr.panels.open("viewer", { file: file?.id ? file : ref }, { plugin: "pdf" });
  } catch (error) {
    if (error?.code === layr.errors?.NOT_AVAILABLE || /not available|unknown/i.test(error?.message ?? "")) {
      await downloadFile(app, name).catch((e) => app.ui.fail(e));
    } else app.ui.fail(error);
  }
}
