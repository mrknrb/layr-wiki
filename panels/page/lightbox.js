// A picture full screen: zoom with the wheel, a pinch or the buttons (around the pointer), drag to move, double-click
// or double-tap to switch between fitting and actual size, ←/→ (or swipe) for the page's other pictures, Esc closes.
import { el, icon } from "../app/dom.js";
import { downloadFile, fileUrl, shortError } from "./util.js";

const MIN = 0.1;
const MAX = 12;

/** `items`: `[{file?, src?, caption}]`; `index`: the one to show first. */
export function openLightbox(app, items, index = 0) {
  if (!items.length) return;
  document.querySelector(".wiki-lightbox")?.remove();
  let at = index;
  let scale = 1;
  let fit = 1;
  let x = 0;
  let y = 0;
  const img = el("img", { class: "lb-img", draggable: "false", alt: "" });
  const stage = el("div", { class: "lb-stage" }, img);
  const caption = el("div", { class: "lb-caption" });
  const count = el("span", { class: "lb-count" });
  const zoomText = el("span", { class: "lb-zoom" });
  const button = (name, title, run) =>
    el("button", { class: "lb-btn", title, "aria-label": title, onclick: (e) => (e.stopPropagation(), run()) }, icon(name));
  const prev = button("chevron-left", "Previous picture (←)", () => go(-1));
  const next = button("chevron-right", "Next picture (→)", () => go(1));
  const box = el("div", { class: "wiki-lightbox", role: "dialog", "aria-modal": "true", "aria-label": "Picture",
    tabindex: "-1" },
  el("div", { class: "lb-bar" }, count, el("span", { class: "lb-spacer" }),
    button("zoom-out", "Zoom out (−)", () => zoomBy(1 / 1.25)), zoomText,
    button("zoom-in", "Zoom in (+)", () => zoomBy(1.25)),
    button("scan", "Fit (0)", () => reset()),
    button("download", "Download", () => {
      const item = items[at];
      if (item.file) downloadFile(app, item.file).catch((e) => app.ui.fail(e));
      else window.open(item.src, "_blank");
    }),
    button("x", "Close (Esc)", () => close())),
  stage, prev, next, caption);

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomText.textContent = `${Math.round(scale * 100)}%`;
  };
  /** Fit the picture into the stage (never enlarged past its own size). */
  const reset = () => {
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    const r = stage.getBoundingClientRect();
    fit = Math.min(1, (r.width - 32) / w, (r.height - 32) / h);
    scale = fit;
    x = 0;
    y = 0;
    apply();
  };
  /** Zoom by `factor` keeping the point (cx, cy) (stage coordinates from its centre) where it is. */
  const zoomBy = (factor, cx = 0, cy = 0) => {
    const next_ = Math.min(MAX, Math.max(MIN, scale * factor));
    const k = next_ / scale;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    scale = next_;
    apply();
  };
  const centred = (e) => {
    const r = stage.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
  };

  const show = () => {
    const item = items[at];
    count.textContent = items.length > 1 ? `${at + 1} / ${items.length}` : "";
    caption.textContent = item.caption && item.caption !== item.file ? item.caption : item.file ?? "";
    prev.hidden = next.hidden = items.length < 2;
    img.removeAttribute("src");
    img.classList.add("loading");
    const src = item.file ? fileUrl(app, item.file) : Promise.resolve(item.src);
    src.then((url) => {
      if (items[at] !== item) return;
      img.onload = () => {
        img.classList.remove("loading");
        reset();
      };
      img.src = url;
    }).catch((error) => {
      caption.textContent = `${item.file}: ${shortError(error)}`;
    });
  };
  const go = (d) => {
    at = (at + d + items.length) % items.length;
    show();
  };

  // ---------- pointer: drag, pinch, double-tap, swipe ----------

  const pointers = new Map();
  let pinch = null;
  let drag = null;
  let lastTap = 0;
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale };
      drag = null;
    } else {
      drag = { sx: e.clientX, sy: e.clientY, x, y, moved: false };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const r = stage.getBoundingClientRect();
      const cx = (a.clientX + b.clientX) / 2 - r.left - r.width / 2;
      const cy = (a.clientY + b.clientY) / 2 - r.top - r.height / 2;
      zoomBy((pinch.scale * dist) / pinch.dist / scale, cx, cy);
    } else if (drag) {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (scale > fit * 1.01) {
        x = drag.x + dx;
        y = drag.y + dy;
        apply();
      }
    }
  });
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || pointers.size) return;
    const dx = e.clientX - drag.sx;
    if (drag.moved && scale <= fit * 1.01 && Math.abs(dx) > 60 && items.length > 1) go(dx < 0 ? 1 : -1);
    else if (!drag.moved) {
      const now = Date.now();
      if (now - lastTap < 300) {
        const [cx, cy] = centred(e);
        if (scale > fit * 1.01) reset();
        else zoomBy(Math.max(2 * fit, 1) / scale, cx, cy);
        lastTap = 0;
      } else {
        lastTap = now;
        // A tap on the dark space around the picture closes it.
        if (e.target === stage) setTimeout(() => lastTap === now && close(), 300);
      }
    }
    drag = null;
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [cx, cy] = centred(e);
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), cx, cy);
  }, { passive: false });

  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(1 / 1.25);
    else if (e.key === "0") reset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onResize = () => reset();
  function close() {
    box.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
  }
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  document.body.append(box);
  box.focus();
  show();
  return { close };
}
