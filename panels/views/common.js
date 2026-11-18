// Helpers the views share: popovers, dragging by pointer (mouse and touch), type icons and colours, attachment
// pictures as blob: URLs, and the saved views.
import { el, icon } from "../app/dom.js";
import { deleteView, listViews, normalizeView, saveView } from "../../shared/query.js";
import { keyOf } from "../../shared/links.js";

export { el, icon };

/** Colours for things without their own (folders, types without a colour), readable on light and dark. */
export const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
  "#9c755f", "#3d9df3", "#8cd17d", "#d37295", "#499894", "#f1ce63", "#a0cbe8", "#86bcb6"];
export function hashColor(text) {
  let h = 0;
  for (const ch of String(text ?? "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** A type's colour: its own, else one from its name. */
export const typeColor = (wiki, name) => (name ? wiki.type?.(name)?.color || hashColor(keyOf(name)) : null);

/** A type's icon (an emoji, or a Lucide name) as an element; `file-text` for a type without a definition. */
export function typeIcon(wiki, name, cls = "") {
  const t = name ? wiki.type?.(name) : null;
  const ic = t?.icon || (name ? "file-text" : "file");
  if (/^[a-z0-9-]+$/.test(ic)) {
    const span = icon(ic, `vw-ticon ${cls}`.trim());
    if (name) span.style.color = typeColor(wiki, name);
    return span;
  }
  return el("span", { class: `vw-ticon vw-emoji ${cls}`.trim() }, ic);
}

/** A small button: `button("plus", "New", fn, {cls, title})`; no label → an icon button. */
export function button(ic, label, onclick, { cls = "", title = null } = {}) {
  const ghost = !label && !/(primary|danger)/.test(cls) ? "ghost" : "";
  return el("button", { class: `layr-button small ${label ? "" : `icon ${ghost}`} ${cls}`.trim(), type: "button",
    title: title ?? label ?? null, "aria-label": title ?? label ?? null, onclick },
  ic ? icon(ic) : null, label ? el("span", {}, label) : null);
}

// ---------- popovers ----------

let openPop = null;

/** Close the open popover (if any). */
export function closePopover() {
  openPop?.close();
}

/**
 * A popover under `anchor` with what `build(body, close)` puts in it; closes on a click outside, Escape, or another
 * popover. Gives `{el, close}`.
 */
export function popover(anchor, build, { cls = "", onClose = null } = {}) {
  closePopover();
  const body = el("div", { class: `vw-pop ${cls}`.trim(), role: "dialog" });
  document.body.append(body);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(body.offsetWidth || 320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const h = body.offsetHeight;
    const top = below + h > window.innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below;
    body.style.left = `${left}px`;
    body.style.top = `${Math.max(8, top)}px`;
    body.style.maxHeight = `${window.innerHeight - Math.max(8, top) - 8}px`;
  };
  const onDown = (e) => {
    if (!body.contains(e.target) && !anchor.contains(e.target) && !e.target.closest?.(".vw-pop")) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    if (openPop !== handle) return;
    openPop = null;
    body.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    onClose?.();
  };
  const handle = { el: body, close, place };
  openPop = handle;
  build(body, close);
  place();
  requestAnimationFrame(place);
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  return handle;
}

// ---------- dragging by pointer ----------

/**
 * Let `item` be dragged onto targets (elements matching `targets`, found under the pointer). Mouse: starts after a
 * few pixels; touch: after holding still for a moment, so swiping still scrolls. `drop(target, item)` when let go on
 * a target; the target under the pointer gets the class `vw-drop` meanwhile.
 */
export function draggable(item, { targets, drop, ghost = true, handle = null }) {
  let start = null;
  let timer = null;
  let dragging = false;
  let shadow = null;
  let over = null;
  const from = handle ?? item;
  const setOver = (t) => {
    if (over === t) return;
    over?.classList.remove("vw-drop");
    over = t;
    over?.classList.add("vw-drop");
  };
  const begin = (e) => {
    dragging = true;
    item.classList.add("vw-dragging");
    document.body.classList.add("vw-drag-on");
    if (ghost) {
      const r = item.getBoundingClientRect();
      shadow = item.cloneNode(true);
      shadow.classList.add("vw-ghost");
      Object.assign(shadow.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
      shadow.dataset.dx = String(e.clientX - r.left);
      shadow.dataset.dy = String(e.clientY - r.top);
      document.body.append(shadow);
    }
    navigator.vibrate?.(10);
  };
  const move = (e) => {
    if (!start || e.pointerId !== start.id) return;
    if (!dragging) {
      const far = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6;
      if (start.touch) {
        if (far) cancel(); // a swipe: let it scroll
        return;
      }
      if (!far) return;
      begin(e);
    }
    e.preventDefault();
    if (shadow) {
      shadow.style.left = `${e.clientX - Number(shadow.dataset.dx)}px`;
      shadow.style.top = `${e.clientY - Number(shadow.dataset.dy)}px`;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    setOver(under?.closest?.(targets) ?? null);
  };
  const up = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const target = over;
    const was = dragging;
    cancel();
    if (was) {
      // The click that follows a drag must not open the card.
      const stop = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      item.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => item.removeEventListener("click", stop, { capture: true }), 50);
      if (target) drop(target, item);
    }
  };
  const cancel = () => {
    clearTimeout(timer);
    start = null;
    dragging = false;
    item.classList.remove("vw-dragging");
    document.body.classList.remove("vw-drag-on");
    shadow?.remove();
    shadow = null;
    setOver(null);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
  };
  from.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("input, select, textarea, button:not(.vw-drag-ok)")) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === "touch" };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    if (start.touch) timer = setTimeout(() => start && begin(e), 380);
  });
  // A long press on touch shows no context menu while it drags.
  from.addEventListener("contextmenu", (e) => dragging && e.preventDefault());
  from.addEventListener("touchmove", (e) => dragging && e.preventDefault(), { passive: false });
}

