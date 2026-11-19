// Ask Claude: what the user writes goes to a Claude thread (the Claude Code plugin) that opens beside the wiki, so
// there is one kind of chat in layr and it can use every plugin (Research data, web pages, Concepts…), not only the
// wiki. The thread works in the wiki's own folder (backend/threads.js: nothing there but its CLAUDE.md) and starts
// locked to what Tool access allows: it may read, search the web and call layr's tools (each as Settings › Tool
// access says), never edit files or run programs (`dontAsk` with THREAD_TOOLS). The next message continues the same
// thread until the user starts a new one. Chats from before (data `ask/<id>`) can still be read.
import { el, icon } from "../app/dom.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { THREAD_TOOLS } from "./client.js";
import { chatTitle, citedPages, threadMessage } from "./prompts.js";

const LAST = "askThread";
const state = { last: undefined, busy: false, error: null, fresh: false, old: null, reading: null };
const subscribers = new Set();
const redraw = () => subscribers.forEach((fn) => fn());

/** Markdown into an element: the page part's renderer (embeds, highlighting) when it is there. */
export async function renderInto(app, root, markdown, page = null) {
  if (app.markdown) {
    try {
      await app.markdown(root, markdown, { page, depth: 1 });
      return;
    } catch {
      // fall back to the plain renderer
    }
  }
  const resolve = (t) => {
    const p = app.wiki.resolve(t);
    return p ? { title: p.title, exists: true } : { title: t, exists: false };
  };
  root.innerHTML = renderMarkdown(markdown, { resolve });
}

/** What the AI needs when it isn't usable: install or allow Claude Code. */
export function unavailableCard(app, what = "Ask Claude", group = "Start, steer and stop threads") {
  return el("div", { class: "ai-unavailable layr-card" },
    el("div", { class: "ai-unavailable-icon" }, icon("sparkles")),
    el("h3", {}, `${what} needs Claude Code`),
    el("p", { class: "layr-muted" },
      "Install the Claude Code plugin from layr's store and sign in to Claude Code on your PC. The first time, layr asks " +
        `whether the wiki may use “${group}”; if you said no, allow it in Settings › Tool access.`),
    el("button", { class: "layr-button", onclick: () => app.ai.check() }, icon("refresh-cw"), "Check again"));
}

async function lastThread() {
  if (state.last === undefined) state.last = await layr.data.get(LAST).catch(() => null) ?? null;
  return state.last;
}

async function oldChats() {
  if (state.old) return state.old;
  try {
    const rows = await layr.data.list({ prefix: "ask/", limit: 500 });
    state.old = rows.map((r) => r.value).filter((c) => c?.id && Array.isArray(c.messages))
      .sort((a, b) => b.updated - a.updated);
  } catch {
    state.old = [];
  }
  return state.old;
}

const value = (r) => {
  if (typeof r !== "string") return r;
  try {
    return JSON.parse(r);
  } catch {
    return r;
  }
};

/** A new thread in the wiki's folder (the project "Wiki"), locked to reading and layr's tools. */
async function startThread(app, text, message) {
  const folder = value(await layr.tools.run("thread_folder", {}));
  if (!folder?.path) throw new Error("The wiki couldn't make its threads' folder");
  const added = await app.ai.claude("project_add", { path: folder.path, name: "Wiki" });
  const project = added?.project?.id;
  if (!project) {
    layr.problem?.("claude-project-add", { got: added });
    throw new Error("Claude Code didn't add the wiki's folder as a project");
  }
  const started = await app.ai.claude("thread_start", { project, prompt: message, title: chatTitle(text),
    permissionMode: "dontAsk", allowedTools: THREAD_TOOLS });
  const thread = started?.thread;
  if (!thread?.id) {
    layr.problem?.("claude-thread-start", { got: started });
    throw new Error("Claude Code didn't start the thread");
  }
  state.last = { id: thread.id, title: thread.title ?? chatTitle(text), at: Date.now() };
  await layr.data.set(LAST, state.last).catch(() => {});
  return thread.id;
}

async function send(app, text) {
  const q = text.trim();
  if (!q || state.busy) return false;
  state.busy = true;
  state.error = null;
  redraw();
  try {
    const route = app.route?.();
    const message = threadMessage(q, { page: route?.view === "page" ? app.page?.() : null });
    const last = state.fresh ? null : await lastThread();
    let id = null;
    if (last?.id) {
      try {
        await app.ai.claude("thread_send", { thread: last.id, text: message });
        id = last.id;
      } catch (error) {
        // The thread was deleted in Claude Code: start a new one; anything else is the user's to see.
        if (!/no thread/i.test(error.message)) throw error;
      }
    }
    id ??= await startThread(app, q, message);
    state.fresh = false;
    await layr.panels.open("thread", { thread: id }, { plugin: "claude", where: "right", reuse: true });
    return true;
  } catch (error) {
    state.error = error.message;
    return false;
  } finally {
    state.busy = false;
    redraw();
  }
}

function openThread(id) {
  layr.panels.open("thread", { thread: id }, { plugin: "claude", where: "right", reuse: true })
    .catch((error) => {
      state.error = error.message;
      redraw();
    });
}

