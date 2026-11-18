// The formatting toolbar (`ed.toolbar(parent)`): a strip above the text on the PC; on the phone a bar that scrolls
// sideways and sits right above the keyboard (it follows `visualViewport`). Buttons never take the focus, so the
// selection and the phone's keyboard stay. Colours come from the settings' palette.
import { CALLOUTS } from "./markdown-ops.js";
import { CALLOUT_ICONS } from "./live.js";
import { h, svg } from "./dom.js";

const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";

let openPopover = null;
function closePopover() {
  openPopover?.remove();
  openPopover = null;
}

/** A small menu under (or, at the bottom of the screen, above) `anchor`. `build(box, close)` fills it. */
export function popover(anchor, build, cls = "") {
  closePopover();
  const box = h("div", { class: `cm-wiki-popover ${cls}`.trim(), role: "menu" });
  box.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("input")) e.preventDefault();
  });
  box.addEventListener("mousedown", (e) => {
    if (!e.target.closest("input")) e.preventDefault();
  });
  build(box, closePopover);
  document.body.append(box);
  openPopover = box;
  const r = anchor.getBoundingClientRect();
  const vv = window.visualViewport;
  const viewH = vv ? vv.height + vv.offsetTop : window.innerHeight;
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  box.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - bw - 6))}px`;
  box.style.top = r.bottom + bh + 6 > viewH && r.top - bh - 6 > 0 ? `${r.top - bh - 4}px` : `${r.bottom + 4}px`;
  const away = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) {
      closePopover();
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    }
  };
  const esc = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
  }, 0);
  return box;
}

const menuItem = (label, icon, run, close, extra = {}) => {
  const b = h("button", { type: "button", class: `cm-wiki-menu-item ${extra.cls ?? ""}`.trim(), role: "menuitem" },
    icon ? h("span", { class: "cm-wiki-menu-icon", html: svg(icon) }) : null, h("span", {}, label),
    extra.key ? h("kbd", {}, extra.key) : null);
  b.addEventListener("click", () => {
    close();
    run();
  });
  return b;
};

function swatches(box, colors, current, pick, close, { none, noneLabel, extra } = {}) {
  const grid = h("div", { class: "cm-wiki-swatches" });
  for (const c of colors) {
    const b = h("button", { type: "button", class: `cm-wiki-swatch${current === c.color ? " on" : ""}`, title: c.name,
      "aria-label": c.name, style: `--swatch:${c.color}` });
    b.addEventListener("click", () => {
      close();
      pick(c.color);
    });
    grid.append(b);
  }
  if (extra) box.append(extra);
  box.append(grid);
  if (none) box.append(menuItem(noneLabel, "eraser", () => pick(null), close));
}

/** Build the toolbar for editor `ed` (index.js) into `parent`. */
export function createToolbar(ed, ctx, parent) {
  const bar = h("div", { class: "cm-wiki-toolbar", role: "toolbar", "aria-label": "Formatting" });
  const strip = h("div", { class: "cm-wiki-toolbar-strip" });
  bar.append(strip);
  const buttons = new Map();
  const run = (cmd, arg) => {
    ed.exec(cmd, arg);
    ed.focus();
  };
  const btn = (id, icon, title, onClick, { key, menu } = {}) => {
    const b = h("button", { type: "button", class: `cm-wiki-tool${menu ? " has-menu" : ""}`, "data-cmd": id,
      title: key ? `${title} (${key})` : title, "aria-label": title, html: svg(icon) });
    if (menu) b.insertAdjacentHTML("beforeend", svg("chevron-down", "cm-tool-chevron"));
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => onClick(b, e));
    buttons.set(id, b);
    strip.append(b);
    return b;
  };
  const sep = () => strip.append(h("span", { class: "cm-wiki-tool-sep" }));
  const colors = () => {
    const list = ctx.settings().colors;
    return Array.isArray(list) && list.length ? list : [];
  };

  btn("undo", "undo-2", "Undo", () => run("undo"), { key: `${MOD}Z` });
  btn("redo", "redo-2", "Redo", () => run("redo"), { key: `${MOD}Y` });
  sep();
  btn("heading", "heading", "Heading", (b) => popover(b, (box, close) => {
    const level = ed.headingLevel();
    box.append(menuItem("Normal text", "pilcrow", () => run("paragraph"), close,
      { key: `${MOD}0`, cls: level === 0 ? "on" : "" }));
    for (let n = 1; n <= 6; n++) {
      box.append(menuItem(`Heading ${n}`, n <= 3 ? `heading-${n}` : "heading", () => run("heading", n), close,
        { key: `${MOD}${n}`, cls: `cm-menu-h${n}${level === n ? " on" : ""}` }));
    }
  }), { menu: true });
  sep();
  btn("bold", "bold", "Bold", () => run("bold"), { key: `${MOD}B` });
  btn("italic", "italic", "Italic", () => run("italic"), { key: `${MOD}I` });
  btn("underline", "underline", "Underline", () => run("underline"), { key: `${MOD}U` });
  btn("strike", "strikethrough", "Strikethrough", () => run("strike"), { key: `${MOD}Shift+X` });
  const colorBtn = btn("color", "baseline", "Text colour", (b) => popover(b, (box, close) => {
    box.append(h("div", { class: "cm-wiki-popover-title" }, "Text colour"));
    swatches(box, colors(), null, (c) => run("color", c), close, { none: true, noneLabel: "Default colour" });
  }), { menu: true });
  colorBtn.classList.add("cm-tool-color");
  btn("highlight", "highlighter", "Highlight", (b, e) => {
    // The button itself highlights in the default yellow; its arrow (or a long press on the phone) picks a colour.
    const arrow = e.target.closest(".cm-tool-chevron") || e.clientX > b.getBoundingClientRect().right - 14;
    if (!arrow) return run("highlight");
    popover(b, (box, close) => {
      box.append(h("div", { class: "cm-wiki-popover-title" }, "Highlight"));
      const plain = menuItem("Default (yellow)", "highlighter", () => run("highlight"), close, { key: `${MOD}Shift+H` });
      swatches(box, colors(), null, (c) => run("highlight", c), close,
        { none: true, noneLabel: "No highlight", extra: plain });
    });
  }, { menu: true, key: `${MOD}Shift+H` });
  btn("sup", "superscript", "Superscript", () => run("sup"));
  btn("sub", "subscript", "Subscript", () => run("sub"));
  sep();
  btn("link", "link", "Link", () => run("link"), { key: `${MOD}K` });
  btn("bullet", "list", "Bullet list", () => run("bullet"));
  btn("numbered", "list-ordered", "Numbered list", () => run("numbered"));
  btn("task", "list-todo", "Task", () => run("task"), { key: `${MOD}Enter ticks it` });
  sep();
  btn("quote", "quote", "Quote", () => run("quote"));
  btn("callout", "message-square-quote", "Callout", (b) => popover(b, (box, close) => {
    box.classList.add("cm-wiki-callout-menu");
    for (const kind of CALLOUTS) {
      const item = menuItem(kind[0].toUpperCase() + kind.slice(1), CALLOUT_ICONS[kind], () => run("callout", kind), close,
        { cls: "cm-callout-item" });
      item.dataset.callout = kind;
      box.append(item);
    }
  }), { menu: true });
  btn("table", "table", "Table", () => run("table"));
  btn("code", "code", "Code", () => {
    const sel = ed.selection();
    if (sel.text.includes("\n") || !ed.lineText().trim()) run("codeblock");
    else run("code");
  });
  btn("math", "sigma", "Math", () => run("math"));
  btn("image", "image", "Picture or file", () => run("image"));

  /** The pressed buttons follow the selection. */
  const sync = () => {
    const st = ed.formatState();
    for (const id of ["bold", "italic", "underline", "strike", "sup", "sub", "code", "highlight", "color"]) {
      buttons.get(id)?.classList.toggle("on", st.formats.has(id));
    }
    buttons.get("heading")?.classList.toggle("on", st.heading > 0);
    buttons.get("bullet")?.classList.toggle("on", st.list === "bullet");
    buttons.get("numbered")?.classList.toggle("on", st.list === "numbered");
    buttons.get("task")?.classList.toggle("on", st.list === "task");
    buttons.get("quote")?.classList.toggle("on", st.quote);
    buttons.get("undo").disabled = !st.canUndo;
    buttons.get("redo").disabled = !st.canRedo;
  };
  const offSel = ed.on("selection", sync);
  const offChange = ed.on("change", sync);

  // The phone: fixed right above the keyboard, which `visualViewport` reveals (the layout viewport doesn't shrink).
  const vv = window.visualViewport;
  const place = () => {
    const floating = narrow();
    bar.classList.toggle("floating", floating);
    if (!floating) {
      bar.style.bottom = "";
      document.documentElement.style.removeProperty("--wiki-toolbar-space");
      return;
    }
    const keyboard = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    bar.style.bottom = `${keyboard}px`;
    document.documentElement.style.setProperty("--wiki-toolbar-space", `${bar.offsetHeight || 44}px`);
  };
  vv?.addEventListener("resize", place);
  vv?.addEventListener("scroll", place);
  window.addEventListener("resize", place);

  parent?.append(bar);
  place();
  sync();
  bar.destroy = () => {
    offSel();
    offChange();
    vv?.removeEventListener("resize", place);
    vv?.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    document.documentElement.style.removeProperty("--wiki-toolbar-space");
    closePopover();
    bar.remove();
  };
  return bar;
}

