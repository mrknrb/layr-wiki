// Ask your wiki: a chat that answers from the user's pages. For each question it picks the relevant pages (search
// over the question's words, pages the question names, the open page and its links), sends them to Claude with a
// prompt that asks for [[Title]] citations, and shows the answer rendered, so the citations open their pages.
// Conversations are kept in the plugin's data (`ask/<id>`, synced), the newest 50.
import { el, icon } from "../app/dom.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { ASK_SYSTEM, answerPage, askPrompt, chatTitle, citedPages, pickPages } from "./prompts.js";

const KEEP = 50;
const chats = { list: null, current: null, busy: null };
const subscribers = new Set();
const redraw = () => subscribers.forEach((fn) => fn());

const newChat = () => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: "New chat",
  at: Date.now(), updated: Date.now(), messages: [] });

async function loadChats() {
  if (chats.list) return chats.list;
  try {
    const rows = await layr.data.list({ prefix: "ask/", limit: 500 });
    chats.list = rows.map((r) => r.value).filter((c) => c?.id).sort((a, b) => b.updated - a.updated);
  } catch {
    chats.list = [];
  }
  return chats.list;
}

async function saveChat(chat) {
  chat.updated = Date.now();
  chats.list = [chat, ...(chats.list ?? []).filter((c) => c.id !== chat.id)];
  await layr.data.set(`ask/${chat.id}`, chat).catch(() => {});
  for (const old of chats.list.slice(KEEP)) layr.data.delete(`ask/${old.id}`).catch(() => {});
  chats.list = chats.list.slice(0, KEEP);
}

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
export function unavailableCard(app, what = "Ask your wiki") {
  return el("div", { class: "ai-unavailable layr-card" },
    el("div", { class: "ai-unavailable-icon" }, icon("sparkles")),
    el("h3", {}, `${what} needs Claude Code`),
    el("p", { class: "layr-muted" },
      "Install the Claude Code plugin from layr's store and sign in to Claude Code on your PC. The first time, layr asks " +
        "whether the wiki may use “Ask Claude one-off questions”; if you said no, allow it in Settings › Tool access."),
    el("button", { class: "layr-button", onclick: () => app.ai.check() }, icon("refresh-cw"), "Check again"));
}

function messageView(app, chat, m, i) {
  if (m.role === "user") return el("div", { class: "ai-msg user" }, el("div", { class: "ai-bubble" }, m.text));
  const body = el("div", { class: "ai-answer wiki-content" });
  renderInto(app, body, m.text);
  const question = chat.messages[i - 1]?.text ?? chat.title;
  const cited = new Set(citedPages(app.wiki, m.text).map((p) => p.id));
  const sources = (m.sources ?? []).map((t) => app.wiki.resolve(t)).filter(Boolean);
  return el("div", { class: `ai-msg ai${m.error ? " error" : ""}` },
    m.error ? el("div", { class: "layr-error" }, m.text) : body,
    sources.length
      ? el("div", { class: "ai-sources" }, el("span", { class: "layr-muted" }, "Read:"),
        sources.map((p) => el("button", {
          class: `ai-chip${cited.has(p.id) ? " cited" : ""}`, title: cited.has(p.id) ? "Cited in the answer" : "Read, not cited",
          onclick: (e) => app.openPage(p.id, { newTab: e.ctrlKey || e.metaKey }),
        }, p.title)))
      : null,
    m.error ? null : el("div", { class: "ai-msg-actions" },
      el("button", { class: "layr-button ghost small", title: "Copy the answer", onclick: async () => {
        await navigator.clipboard.writeText(m.text).then(() => app.ui.notify("Copied", "success"), () => app.ui.notify("Couldn't copy", "error"));
      } }, icon("copy"), "Copy"),
      el("button", { class: "layr-button ghost small", title: "Save this answer as a new page", onclick: () =>
        saveAnswer(app, question, m.text) }, icon("file-plus"), "Save as page")));
}