// ---------- attachments as pictures ----------

const urls = new Map(); // file name (lowercase) → Promise<url|null>

/** A blob: URL for an attachment (or the `url` when it is a web address), cached; null when it can't be loaded. */
export function fileUrl(app, name) {
  const n = String(name ?? "").trim();
  if (!n) return Promise.resolve(null);
  if (/^(https?:|data:|blob:)/i.test(n)) return Promise.resolve(n);
  const key = n.toLowerCase();
  if (!urls.has(key)) {
    const p = (async () => {
      try {
        if (app.files?.url) return await app.files.url(n);
        const { record, bytes } = await app.files.download(n);
        return URL.createObjectURL(new Blob([bytes], { type: record.mime || "application/octet-stream" }));
      } catch {
        urls.delete(key);
        return null;
      }
    })();
    urls.set(key, p);
  }
  return urls.get(key);
}

export const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** Load `name` into `img` when it scrolls into view. */
export function lazyImage(app, img, name, onFail = null) {
  const load = async () => {
    const url = await fileUrl(app, name);
    if (url) img.src = url;
    else onFail?.();
  };
  if (!("IntersectionObserver" in window)) return void load();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      load();
    }
  }, { rootMargin: "200px" });
  io.observe(img);
}

// ---------- saved views ----------

