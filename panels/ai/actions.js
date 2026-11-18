// AI actions on selected text in the editor: rewrite clearer, shorter, longer, fix spelling, summarize, translate,
// explain, continue, or a custom instruction. One "AI" entry on the selection; it opens a small popover that lists
// the actions, then shows the result with Replace / Insert below / Copy / Discard. Uses the editor's API (part A):
// selection(), replaceSelection(text), getText(), setText().
import { el, icon } from "../app/dom.js";
import { ACTIONS, ACTION_SYSTEM, LANGUAGES, actionPrompt, cleanResult } from "./prompts.js";
import { renderInto } from "./ask.js";

const LANG_KEY = "wiki.ai.language";
let open = null;
/** Where the editor last said its selection is (viewport px), from its "selection" events. */
let lastRect = null;

function close() {
  open?.remove();
  open = null;
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("pointerdown", onOutside, true);
}
function onKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
function onOutside(e) {
  if (open && !open.contains(e.target)) close();
}

/** Where the selection is on screen: the editor tells it; else the DOM selection; or null. */
function selectionRect() {
  if (lastRect?.width || lastRect?.height) return lastRect;
  try {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  } catch {
    return null;
  }
}

function place(pop, rect) {
  if (window.matchMedia("(max-width: 700px)").matches || !rect) {
    pop.classList.add("docked");
    return;
  }
  const w = Math.min(470, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
  const below = rect.bottom + 8;
  if (below + 260 < window.innerHeight) pop.style.top = `${below}px`;
  else pop.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
}

/** Put `text` where the selection was, even if the user clicked elsewhere meanwhile. */
function replaceAt(ed, sel, text) {
  const now = ed.selection?.();
  if (now && now.from === sel.from && now.to === sel.to) {
    ed.replaceSelection(text);
    return true;
  }
  const doc = ed.getText();
  if (doc.slice(sel.from, sel.to) !== sel.text) return false;
  ed.setText(doc.slice(0, sel.from) + text + doc.slice(sel.to), { keepCursor: true });
  return true;
}

async function run(app, ed, sel, action, { language, instruction }) {
  const doc = ed.getText?.() ?? "";
  const context = doc.slice(Math.max(0, sel.from - 1500), sel.from) + "[…selected text…]" + doc.slice(sel.to, sel.to + 800);
  const page = app.page?.();
  const prompt = actionPrompt(action.id, sel.text, { language, instruction, title: page?.title ?? "", context });
  return cleanResult(await app.ai.ask(prompt, { system: ACTION_SYSTEM }));
}

function popover(app, ed, sel) {
  close();
  const pop = el("div", { class: "ai-pop", role: "dialog", "aria-label": "AI actions" });
  open = pop;
  document.body.append(pop);
  place(pop, selectionRect());
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  let language = localStorage.getItem(LANG_KEY) || "English";

  const menu = () => {
    const custom = el("input", { class: "layr-input", placeholder: "Tell the AI what to do with the text…",
      "aria-label": "Custom instruction" });
    custom.onkeydown = (e) => {
      if (e.key === "Enter" && custom.value.trim()) {
        e.preventDefault();
        go(ACTIONS.find((a) => a.id === "custom"), { instruction: custom.value });
      }
    };
    const lang = el("select", { class: "layr-select ai-pop-lang", "aria-label": "Translate into", onclick: (e) => e.stopPropagation(),
      onchange: (e) => {
        language = e.target.value;
        localStorage.setItem(LANG_KEY, language);
      } }, LANGUAGES.map((l) => el("option", { value: l, selected: l === language }, l)));
    pop.replaceChildren(
      el("div", { class: "ai-pop-head" }, icon("sparkles"), el("span", {}, "AI"),
        el("span", { class: "layr-muted ai-pop-count" }, `${sel.text.length} characters`),
        el("button", { class: "layr-button ghost icon small", title: "Close (Esc)", onclick: close }, icon("x"))),
      el("div", { class: "ai-pop-custom" }, custom,
        el("button", { class: "layr-button primary icon small", title: "Run", onclick: () => custom.value.trim() &&
          go(ACTIONS.find((a) => a.id === "custom"), { instruction: custom.value }) }, icon("send"))),
      el("div", { class: "ai-pop-actions" }, ACTIONS.filter((a) => a.id !== "custom").map((a) =>
        el("div", { class: "ai-pop-row" },
          el("button", { class: "ai-pop-action", onclick: () => go(a, {}) }, icon(a.icon), el("span", {}, a.title)),
          a.id === "translate" ? lang : null))));
    if (!window.matchMedia("(max-width: 700px)").matches) custom.focus();
  };

  const go = async (action, { instruction = "" }) => {
    pop.replaceChildren(el("div", { class: "ai-pop-head" }, icon(action.icon), el("span", {}, action.id === "custom"
      ? "Custom instruction" : action.id === "translate" ? `Translate into ${language}` : action.title)),
    el("div", { class: "ai-pop-busy" }, el("span", { class: "layr-spinner" }), "Working…"));
    let text;
    try {
      text = await run(app, ed, sel, action, { language, instruction });
    } catch (error) {
      if (open !== pop) return;
      pop.replaceChildren(el("div", { class: "ai-pop-head" }, icon("triangle-alert"), el("span", {}, "Didn't work")),
        el("p", { class: "layr-error ai-pop-error" }, error.message),
        el("div", { class: "ai-pop-buttons" }, el("button", { class: "layr-button", onclick: menu }, "Back"),
          el("button", { class: "layr-button ghost", onclick: close }, "Close")));
      return;
    }
    if (open !== pop) return;
    const preview = el("div", { class: "ai-pop-result wiki-content" });
    renderInto(app, preview, text);
    const readOnly = action.id === "explain";
    const done = (ok, what) => {
      if (!ok) {
        app.ui.notify("The text changed meanwhile: select it again", "error");
        return;
      }
      close();
      ed.focus?.();
      if (what) app.ui.notify(what, "success");
    };
    pop.replaceChildren(
      el("div", { class: "ai-pop-head" }, icon(action.icon), el("span", {}, action.title),
        el("button", { class: "layr-button ghost icon small", title: "Close (Esc)", onclick: close }, icon("x"))),
      preview,
      el("div", { class: "ai-pop-buttons" },
        readOnly ? null : el("button", { class: "layr-button primary", onclick: () =>
          done(replaceAt(ed, sel, action.id === "continue" ? `${sel.text}${/\s$/.test(sel.text) ? "" : " "}${text}` : text)) },
        icon("replace"), action.id === "continue" ? "Add after" : "Replace"),
        el("button", { class: `layr-button${readOnly ? " primary" : ""}`, onclick: () =>
          done(replaceAt(ed, sel, `${sel.text}\n\n${text}`)) }, icon("text-cursor-input"), "Insert below"),
        el("button", { class: "layr-button", onclick: async () => {
          await navigator.clipboard.writeText(text).then(() => app.ui.notify("Copied", "success"),
            () => app.ui.notify("Couldn't copy", "error"));
        } }, icon("copy"), "Copy"),
        el("button", { class: "layr-button ghost", title: "Run it again", onclick: () => go(action, { instruction }) },
          icon("refresh-cw")),
        el("button", { class: "layr-button ghost", onclick: close }, "Discard")));
  };
  menu();
}

export function installActions(app) {
  app.on?.("selection", (d) => (lastRect = d?.rect ?? null));
  const enabled = () => app.ai.available() && app.settings?.get?.("aiActions") !== false;
  app.selectionActions?.register({
    id: "ai",
    title: "AI",
    icon: "sparkles",
    when: enabled,
    run(ed) {
      if (!enabled()) {
        app.ui.notify(app.ai.available() ? "AI actions are off in the wiki's settings (AI)." :
          "AI actions need the Claude Code plugin (see Ask your wiki).", "info");
        return;
      }
      const sel = ed.selection?.();
      if (!sel || sel.from === sel.to || !sel.text?.trim()) {
        app.ui.notify("Select some text first", "info");
        return;
      }
      popover(app, ed, sel);
    },
  });
  app.commands?.register({ id: "ai-selection", title: "AI actions on the selected text", icon: "sparkles",
    key: "ctrl+j", when: () => enabled() && Boolean(app.editor),
    run: () => {
      const ed = app.editor;
      const sel = ed?.selection?.();
      if (!ed || !sel?.text?.trim()) return app.ui.notify("Select some text in the editor first", "info");
      popover(app, ed, sel);
    } });
}