async function saveAnswer(app, question, answer) {
  const title = await app.ui.prompt("Save the answer as a page", { value: chatTitle(question).replace(/[?…]+$/, "")
    .replace(/[[\]#^|\\/:*?"<>]+/g, "-").trim(), label: "Title of the new page" });
  if (!title) return;
  try {
    const folder = app.page?.()?.folder ?? "";
    const page = await app.wiki.create({ title, folder: app.settings?.get?.("newPageFolder") === "root" ? "" : folder,
      markdown: answerPage(question, answer) });
    app.openPage(page.id);
  } catch (error) {
    app.ui.fail(error);
  }
}

async function send(app, question) {
  const q = question.trim();
  if (!q || chats.busy) return;
  const chat = chats.current ?? (chats.current = newChat());
  if (!chat.messages.length) chat.title = chatTitle(q);
  const history = chat.messages.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
  chat.messages.push({ role: "user", text: q, at: Date.now() });
  const route = app.route?.();
  const open = route?.view === "page" ? app.page?.() : null;
  const max = Number(app.settings?.get?.("askPages") ?? 8);
  const pages = pickPages(app.wiki, q, { open, max });
  chats.busy = { chat: chat.id, pages: pages.length };
  redraw();
  try {
    const text = await app.ai.ask(askPrompt({ question: q, pages, history }), { system: ASK_SYSTEM });
    chat.messages.push({ role: "ai", text, sources: pages.map((p) => p.page.title), at: Date.now() });
  } catch (error) {
    chat.messages.push({ role: "ai", text: error.message, error: true, at: Date.now() });
  } finally {
    chats.busy = null;
  }
  await saveChat(chat);
  redraw();
}

const EXAMPLES = ["What do my notes say about …?", "Summarize what I know about the open page",
  "Which pages mention …, and how do they relate?"];

/** The chat, full size (route `ask`) or in the right sidebar (`compact`). */
export function renderAsk(app, root, { compact = false } = {}) {
  root.classList.add("ai-ask-host");
  const view = el("div", { class: `ai-ask${compact ? " compact" : ""}` });
  root.replaceChildren(view);
  let draft = "";
  const draw = async () => {
    if (!app.ai.available()) {
      view.replaceChildren(unavailableCard(app));
      return;
    }
    const list = await loadChats();
    const chat = chats.current;
    const select = el("select", { class: "layr-select ai-ask-history", title: "Earlier conversations", onchange: (e) => {
      chats.current = list.find((c) => c.id === e.target.value) ?? null;
      redraw();
    } }, el("option", { value: "" }, chat ? "Earlier chats…" : "New chat"),
    list.map((c) => el("option", { value: c.id, selected: c.id === chat?.id }, c.title)));
    const head = el("div", { class: "ai-ask-head" },
      compact ? null : el("h2", {}, icon("sparkles"), "Ask your wiki"),
      list.length ? select : el("span", { class: "layr-spacer" }),
      el("button", { class: "layr-button ghost icon", title: "New chat", onclick: () => {
        chats.current = null;
        redraw();
      } }, icon("plus")),
      chat ? el("button", { class: "layr-button ghost icon", title: "Delete this chat", onclick: async () => {
        if (!(await app.ui.confirm("Delete this chat?", { danger: true }))) return;
        await layr.data.delete(`ask/${chat.id}`).catch(() => {});
        chats.list = list.filter((c) => c.id !== chat.id);
        chats.current = null;
        redraw();
      } }, icon("trash-2")) : null);
    const thread = el("div", { class: "ai-ask-thread" });
    if (!chat?.messages.length) {
      thread.append(el("div", { class: "ai-ask-intro" },
        el("div", { class: "ai-ask-intro-icon" }, icon("messages-square")),
        el("p", {}, "Ask anything about your notes. The answer comes from your pages and links them as sources."),
        compact ? null : el("div", { class: "ai-examples" }, EXAMPLES.map((x) => el("button", { class: "ai-chip", onclick: () => {
          input.value = x;
          draft = x;
          input.focus();
        } }, x)))));
    } else {
      chat.messages.forEach((m, i) => thread.append(messageView(app, chat, m, i)));
    }
    if (chats.busy && (!chat || chats.busy.chat === chat.id)) {
      thread.append(el("div", { class: "ai-msg ai pending" }, el("span", { class: "layr-spinner" }),
        `Reading ${chats.busy.pages} page${chats.busy.pages === 1 ? "" : "s"} and thinking…`));
    }
    const input = el("textarea", { class: "layr-textarea ai-ask-input", rows: compact ? 2 : 3,
      placeholder: "Ask your wiki…", "aria-label": "Your question" });
    input.value = draft;
    input.oninput = () => (draft = input.value);
    const submit = () => {
      const q = input.value;
      if (!q.trim() || chats.busy) return;
      draft = "";
      send(app, q);
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
    } }, input, el("button", { class: "layr-button primary icon", type: "submit", title: "Ask (Enter)",
      disabled: chats.busy ? true : null }, icon("send")));
    view.replaceChildren(head, thread, compose,
      compact ? null : el("div", { class: "ai-ask-foot layr-muted" },
        "Sends the matching pages' text to Claude (your Claude Code plan). Shift+Enter: new line."));
    thread.scrollTop = thread.scrollHeight;
    if (!compact && !chats.busy) input.focus({ preventScroll: true });
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
  app.views?.register("ask", { title: "Ask your wiki", icon: "sparkles", render: (root) => renderAsk(app, root) });
  app.sidebar?.register("right", { id: "ask", title: "Ask your wiki", icon: "sparkles", order: 60,
    render: (root) => renderAsk(app, root, { compact: true }), when: () => app.ai.available() });
  app.commands?.register({ id: "ask", title: "Ask your wiki", icon: "sparkles", key: "ctrl+shift+a",
    run: () => app.open({ view: "ask" }), when: () => app.ai.available() });
}
