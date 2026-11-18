// app.ui: dialogs, menus and messages every part uses (PLAN.md › The panel).
import { add, ago, el, icon, narrow } from "./dom.js";
import { ICONS } from "./icons.js";

const notify = (text, kind = "info") => {
  try {
    return layr.ui.notify(String(text), kind).catch(() => toast(text, kind));
  } catch {
    return toast(text, kind);
  }
};

/** A message in the panel itself, for when layr can't show one (a page outside the app, tests). */
function toast(text, kind) {
  let box = document.querySelector(".wiki-toasts");
  if (!box) add(document.body, (box = el("div", { class: "wiki-toasts", role: "status" })));
  const item = el("div", { class: `wiki-toast ${kind}` }, String(text));
  add(box, item);
  setTimeout(() => item.remove(), kind === "error" ? 6000 : 3000);
}

const fail = (error) => {
  console.error(error);
  return notify(error?.message ?? String(error), "error");
};

/**
 * A dialog. `build(body, close)` fills `body`; it may return `{ok, danger, run, focus, wide, cancel}`: then the dialog
 * has Cancel and OK buttons, Enter runs `run` (errors show in the dialog), Escape closes. Gives `{close, box, body}`.
 */
function modal(title, build, { onClose } = {}) {
  const back = el("div", { class: "wiki-modal-back" });
  const box = el("div", { class: "wiki-modal", role: "dialog", "aria-modal": "true", "aria-label": title });
  const body = el("div", { class: "wiki-modal-body" });
  const error = el("div", { class: "layr-error wiki-modal-error" });
  const before = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
    if (before?.isConnected) before.focus?.({ preventScroll: true });
  };
  const spec = build?.(body, close) ?? {};
  const run = async () => {
    if (!spec.run) return close();
    error.textContent = "";
    okButton?.setAttribute("disabled", "");
    try {
      await spec.run();
    } catch (err) {
      error.textContent = err?.message ?? String(err);
    } finally {
      okButton?.removeAttribute("disabled");
    }
  };
  const onKey = (e) => {
    if (!back.isConnected || back !== document.querySelector(".wiki-modal-back:last-of-type")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && spec.run && !e.shiftKey && e.target.tagName !== "TEXTAREA" &&
      !e.target.closest?.("[data-keep-enter]")) {
      e.preventDefault();
      run();
    }
  };
  document.addEventListener("keydown", onKey, true);
  box.classList.toggle("wide", Boolean(spec.wide));
  add(box, 
    el("div", { class: "wiki-modal-head" }, el("span", { class: "wiki-modal-title" }, title),
      el("button", { class: "layr-button ghost icon small", "aria-label": "Close", title: "Close", onclick: close },
        icon("x"))),
    body, error);
  let okButton = null;
  if (spec.run) {
    okButton = el("button", { class: `layr-button ${spec.danger ? "danger" : "primary"}`, onclick: run },
      spec.ok ?? "OK");
    add(box, el("div", { class: "wiki-modal-foot" },
      el("button", { class: "layr-button", onclick: close }, spec.cancel ?? "Cancel"), okButton));
  }
  add(back, box);
  back.addEventListener("mousedown", (e) => e.target === back && close());
  add(document.body, back);
  setTimeout(() => (spec.focus ?? box.querySelector("input, select, textarea, button.primary"))?.focus(), 0);
  return { close, box, body };
}

/** Ask for a line of text: the text, or null when cancelled. */
function prompt(title, { value = "", placeholder = "", label = "", ok = "OK", check = null } = {}) {
  return new Promise((resolve) => {
    let result = null;
    modal(title, (body, close) => {
      const input = el("input", { class: "layr-input", value, placeholder, spellcheck: "false" });
      const problem = el("div", { class: "layr-error" });
      if (check) input.addEventListener("input", () => (problem.textContent = check(input.value.trim()) ?? ""));
      add(body, label ? el("label", { class: "layr-label" }, label) : null, input, problem);
      setTimeout(() => input.select(), 0);
      return {
        ok,
        focus: input,
        run: () => {
          const v = input.value.trim();
          const p = check?.(v);
          if (p) throw new Error(p);
          result = v;
          close();
        },
      };
    }, { onClose: () => resolve(result) });
  });
}

/** Ask yes or no: true when confirmed. */
function confirm(text, { danger = false, ok = "OK", title = "Are you sure?", detail = "" } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal(title, (body, close) => {
      add(body, el("p", { class: "wiki-confirm-text" }, text), detail ? el("p", { class: "layr-muted" },
        detail) : null);
      return { ok, danger, run: () => ((result = true), close()) };
    }, { onClose: () => resolve(result) });
  });
}

/**
 * A context menu: layr's own (drawn by the app, so it can reach past the panel), or the panel's when the page isn't
 * in the layr app. Items as layr.ui.contextMenu takes them ({label, icon, shortcut, disabled, checked, danger, run,
 * items} or "-"); `icon` is a Material name for layr's menu, also looked up in the panel's icons.
 */