/** A chat from before threads, read only. */
function oldChatView(app, chat) {
  const thread = el("div", { class: "ai-ask-thread" });
  for (const m of chat.messages) {
    if (m.role === "user") {
      thread.append(el("div", { class: "ai-msg user" }, el("div", { class: "ai-bubble" }, m.text)));
      continue;
    }
    const body = el("div", { class: "ai-answer wiki-content" });
    if (m.error) body.append(el("div", { class: "layr-error" }, m.text));
    else renderInto(app, body, m.text);
    const cited = citedPages(app.wiki, m.text);
    thread.append(el("div", { class: `ai-msg ai${m.error ? " error" : ""}` }, body,
      cited.length ? el("div", { class: "ai-sources" }, el("span", { class: "layr-muted" }, "Cited:"),
        cited.map((p) => el("button", { class: "ai-chip cited", onclick: (e) => app.openPage(p.id, { newTab: e.ctrlKey || e.metaKey }) },
          p.title))) : null));
  }
  return thread;
}

const EXAMPLES = ["What do my notes say about …?", "Summarize the open page and link related pages",
  "Bring the results of my last experiment into a new page"];

/** The launcher, full size (route `ask`) or in the right sidebar (`compact`). */
export function renderAsk(app, root, { compact = false } = {}) {
  root.classList.add("ai-ask-host");
  const view = el("div", { class: `ai-ask${compact ? " compact" : ""}` });
  root.replaceChildren(view);
  let draft = "";
  const draw = async () => {
    if (!app.ai.canThread()) {
      view.replaceChildren(unavailableCard(app));
      return;
    }
    const [last, old] = await Promise.all([lastThread(), oldChats()]);
    const reading = state.reading ? old.find((c) => c.id === state.reading) : null;
    const head = el("div", { class: "ai-ask-head" },
      compact ? null : el("h2", {}, icon("sparkles"), "Ask Claude"),
      el("span", { class: "layr-spacer" }),
      old.length ? el("select", { class: "layr-select ai-ask-history", title: "Chats from before threads (read only)",
        onchange: (e) => {
          state.reading = e.target.value || null;
          redraw();
        } }, el("option", { value: "" }, reading ? "Back to Ask Claude" : "Earlier chats…"),
      old.map((c) => el("option", { value: c.id, selected: c.id === state.reading }, c.title))) : null);
    if (reading) {
      view.replaceChildren(head, oldChatView(app, reading),
        el("div", { class: "ai-ask-foot layr-muted" }, "A chat from before threads: read only."));
      return;
    }

    const target = last && !state.fresh
      ? el("div", { class: "ai-ask-target" },
        el("span", { class: "layr-muted" }, "Continues"),
        el("button", { class: "layr-button ghost small", title: "Show this thread", onclick: () => openThread(last.id) },
          icon("message-square-text"), last.title),
        el("button", { class: "layr-button ghost small", title: "The next message starts a new thread", onclick: () => {
          state.fresh = true;
          redraw();
        } }, icon("plus"), "New thread"))
      : el("div", { class: "ai-ask-target" },
        el("span", { class: "layr-muted" }, "Starts a new thread"),
        last ? el("button", { class: "layr-button ghost small", title: "Continue the last thread instead", onclick: () => {
          state.fresh = false;
          redraw();
        } }, icon("undo-2"), "Continue the last one") : null);

    const intro = el("div", { class: "ai-ask-intro" },
      el("div", { class: "ai-ask-intro-icon" }, icon("messages-square")),
      el("p", {}, "Ask anything, or ask for something to be done. A Claude thread opens beside the wiki: it knows your " +
        "wiki and can use your other plugins too."),
      compact ? null : el("div", { class: "ai-examples" }, EXAMPLES.map((x) => el("button", { class: "ai-chip", onclick: () => {
        input.value = x;
        draft = x;
        input.focus();
      } }, x))));

    const input = el("textarea", { class: "layr-textarea ai-ask-input", rows: compact ? 2 : 3,
      placeholder: "Ask Claude…", "aria-label": "Your message" });
    input.value = draft;
    input.oninput = () => (draft = input.value);
    const submit = async () => {
      const q = input.value;
      if (!q.trim() || state.busy) return;
      if (await send(app, q)) draft = "";
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
    const compose = el("form", { class: "ai-ask-compose", onsubmit: (e) => {
      e.preventDefault();
      submit();
    } }, input, el("button", { class: "layr-button primary icon", type: "submit", title: "Send (Enter)",
      disabled: state.busy ? true : null }, state.busy ? el("span", { class: "layr-spinner" }) : icon("send")));

    view.replaceChildren(head, el("div", { class: "ai-ask-thread" }, intro), target,
      state.error ? el("div", { class: "layr-error ai-ask-error" }, state.error) : null,
      compose,
      el("div", { class: "ai-ask-foot layr-muted" },
        el("div", {}, icon("shield-check"), " The thread can read, search the web and use your plugins as Settings › " +
          "Tool access allows (changes to wiki pages can be undone). It can't edit files or run programs on your PC."),
        compact ? null : el("div", {}, "Uses your Claude Code plan. Shift+Enter: new line.")));
    if (!compact && !state.busy) input.focus({ preventScroll: true });
  };
  subscribers.add(draw);
  const off = app.ai.onChange(() => draw());
  draw();
  return () => {
    subscribers.delete(draw);
    off();
  };
}

export function installAsk(app) {
  app.views?.register("ask", { title: "Ask Claude", icon: "sparkles", render: (root) => renderAsk(app, root) });
  app.sidebar?.register("right", { id: "ask", title: "Ask Claude", icon: "sparkles", order: 60,
    render: (root) => renderAsk(app, root, { compact: true }), when: () => app.ai.canThread() });
  app.commands?.register({ id: "ask", title: "Ask Claude (opens a thread beside the wiki)", icon: "sparkles",
    key: "ctrl+shift+a", run: () => app.open({ view: "ask" }), when: () => app.ai.canThread() });
}