/** The saved views, read again when they change. `app.savedViews` is shared by the views part. */
export class SavedViews {
  constructor(app) {
    this.app = app;
    this.list = [];
    this.listeners = new Set();
    this.loading = null;
  }
  async load() {
    this.loading = listViews(this.app.wiki.a).then((list) => {
      this.list = list;
      for (const fn of this.listeners) fn(list);
      return list;
    }, () => this.list);
    return this.loading;
  }
  ready() {
    return this.loading ?? this.load();
  }
  get(id) {
    return this.list.find((v) => v.id === id) ?? null;
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async save(view) {
    const v = await saveView(this.app.wiki, view);
    const i = this.list.findIndex((x) => x.id === v.id);
    if (i >= 0) this.list[i] = v;
    else this.list.push(v);
    this.list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const fn of this.listeners) fn(this.list);
    return v;
  }
  async remove(id) {
    await deleteView(this.app.wiki, id);
    this.list = this.list.filter((v) => v.id !== id);
    for (const fn of this.listeners) fn(this.list);
  }
  /** A view of `source`'s pages (one that has just that source already, unless `fresh`); opened. */
  async createFor(source = {}, { name = null, layout = "table", fresh = false, open = true, newTab = false } = {}) {
    await this.ready();
    const clean = normalizeView({ source }).source;
    const same = (v) => ["folder", "type", "tag", "query"].every((k) => keyOf(v.source[k] ?? "") === keyOf(clean[k] ?? ""));
    let view = fresh ? null : this.list.find((v) => same(v) && !v.filters.length);
    if (!view) {
      const type = clean.type ? this.app.wiki.type?.(clean.type) : null;
      const fields = (type?.fields ?? []).slice(0, 6).map((f) => f.key);
      view = await this.save({
        name: name ?? (clean.type ? `All ${clean.type} pages` : clean.folder ? clean.folder.split("/").pop()
          : clean.tag ? `#${clean.tag.replace(/^#/, "")}` : clean.query ? `“${clean.query}”` : "New view"),
        icon: clean.type ? "table" : clean.folder ? "folder" : clean.tag ? "hash" : "table",
        source: clean,
        layout,
        columns: ["title", ...(clean.type ? [] : ["type"]), ...fields, ...(clean.folder ? [] : ["folder"]), "updated"],
        groupBy: type?.fields?.find((f) => f.kind === "select")?.key ?? null,
      });
    }
    if (open) this.app.open({ view: "view", id: view.id }, { newTab });
    return view;
  }
}

/** Every folder the wiki has ("" left out), from the model's list or from the pages. */
export function allFolders(wiki) {
  if (wiki.folders) return wiki.folders().filter(Boolean);
  const set = new Set();
  for (const p of wiki.live()) {
    const parts = String(p.folder ?? "").split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Every type name in use or defined: `[{name, count, defined}]`. */
export function typesInUse(wiki) {
  if (wiki.typesInUse) return wiki.typesInUse();
  const by = new Map();
  for (const t of wiki.types?.() ?? []) by.set(keyOf(t.name), { name: t.name, count: 0, defined: true });
  for (const p of wiki.live()) {
    if (!p.type) continue;
    if (!by.has(keyOf(p.type))) by.set(keyOf(p.type), { name: p.type, count: 0, defined: false });
    by.get(keyOf(p.type)).count++;
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every tag of the live pages, A to Z. */
export function allTags(wiki) {
  const set = new Map();
  for (const p of wiki.live()) for (const t of p.tags) if (!set.has(keyOf(t))) set.set(keyOf(t), t);
  return [...set.values()].sort((a, b) => a.localeCompare(b));
}

/** Subscribe to wiki changes while a view is shown, redrawing (debounced) unless the user is typing in it. */
export function watch(app, root, draw, { ms = 120, filter = null } = {}) {
  let timer = null;
  let pending = false;
  const run = () => {
    timer = null;
    if (root.contains(document.activeElement) && document.activeElement.matches("input, textarea, select")) {
      pending = true;
      return;
    }
    pending = false;
    draw();
  };
  const onFocusOut = () => pending && setTimeout(run, 50);
  root.addEventListener("focusout", onFocusOut);
  const off = app.on?.("changed", (data) => {
    if (filter && !filter(data ?? {})) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  });
  return () => {
    clearTimeout(timer);
    off?.();
    root.removeEventListener("focusout", onFocusOut);
  };
}

/** Report an error the way the shell does (or in the console when there is no shell). */
export function fail(app, error) {
  if (app.ui?.fail) app.ui.fail(error);
  else console.error(error);
}

/** Open a page by id: in a new tab with Ctrl/Cmd or the middle button. */
export function openPage(app, id, e = null, opts = {}) {
  app.openPage(id, { ...opts, newTab: Boolean(e && (e.ctrlKey || e.metaKey || e.button === 1)) });
}

/** A link to a page that the shell handles (open, Ctrl+click new tab, hover preview). */
export const pageLink = (page, text = null) =>
  el("a", { class: "wl vw-link", "data-page": page.title, href: "#" }, text ?? page.title);