async function menu(items, event) {
  const list = (items ?? []).filter((it) => it && (it === "-" || !it.hidden));
  // Separators next to each other or at the ends come from items left out: drop them.
  const clean = list.filter((it, i) => it !== "-" || (i > 0 && i < list.length - 1 && list[i + 1] !== "-"));
  try {
    return await layr.ui.contextMenu(clean.map(forLayr), event);
  } catch (error) {
    if (error?.code !== layr.errors?.NOT_AVAILABLE) throw error;
    return ownMenu(clean, event);
  }
}

// layr's menu draws Material icons; parts often pass Lucide names (the panel's own): translate the common ones and
// leave out other Lucide-looking names (with a dash) rather than show a broken icon.
const MATERIAL = {
  "trash-2": "delete", trash: "delete", pencil: "edit", "square-pen": "edit", "external-link": "open_in_new",
  copy: "content_copy", "file-plus": "note_add", "folder-plus": "create_new_folder", "folder-input": "drive_file_move",
  printer: "print", globe: "public", sparkles: "auto_awesome", x: "close", "rotate-ccw": "undo", "share-2": "share",
  scissors: "content_cut", "file-text": "description", tag: "label", tags: "label", "arrow-right": "arrow_forward",
  "arrow-left": "arrow_back", "arrow-up": "arrow_upward", "arrow-down": "arrow_downward", eye: "visibility",
  "eye-off": "visibility_off", languages: "translate", "wand-sparkles": "auto_fix_high", wand: "auto_fix_high",
  "spell-check": "spellcheck", "file-down": "download", "message-square-text": "chat", "list-todo": "checklist",
  "table-2": "table_chart", table: "table_chart", waypoints: "hub", "calendar-days": "calendar_month",
  calendar: "calendar_today", paperclip: "attach_file", "lock-open": "lock_open", pin: "push_pin", plus: "add",
  minus: "remove", "folder-tree": "account_tree", "maximize-2": "fullscreen", "clipboard-check": "fact_check",
  house: "home", "bookmark-plus": "bookmark_add", "bookmark-minus": "bookmark_remove", "file-x": "delete",
  "refresh-cw": "refresh", "list-checks": "checklist", "text-search": "manage_search", hash: "tag",
  "circle-question-mark": "help", info: "info", "triangle-alert": "warning", files: "file_copy", "file-up": "upload",
};
function forLayr(item) {
  if (!item || item === "-") return item;
  const out = { ...item };
  if (out.icon) {
    const m = MATERIAL[out.icon];
    if (m) out.icon = m;
    else if (out.icon.includes("-")) delete out.icon;
  }
  if (Array.isArray(out.items)) out.items = out.items.map(forLayr);
  // layr calls run on the item it is given: keep the original's.
  return out;
}

function ownMenu(items, event) {
  document.querySelector(".wiki-menu")?.remove();
  return new Promise((resolve) => {
    event?.preventDefault?.();
    const box = el("div", { class: "wiki-menu", role: "menu" });
    const done = (item) => {
      box.remove();
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", onKey, true);
      if (item?.run) Promise.resolve().then(() => item.run(item)).catch(fail);
      resolve(item ?? null);
    };
    const away = (e) => !box.contains(e.target) && done(null);
    const onKey = (e) => {
      const rows = [...box.querySelectorAll(".wiki-menu-item:not([disabled])")];
      const at = rows.indexOf(document.activeElement);
      if (e.key === "Escape") done(null);
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        rows[(at + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const fill = (parent, list) => {
      for (const it of list) {
        if (it === "-") {
          add(parent, el("div", { class: "wiki-menu-sep" }));
          continue;
        }
        const row = el("button", { class: `wiki-menu-item${it.danger ? " danger" : ""}`, role: "menuitem",
          disabled: it.disabled || null },
        el("span", { class: "wiki-menu-icon" },
          it.checked ? icon("check") : it.icon && ICONS[it.icon] ? icon(it.icon) : null),
        el("span", { class: "wiki-menu-label" }, it.label),
        it.shortcut ? el("span", { class: "wiki-menu-key" }, it.shortcut) : null,
        it.items ? icon("chevron-right") : null);
        if (it.items) {
          const sub = el("div", { class: "wiki-menu sub", role: "menu" });
          fill(sub, it.items);
          const wrap = el("div", { class: "wiki-menu-parent" }, row, sub);
          add(parent, wrap);
        } else {
          row.addEventListener("click", () => done(it));
          add(parent, row);
        }
      }
    };
    fill(box, items);
    add(document.body, box);
    const p = event?.touches?.[0] ?? event?.changedTouches?.[0] ?? event ?? {};
    let x = p.clientX ?? p.x ?? window.innerWidth / 2;
    let y = p.clientY ?? p.y ?? window.innerHeight / 3;
    if (!event?.clientX && event?.currentTarget?.getBoundingClientRect) {
      const r = event.currentTarget.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 2;
    }
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
    setTimeout(() => {
      document.addEventListener("mousedown", away, true);
      document.addEventListener("keydown", onKey, true);
      box.querySelector(".wiki-menu-item:not([disabled])")?.focus({ preventScroll: true });
    }, 0);
  });
}

export function makeUi() {
  return { el, icon, modal, prompt, confirm, menu, notify, fail, ago, narrow };
}
