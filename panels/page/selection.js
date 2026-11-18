// The bar of selection actions (app.selectionActions: AI rewrite, summarize, …, registered by other parts) that floats
// over a text selection in the editor; on the phone it sits right above the formatting toolbar. It hides when the
// selection is empty, the editor loses the focus, or the page scrolls.
import { el, icon, narrow } from "../app/dom.js";
import { safe } from "./util.js";

/** Follow `editor`'s selection; gives a function that stops. */
export function selectionBar(app, editor, { toolbarHost = null, scroller = null } = {}) {
  let bar = null;
  let timer = null;
  const hide = () => {
    clearTimeout(timer);
    bar?.remove();
    bar = null;
  };
  const actions = () => (safe(() => app.selectionActions?.list?.(), []) ?? [])
    .filter((a) => !a.when || safe(() => a.when(editor, app), false));

  const show = (sel) => {
    const list = actions();
    if (!list.length || !sel || sel.empty || !sel.text?.trim() || (!sel.rect && !narrow())) return hide();
    hide();
    bar = el("div", { class: "wiki-selbar", role: "toolbar", "aria-label": "Selection actions" },
      ...list.map((a) => el("button", {
        class: "wiki-selbar-btn", title: a.title, "aria-label": a.title,
        // The selection stays: the button never takes the focus.
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          hide();
          Promise.resolve().then(() => a.run(editor, app)).catch((e) => app.ui.fail(e));
        },
      }, icon(a.icon ?? "sparkles"), el("span", {}, a.title))));
    document.body.append(bar);
    place(sel);
  };

  const place = (sel) => {
    if (!bar) return;
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    if (narrow()) {
      // Above the editor's phone toolbar (which floats above the keyboard).
      const tb = toolbarHost?.firstElementChild?.getBoundingClientRect();
      const top = tb && tb.height ? tb.top - h - 6 : window.innerHeight - h - 64;
      bar.classList.add("docked");
      bar.style.left = `${Math.max(6, (window.innerWidth - w) / 2)}px`;
      bar.style.top = `${Math.max(6, top)}px`;
      return;
    }
    const r = sel.rect;
    const above = r.top - h - 8;
    const top = above > 8 ? above : r.bottom + 8;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    bar.style.left = `${left}px`;
    bar.style.top = `${Math.min(top, window.innerHeight - h - 8)}px`;
  };

  const onSelection = (sel) => {
    clearTimeout(timer);
    if (!sel || sel.empty) return hide();
    // Wait until the selection settles (a drag sends many).
    timer = setTimeout(() => show(sel), 220);
  };
  const offs = [
    safe(() => editor.on("selection", onSelection)),
    safe(() => editor.on("blur", () => setTimeout(() => {
      if (!bar?.matches(":hover")) hide();
    }, 120))),
  ];
  const onScroll = () => hide();
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    hide();
    for (const off of offs) if (typeof off === "function") safe(off);
    scroller?.removeEventListener("scroll", onScroll);
  };
}
