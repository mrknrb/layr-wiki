// The Wiki panel: read, write and link pages, on the PC and the phone. The pages are the plugin's own synced data
// (layr.db / layr.data), so the panel needs no backend: the backend (PC) only adds the AI tools and the folder copy.
// The model is shared with the backend (../shared/wiki.js); this file is the screen.
import { diffLines, diffStats, foldDiff } from "../shared/diff.js";
import { Files, MIGRATION_HINT } from "../shared/files.js";
import { escapeHtml, isImageName, renderInline, renderMarkdown } from "../shared/markdown.js";
import { asList, keyOf, propertyLink, slug, titleProblem } from "../shared/links.js";
import { splitFrontmatter } from "../shared/frontmatter.js";
import { Wiki } from "../shared/wiki.js";

await layr.ready;

const $ = (id) => document.getElementById(id);
const app = $("app");
const content = $("content");
const instance = layr.info.instance;

/** The plugin's data store in the shape the model wants; events say which tab wrote, so it can ignore its own. */
const adapter = {
  dbList: (collection, opts = {}) => layr.db.list(collection, opts),
  dbGet: (collection, id) => layr.db.get(collection, id),
  dbInsert: (collection, value) => layr.db.insert(collection, value),
  dbUpdate: (collection, id, value) => layr.db.update(collection, id, value),
  dbDelete: (collection, id) => layr.db.delete(collection, id),
  dataGet: (key) => layr.data.get(key),
  dataSet: (key, value) => layr.data.set(key, value),
  dataDelete: (key) => layr.data.delete(key),
  dataList: (opts = {}) => layr.data.list(opts),
  emit: (topic, data) => layr.events.emit(topic, { ...data, source: instance }).catch(() => {}),
};

const wiki = new Wiki(adapter, { who: "you", device: layr.info.device?.id ?? null });
const files = new Files({ session: () => layr.tools.run("supabase_session", {}, { plugin: "layr" }), adapter });

const state = {
  view: "home", // home | page | trash | missing
  pageId: null,
  missingTitle: null,
  mode: "read", // read | edit
  back: [],
  query: "",
  type: "",
  sort: "recent",
  dirty: false,
  saving: null,
  conflict: null,
};

// ---------- small helpers ----------

const notify = (text, kind = "info") => layr.ui.notify(text, kind).catch(() => {});
const fail = (error) => notify(error?.message ?? String(error), "error");

function ago(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

const whoText = (r) => (r.by === "ai" ? "AI" : r.by === "you" ? "you" : r.by?.replace(/^plugin:/, "") ?? "you");
const iconOf = (typeName) => wiki.type(typeName)?.icon ?? (typeName ? "📄" : "🗒️");
const narrow = () => window.matchMedia("(max-width: 700px)").matches;
const current = () => (state.pageId ? wiki.pages.get(state.pageId) ?? null : null);
const pageUrl = (title) => `layr://wiki/page/${encodeURIComponent(title)}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const resolveLink = (target) => {
  const page = wiki.resolve(target);
  return page ? { title: page.title, exists: true } : { title: target, exists: false };
};

// ---------- the side list ----------

function renderTypeFilter() {
  const select = $("typeFilter");
  const counts = new Map();
  for (const p of wiki.live()) if (p.type) counts.set(keyOf(p.type), (counts.get(keyOf(p.type)) ?? 0) + 1);
  const types = wiki.types().filter((t) => counts.get(keyOf(t.name)));
  for (const p of wiki.live()) {
    if (p.type && !wiki.type(p.type) && !types.some((t) => keyOf(t.name) === keyOf(p.type))) types.push({ name: p.type, icon: "📄" });
  }
  select.replaceChildren(
    el("option", { value: "" }, "All types"),
    ...types.map((t) => el("option", { value: t.name, selected: keyOf(state.type) === keyOf(t.name) },
      `${t.icon ?? ""} ${t.name} (${counts.get(keyOf(t.name)) ?? 0})`)),
  );
}

function renderList() {
  const list = $("list");
  const q = state.query.trim();
  const tag = q.startsWith("#") ? q.slice(1).split(/\s+/)[0] : null;
  const words = tag ? q.split(/\s+/).slice(1).join(" ") : q;
  let rows = wiki.search(words, { type: state.type || null, tag, limit: 100000 });
  if (!words) {
    rows.sort(state.sort === "az"
      ? (a, b) => a.page.title.localeCompare(b.page.title)
      : (a, b) => b.page.updated - a.page.updated);
  }
  const total = rows.length;
  rows = rows.slice(0, 400);
  list.replaceChildren(
    ...rows.map(({ page, snippet }) => {
      const li = el("li", { role: "option", class: page.id === state.pageId ? "active" : null, "data-id": page.id },
        el("div", { class: "row" },
          el("span", { class: "icon" }, iconOf(page.type)),
          el("span", { class: "title" }, page.title),
          page.by === "ai" && Date.now() - page.updated < 86400000 ? el("span", { class: "ai-dot", title: "Changed by AI" }, "AI") : null,
          el("span", { class: "when" }, ago(page.updated))),
        words && snippet ? el("div", { class: "snippet" }, snippet) : null);
      li.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) return openInTab(page.title);
        // On the phone a page picked in the list goes back to the list; links followed from it go back page by page.
        if (narrow()) state.back = [];
        go({ view: "page", pageId: page.id }, { push: !narrow() });
      });
      return li;
    }),
    ...(total > rows.length ? [el("li", { class: "more layr-muted" }, `${total - rows.length} more: search to narrow down`)] : []),
    ...(!total && q ? [el("li", { class: "create" , onclick: () => newPage(cleanQuery(q)) },
      el("span", { class: "icon" }, "＋"), el("span", { class: "title" }, `Create “${cleanQuery(q)}”`))] : []),
  );
  $("count").textContent = `${wiki.live().length} pages`;
  $("trashBtn").textContent = `Trash${wiki.trashed().length ? ` (${wiki.trashed().length})` : ""}`;
}

const cleanQuery = (q) => q.replace(/^#\S*\s*/, "").trim() || q.trim();

// ---------- navigation ----------

function saveState() {
  layr.panel.setState({ page: state.pageId, view: state.view, mode: state.mode }).catch(() => {});
}

/** Show something else; the current place goes on the Back stack. */
async function go(target, { push = true } = {}) {
  await flush();
  if (push && (state.view !== target.view || state.pageId !== target.pageId)) {
    state.back.push({ view: state.view, pageId: state.pageId, missingTitle: state.missingTitle });
    if (state.back.length > 50) state.back.shift();
  }
  state.view = target.view;
  state.pageId = target.pageId ?? null;
  state.missingTitle = target.missingTitle ?? null;
  state.mode = target.mode ?? "read";
  state.conflict = null;
  app.dataset.view = "page";
  render();
  if (target.heading) document.getElementById(target.heading)?.scrollIntoView({ block: "start" });
  else content.scrollTop = 0;
  saveState();
}

async function goBack() {
  if (narrow() && app.dataset.view === "page" && !state.back.length) {
    await flush();
    app.dataset.view = "list";
    return;
  }
  const prev = state.back.pop();
  if (prev) await go(prev, { push: false });
  else if (narrow()) app.dataset.view = "list";
  else await go({ view: "home" }, { push: false });
}

/** Open a page by title (or alias), or offer to create it. */
async function openTitle(title, heading = null) {
  const page = wiki.resolve(title);
  if (page) await go({ view: "page", pageId: page.id, heading });
  else await go({ view: "missing", missingTitle: title });
}

const openInTab = (title) => layr.panels.open("main", { page: title }).catch(fail);

// ---------- rendering ----------

function render() {
  renderTypeFilter();
  renderList();
  const page = current();
  const editing = state.view === "page" && state.mode === "edit" && page;
  $("editBtn").hidden = state.view !== "page" || !page;
  $("historyBtn").hidden = state.view !== "page" || !page;
  $("moreBtn").hidden = state.view !== "page" || !page;
  $("editBtn").textContent = editing ? "Done" : "Edit";
  $("editBtn").classList.toggle("primary", Boolean(editing));
  $("saveState").textContent = editing ? (state.dirty ? "Editing…" : "Saved") : "";
  const crumb = $("crumb");
  if (state.view === "page" && page) {
    crumb.textContent = `${iconOf(page.type)} ${page.title}`;
    layr.panel.setTitle(page.title).catch(() => {});
  } else {
    crumb.textContent = state.view === "trash" ? "Trash" : state.view === "missing" ? state.missingTitle : "Overview";
    layr.panel.setTitle("Wiki").catch(() => {});
  }
  renderBanner();
  if (state.view === "page" && !page) state.view = "home";
  if (state.view === "page") (editing ? renderEditor : renderPage)(page);
  else if (state.view === "trash") renderTrash();
  else if (state.view === "missing") renderMissing();
  else renderHome();
}

/** The AI changed this page lately: say so, with Undo. A conflict while editing says that instead. */
function renderBanner() {
  const banner = $("banner");
  const page = current();
  banner.replaceChildren();
  banner.hidden = true;
  if (state.view !== "page" || !page) return;
  if (state.conflict) {
    banner.hidden = false;
    banner.className = "banner warn";
    banner.append(
      el("span", {}, `This page was changed ${state.conflict} while you were editing. Your text is kept; the other ` +
        "version is in History."),
      el("button", { class: "layr-button small", onclick: () => openHistory(page) }, "History"),
      el("button", { class: "layr-button ghost small", onclick: () => ((state.conflict = null), renderBanner()) }, "OK"),
    );
    return;
  }
  const seenKey = `${page.id}@${page.updated}`;
  if (page.by === "ai" && Date.now() - page.updated < 3 * 86400000 && state.mode === "read" && !seenAi.has(seenKey)) {
    banner.hidden = false;
    banner.className = "banner ai";
    banner.append(
      el("span", {}, `Changed by AI ${ago(page.updated)}.`),
      el("button", { class: "layr-button small", onclick: () => openHistory(page) }, "See changes"),
      el("button", { class: "layr-button small", onclick: () => undoAi(page) }, "Undo"),
      el("button", { class: "layr-button ghost small", title: "Hide until the AI changes it again",
        onclick: () => (markSeen(seenKey), renderBanner()) }, "OK"),
    );
  }
}

/** AI changes the user has seen ("OK" on the banner): only this screen's memory, so the browser's storage is enough. */
const seenAi = new Set(JSON.parse(localStorage.getItem("wiki.seenAi") ?? "[]"));
function markSeen(key) {
  seenAi.add(key);
  localStorage.setItem("wiki.seenAi", JSON.stringify([...seenAi].slice(-300)));
}

async function undoAi(page) {
  try {
    await wiki.restore(page.id, null, { by: "you" });
    notify("Went back to the version before the AI's change", "success");
    render();
  } catch (error) {
    fail(error);
  }
}

/** A property value as HTML: links as links, database ids as links to the database, the rest as Markdown. */
function valueHtml(field, v) {
  const s = String(v);
  if (field?.url && !propertyLink(s)) {
    const href = field.url.replace("{}", encodeURIComponent(s));
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s)}</a>`;
  }
  if (/^https?:\/\//.test(s)) return renderInline(s);
  return renderInline(s, { resolve: resolveLink });
}

function infobox(page) {
  const type = wiki.type(page.type);
  const hidden = new Set(["type", "tags", "aliases", "cssclasses", "title"]);
  const fields = [...(type?.fields ?? [])];
  for (const key of Object.keys(page.props)) {
    if (!hidden.has(key) && !fields.some((f) => f.key === key)) fields.push({ key, label: key.replace(/_/g, " ") });
  }
  const rows = fields
    .map((f) => ({ f, values: asList(page.props[f.key]).filter((v) => v !== "") }))
    .filter((r) => r.values.length);
  if (!rows.length && !page.aliases.length) return null;
  const table = el("table", {},
    ...rows.map(({ f, values }) => el("tr", {}, el("th", {}, f.label ?? f.key),
      el("td", { html: values.map((v) => valueHtml(f, v)).join(f.kind === "list" || f.kind === "links" || values.length > 1 ? "<br>" : ", ") }))));
  return el("aside", { class: "infobox" },
    el("div", { class: "infobox-head" }, `${iconOf(page.type)} ${page.type ?? "Page"}`),
    page.aliases.length ? el("div", { class: "aliases" }, `also: ${page.aliases.join(", ")}`) : null,
    rows.length ? table : null);
}

function chips(pages, extra = null) {
  return el("div", { class: "chips" }, ...pages.map((p) => {
    const chip = el("a", { class: "chip", href: "#", "data-page": p.title }, `${iconOf(p.type)} ${p.title}`);
    return extra ? el("span", { class: "chip-wrap" }, chip, extra(p)) : chip;
  }));
}

function renderPage(page) {
  const article = el("article", { class: "page" });
  const meta = el("div", { class: "page-meta" },
    el("span", {}, `${iconOf(page.type)} ${page.type ?? "Page"}`),
    ...page.tags.map((t) => el("a", { class: "tag", href: "#", "data-tag": t }, `#${t}`)),
    el("span", { class: "layr-muted" }, `edited ${ago(page.updated)} by ${whoText(page)}`));
  article.append(el("h1", { class: "page-title" }, page.title), meta);
  const box = infobox(page);
  if (box) article.append(box);
  const body = page.body.trim();
  article.append(body
    ? el("div", { class: "md", html: renderMarkdown(page.body, { resolve: resolveLink }) })
    : el("p", { class: "layr-muted empty-page" }, "This page is empty. ",
      el("a", { href: "#", onclick: (e) => (e.preventDefault(), setMode("edit")) }, "Write something")));
  const back = wiki.backlinks(page.id);
  const unlinked = wiki.unlinkedMentions(page.id);
  const refs = el("section", { class: "refs" });
  refs.append(el("h3", {}, `Linked from (${back.length})`),
    back.length ? chips(back) : el("p", { class: "layr-muted" }, "No page links here yet."));
  if (unlinked.length) {
    refs.append(el("h3", {}, `Mentioned without a link (${unlinked.length})`),
      chips(unlinked, (p) => el("button", { class: "layr-button ghost small", title: `Turn the first mention in ${p.title} into a link`,
        onclick: () => linkMention(p, page) }, "Link it")));
  }
  article.append(refs);
  content.replaceChildren(article);
  loadImages(article);
}

/** Turn the first mention of `target`'s title (or alias) in `page` into a [[link]]. */
async function linkMention(page, target) {
  const names = [target.title, ...target.aliases].sort((a, b) => b.length - a.length);
  const { yaml } = splitFrontmatter(page.markdown);
  const offset = yaml === null ? 0 : page.markdown.indexOf(page.body);
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_\\[|])(${esc})(?![\\p{L}\\p{N}_\\]])`, "iu");
    const m = re.exec(page.body);
    if (!m) continue;
    const at = offset + m.index + m[1].length;
    const found = m[2];
    const link = found === target.title ? `[[${target.title}]]` : `[[${target.title}|${found}]]`;
    const markdown = page.markdown.slice(0, at) + link + page.markdown.slice(at + found.length);
    await wiki.save(page.id, markdown, { by: "you" }).catch(fail);
    render();
    return;
  }
  notify("Couldn't find the mention outside links and code", "error");
}

const imageUrls = new Map();

/** Fill in embedded pictures (attachments live in the user's Supabase Storage). */
function loadImages(root) {
  for (const img of root.querySelectorAll("img.att[data-file]")) {
    const name = img.dataset.file;
    const cached = imageUrls.get(keyOf(name));
    if (cached) {
      img.src = cached;
      continue;
    }
    files.download(name).then(({ record, bytes }) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: record.mime }));
      imageUrls.set(keyOf(name), url);
      img.src = url;
    }).catch((error) => {
      img.replaceWith(el("span", { class: "att-missing", title: error.message }, `🖼 ${name}: ${short(error.message)}`));
    });
  }
}

const short = (text) => (text === MIGRATION_HINT ? "attachments need the database update" : text);

async function openAttachment(name) {
  try {
    const { record, bytes } = await files.download(name);
    const url = URL.createObjectURL(new Blob([bytes], { type: record.mime }));
    const a = el("a", { href: url, download: record.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    fail(error);
  }
}

// ---------- overview, trash, a missing page ----------

function section(title, ...children) {
  return el("section", { class: "home-section" }, el("h3", {}, title), ...children);
}

function renderHome() {
  const live = wiki.live();
  const wrap = el("div", { class: "home" });
  const home = wiki.resolve("Home");
  wrap.append(el("h1", { class: "page-title" }, "Your wiki"));
  if (!live.length) {
    wrap.append(el("div", { class: "layr-empty welcome" },
      el("p", {}, "One page per thing you want to remember: a gene, a method, a paper, an experiment, an idea. Link " +
        "pages with [[double brackets]]; the AI can read and write them too."),
      el("button", { class: "layr-button primary", onclick: () => newPage("Home", "Topic") }, "Start with a Home page"),
      el("button", { class: "layr-button", onclick: () => newPage("") }, "New page")));
  }
  if (home) wrap.append(el("p", {}, el("a", { class: "chip big", href: "#", "data-page": home.title }, "🏠 Home")));
  const counts = new Map();
  for (const p of live) counts.set(p.type ?? "", (counts.get(p.type ?? "") ?? 0) + 1);
  if (live.length) {
    wrap.append(section(`${live.length} pages`, el("div", { class: "chips" },
      ...[...counts].sort((a, b) => b[1] - a[1]).map(([t, n]) => el("a", { class: "chip", href: "#",
        onclick: (e) => (e.preventDefault(), setType(t)) }, `${iconOf(t || null)} ${t || "No type"} ${n}`)))));
    wrap.append(section("Recently changed", el("ul", { class: "recent" }, ...wiki.recent(12).map((p) =>
      el("li", {}, el("a", { href: "#", "data-page": p.title }, `${iconOf(p.type)} ${p.title}`),
        el("span", { class: "layr-muted" }, ` ${ago(p.updated)} by ${whoText(p)}`))))));
  }
  const wanted = wiki.wanted();
  if (wanted.length) {
    wrap.append(section(`Wanted pages (${wanted.length})`,
      el("p", { class: "layr-muted" }, "Linked from somewhere, not written yet."),
      el("div", { class: "chips" }, ...wanted.slice(0, 30).map((w) =>
        el("a", { class: "chip missing", href: "#", "data-page": w.title, title: `Linked from ${w.from.map((p) => p.title).join(", ")}` },
          `${w.title} ×${w.from.length}`)))));
  }
  const orphans = wiki.orphans();
  if (orphans.length && live.length > 1) {
    wrap.append(section(`Not linked from anywhere (${orphans.length})`, chips(orphans.slice(0, 40))));
  }
  const dups = wiki.duplicates();
  if (dups.length) {
    wrap.append(section("Same title twice", el("p", { class: "layr-muted" },
      "Made on two devices at once? Rename or merge them: ", ...dups.map((d) => el("span", {}, `${d[0].title} (${d.length}) `)))));
  }
  const tools = section("Folder copy and import", el("p", { class: "layr-muted", id: "mirrorStatus" }, "…"));
  tools.append(el("div", { class: "row-buttons" },
    el("button", { class: "layr-button small", onclick: mirrorNow }, "Write the folder copy now"),
    el("button", { class: "layr-button small", onclick: importFolder }, "Import a folder…")));
  wrap.append(tools);
  content.replaceChildren(wrap);
  showMirrorStatus();
}

async function showMirrorStatus(status = null) {
  const node = $("mirrorStatus");
  if (!node) return;
  try {
    const s = status ?? (await layr.tools.run("mirror_status", {}));
    if (!s.enabled && s.enabled !== null) node.textContent = "Off (Settings › Wiki).";
    else if (!s.folder) node.textContent = "Starting…";
    else {
      node.textContent = `Every page is a Markdown file in ${s.folder}` +
        (s.lastRun ? ` (written ${ago(s.lastRun)})` : "") + ". Obsidian can open that folder.";
      if (s.error) node.append(el("div", { class: "layr-error" }, s.error));
      if (s.attachmentsError) node.append(el("div", { class: "layr-muted" }, `Attachments: ${short(s.attachmentsError)}`));
    }
  } catch (error) {
    node.textContent = error.code === layr.errors.NOT_AVAILABLE
      ? "Kept on your PC (it's offline now)."
      : `Not available: ${error.message}`;
  }
}

async function mirrorNow() {
  try {
    const status = await layr.tools.run("mirror_now", {});
    showMirrorStatus(status);
    notify("Folder copy written", "success");
  } catch (error) {
    fail(error);
  }
}

function importFolder() {
  modal("Import a folder", (body, close) => {
    const input = el("input", { class: "layr-input", placeholder: "C:\\Users\\you\\Documents\\My vault" });
    const overwrite = el("input", { type: "checkbox" });
    body.append(
      el("p", { class: "layr-muted" }, "Every .md file becomes a page named after the file, and the pictures they " +
        "embed become attachments. Runs on your PC."),
      el("label", { class: "layr-label" }, "Folder on your PC"), input,
      el("label", { class: "check" }, overwrite, " Replace pages that have the same title"));
    return {
      ok: "Import",
      focus: input,
      run: async () => {
        if (!input.value.trim()) throw new Error("Give the folder");
        const text = String(await layr.tools.run("import_folder", { path: input.value.trim(), overwrite: overwrite.checked }));
        await wiki.load();
        close();
        render();
        notify(text.split("\n")[0], "success");
      },
    };
  });
}

function renderTrash() {
  const pages = wiki.trashed();
  const wrap = el("div", { class: "home" }, el("h1", { class: "page-title" }, "Trash"));
  if (!pages.length) wrap.append(el("p", { class: "layr-muted" }, "Nothing in the trash."));
  wrap.append(el("ul", { class: "trash" }, ...pages.map((p) => el("li", {},
    el("span", { class: "title" }, `${iconOf(p.type)} ${p.title}`),
    el("span", { class: "layr-muted" }, ` trashed ${ago(p.trashed)}`),
    el("span", { class: "layr-spacer" }),
    el("button", { class: "layr-button small", onclick: async () => {
      const back = await wiki.untrash(p.id).catch(fail);
      if (back) go({ view: "page", pageId: back.id });
    } }, "Restore"),
    el("button", { class: "layr-button danger small", onclick: () => destroy(p) }, "Delete forever")))));
  content.replaceChildren(wrap);
}

function destroy(page) {
  modal("Delete forever?", (body, close) => {
    body.append(el("p", {}, `“${page.title}” and all its history will be gone on every device. This can't be undone.`));
    return { ok: "Delete forever", danger: true, run: async () => {
      await wiki.destroy(page.id);
      close();
      render();
    } };
  });
}

function renderMissing() {
  const title = state.missingTitle;
  const from = wiki.wanted().find((w) => keyOf(w.title) === keyOf(title))?.from ?? [];
  content.replaceChildren(el("div", { class: "home" },
    el("h1", { class: "page-title missing-title" }, title),
    el("p", {}, "There is no page with this title yet."),
    from.length ? el("div", {}, el("p", { class: "layr-muted" }, "Linked from:"), chips(from)) : null,
    el("button", { class: "layr-button primary", onclick: () => newPage(title) }, "Create it")));
}

// ---------- new pages ----------

function newPage(title = "", type = null) {
  modal("New page", (body, close) => {
    const input = el("input", { class: "layr-input", value: title, placeholder: "e.g. TP53, Western blot, Smith 2024 …" });
    const select = el("select", { class: "layr-select" },
      ...wiki.types().map((t) => el("option", { value: t.name, selected: keyOf(t.name) === keyOf(type ?? "Note") },
        `${t.icon ?? ""} ${t.name}`)));
    const problem = el("div", { class: "layr-error" });
    const check = () => {
      const t = input.value.trim();
      const clash = t && wiki.resolve(t);
      problem.textContent = t ? (titleProblem(t) ?? (clash ? `“${clash.title}” exists already` : "")) : "";
    };
    input.addEventListener("input", check);
    check();
    body.append(el("label", { class: "layr-label" }, "Title"), input, problem,
      el("label", { class: "layr-label" }, "Type"), select,
      el("p", { class: "layr-muted hint" }, "The type gives the page its info box fields and starting sections."));
    return {
      ok: "Create",
      focus: input,
      run: async () => {
        const t = input.value.trim();
        const clash = wiki.resolve(t);
        if (clash) {
          close();
          return go({ view: "page", pageId: clash.id });
        }
        const page = await wiki.create({ title: t, type: select.value === "Note" ? null : select.value });
        close();
        await go({ view: "page", pageId: page.id, mode: "edit" });
      },
    };
  });
}

// ---------- the editor ----------

let editorText = null;

function setMode(mode) {
  if (state.view !== "page") return;
  flush().then(() => {
    state.mode = mode;
    state.conflict = null;
    render();
    saveState();
  });
}

function renderEditor(page) {
  const title = el("input", { class: "title-input", value: page.title, "aria-label": "Title", spellcheck: "false" });
  const commitTitle = async () => {
    const t = title.value.trim();
    if (t === page.title) return;
    try {
      await flush();
      const { updated } = await wiki.rename(page.id, t, { by: "you" });
      notify(updated ? `Renamed; links fixed in ${updated} page(s)` : "Renamed", "success");
      render();
    } catch (error) {
      title.value = page.title;
      fail(error);
    }
  };
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editorText?.focus();
    }
  });
  title.addEventListener("change", commitTitle);

  const text = el("textarea", { class: "text", spellcheck: "true",
    placeholder: "Write in Markdown. [[ links to a page, ![[picture.png]] shows a picture, # makes a heading." });
  text.value = page.markdown;
  editorText = text;
  const preview = el("div", { class: "preview md" });
  const updatePreview = () => {
    if (!preview.isConnected || narrow()) return;
    preview.innerHTML = renderMarkdown(splitFrontmatter(text.value).body, { resolve: resolveLink });
    loadImages(preview);
  };
  let previewTimer = null;
  text.addEventListener("input", () => {
    markDirty();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 250);
    complete(text);
  });
  text.addEventListener("keydown", (e) => completeKey(e, text));
  text.addEventListener("blur", () => setTimeout(() => hideComplete(), 150));
  text.addEventListener("paste", (e) => {
    const list = [...(e.clipboardData?.files ?? [])];
    if (list.length) {
      e.preventDefault();
      uploadInto(text, list);
    }
  });
  text.addEventListener("dragover", (e) => e.preventDefault());
  text.addEventListener("drop", (e) => {
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length) {
      e.preventDefault();
      uploadInto(text, list);
    }
  });

  const tool = (label, tip, run) =>
    el("button", { class: "layr-button ghost small", title: tip, onmousedown: (e) => e.preventDefault(), onclick: run }, label);
  const bar = el("div", { class: "edit-tools" },
    tool("[[ ]]", "Link to a page", () => wrap(text, "[[", "]]", "")),
    tool("B", "Bold", () => wrap(text, "**", "**", "bold")),
    tool("I", "Italic", () => wrap(text, "*", "*", "italic")),
    tool("H", "Heading", () => linePrefix(text, "## ")),
    tool("•", "List", () => linePrefix(text, "- ")),
    tool("☐", "Checkbox", () => linePrefix(text, "- [ ] ")),
    tool("❝", "Callout", () => linePrefix(text, "> [!note] ")),
    tool("📎", "Add a picture or file", () => pickFiles(text)));

  content.replaceChildren(el("div", { class: "editor" },
    el("div", { class: "edit-head" }, title, bar),
    el("div", { class: "edit-panes" }, text, preview)));
  updatePreview();
  if (!narrow()) text.focus();
}

function markDirty() {
  state.dirty = true;
  $("saveState").textContent = "Editing…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flush(), 800);
}

/** Save the editor's text now when it changed. */
async function flush() {
  clearTimeout(state.saveTimer);
  if (state.saving) await state.saving;
  const page = current();
  if (!state.dirty || !page || !editorText) return;
  const markdown = editorText.value;
  state.dirty = false;
  state.saving = wiki.save(page.id, markdown, { by: "you" })
    .then(() => {
      if (state.mode === "edit") $("saveState").textContent = state.dirty ? "Editing…" : "Saved";
      renderList();
    })
    .catch((error) => {
      state.dirty = true;
      $("saveState").textContent = "Not saved";
      fail(error);
    })
    .finally(() => (state.saving = null));
  await state.saving;
}

function insertAt(text, before, after = "", fallback = "") {
  const { selectionStart: s, selectionEnd: e, value } = text;
  const inner = value.slice(s, e) || fallback;
  text.setRangeText(before + inner + after, s, e, "end");
  if (!value.slice(s, e) && fallback) text.setSelectionRange(s + before.length, s + before.length + inner.length);
  else if (!value.slice(s, e)) text.setSelectionRange(s + before.length, s + before.length);
  text.focus();
  text.dispatchEvent(new Event("input"));
}

const wrap = (text, before, after, fallback) => insertAt(text, before, after, fallback);

function linePrefix(text, prefix) {
  const { selectionStart: s, value } = text;
  const start = value.lastIndexOf("\n", s - 1) + 1;
  text.setRangeText(prefix, start, start, "end");
  text.focus();
  text.dispatchEvent(new Event("input"));
}

// ---------- [[ completion ----------

const completion = { items: [], index: 0, start: 0 };

/** Where the caret is on screen (a hidden copy of the textarea measures it). */
function caretPoint(text) {
  const style = getComputedStyle(text);
  const mirror = el("div");
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft",
    "paddingRight", "borderTopWidth", "borderLeftWidth", "boxSizing", "whiteSpace", "wordWrap", "tabSize"]) mirror.style[p] = style[p];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", wordWrap: "break-word",
    width: `${text.clientWidth}px`, top: "0", left: "-9999px" });
  mirror.textContent = text.value.slice(0, text.selectionStart);
  const mark = el("span", {}, "\u200b");
  mirror.append(mark);
  document.body.append(mirror);
  const r = text.getBoundingClientRect();
  const point = { x: r.left + mark.offsetLeft - text.scrollLeft, y: r.top + mark.offsetTop - text.scrollTop + parseFloat(style.lineHeight || "18") };
  mirror.remove();
  return point;
}

function complete(text) {
  const before = text.value.slice(0, text.selectionStart);
  const m = /\[\[([^\[\]\n|#]*)$/.exec(before);
  if (!m) return hideComplete();
  const q = keyOf(m[1]);
  const pages = wiki.live();
  const starts = [];
  const contains = [];
  for (const p of pages) {
    const names = [p.title, ...p.aliases].map(keyOf);
    if (names.some((n) => n.startsWith(q))) starts.push(p);
    else if (q && names.some((n) => n.includes(q))) contains.push(p);
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  completion.items = [...starts.sort(byTitle), ...contains.sort(byTitle)].slice(0, 8).map((p) => p.title);
  if (m[1].trim() && !completion.items.some((t) => keyOf(t) === q)) completion.items.push({ create: m[1].trim() });
  completion.index = 0;
  completion.start = before.length - m[1].length;
  if (!completion.items.length) return hideComplete();
  const list = $("complete");
  list.replaceChildren(...completion.items.map((item, i) => el("li", {
    class: i === completion.index ? "active" : null,
    onmousedown: (e) => {
      e.preventDefault();
      completion.index = i;
      acceptComplete(text);
    },
  }, typeof item === "string" ? `${iconOf(wiki.resolve(item)?.type)} ${item}` : `＋ New link “${item.create}”`)));
  const pt = caretPoint(text);
  list.hidden = false;
  const w = Math.min(320, window.innerWidth - 16);
  list.style.left = `${Math.max(8, Math.min(pt.x, window.innerWidth - w - 8))}px`;
  list.style.top = `${Math.min(pt.y + 4, window.innerHeight - list.offsetHeight - 8)}px`;
  list.style.width = `${w}px`;
}

function hideComplete() {
  $("complete").hidden = true;
  completion.items = [];
}

function acceptComplete(text) {
  const item = completion.items[completion.index];
  if (!item) return;
  const title = typeof item === "string" ? item : item.create;
  const end = text.selectionStart;
  const after = text.value.slice(end);
  const close = after.startsWith("]]") ? "" : "]]";
  text.setRangeText(`${title}${close}`, completion.start, end, "end");
  if (!close) text.setSelectionRange(text.selectionStart + 2, text.selectionStart + 2);
  hideComplete();
  text.dispatchEvent(new Event("input"));
}

function completeKey(e, text) {
  if ($("complete").hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = completion.items.length;
    completion.index = (completion.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    [...$("complete").children].forEach((li, i) => li.classList.toggle("active", i === completion.index));
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acceptComplete(text);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    hideComplete();
  }
}

// ---------- attachments ----------

function pickFiles(text) {
  const input = $("filePick");
  input.value = "";
  input.onchange = () => uploadInto(text, [...input.files]);
  input.click();
}

async function uploadInto(text, list) {
  for (const file of list) {
    $("saveState").textContent = `Uploading ${file.name}…`;
    try {
      const name = file.name && file.name !== "image.png" ? file.name : `Pasted ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
      const record = await files.upload(name, await file.arrayBuffer(), file.type || null);
      insertAt(text, `${isImageName(record.name) ? "!" : ""}[[${record.name}]]\n`);
    } catch (error) {
      fail(error);
    }
  }
  $("saveState").textContent = state.dirty ? "Editing…" : "Saved";
}

// ---------- history ----------

async function openHistory(page) {
  await flush();
  const revs = await wiki.revisions(page.id).catch((error) => (fail(error), []));
  modal(`History of ${page.title}`, (body, close) => {
    body.classList.add("history");
    const list = el("ul", { class: "layr-list rev-list" });
    const view = el("div", { class: "rev-view" });
    const show = (i) => {
      [...list.children].forEach((li, k) => li.classList.toggle("active", k === i));
      const rev = revs[i];
      const older = revs[i + 1];
      const ops = foldDiff(diffLines(older?.markdown ?? "", rev.markdown));
      const now = rev.markdown === page.markdown;
      view.replaceChildren(
        el("div", { class: "rev-head" },
          el("span", {}, `${new Date(rev.at).toLocaleString()} by ${whoText(rev)}${rev.note ? ` · ${rev.note}` : ""}`),
          el("span", { class: "layr-spacer" }),
          now ? el("span", { class: "layr-badge success" }, "current") : el("button", { class: "layr-button primary small",
            onclick: async () => {
              try {
                await wiki.restore(page.id, rev.key, { by: "you" });
                close();
                render();
                notify("Version restored", "success");
              } catch (error) {
                fail(error);
              }
            } }, "Restore this version")),
        el("p", { class: "layr-muted" }, older ? "Changes from the version before:" : "The first version:"),
        el("pre", { class: "diff" }, ...ops.map((o) => o.op === "skip"
          ? el("div", { class: "skip" }, `… ${o.count} unchanged lines …`)
          : el("div", { class: o.op }, `${o.op === "add" ? "+ " : o.op === "del" ? "− " : "  "}${o.text}`))));
    };
    revs.forEach((rev, i) => {
      const prev = revs[i + 1];
      const { add, del } = diffStats(diffLines(prev?.markdown ?? "", rev.markdown));
      list.append(el("li", { onclick: () => show(i) },
        el("div", { class: "rev-when" }, ago(rev.at), el("span", { class: rev.by === "ai" ? "who ai" : "who" }, whoText(rev))),
        el("div", { class: "layr-muted rev-stat" }, `+${add} −${del}${rev.note ? ` · ${rev.note}` : ""}`)));
    });
    body.append(revs.length ? el("div", { class: "rev-wrap" }, list, view) : el("p", {}, "No history yet."));
    if (revs.length) show(0);
    return { wide: true };
  });
}

// ---------- the more menu ----------

async function moreMenu(e) {
  const page = current();
  if (!page) return;
  await layr.ui.contextMenu([
    { label: "Rename", icon: "edit", run: () => {
      setMode("edit");
      setTimeout(() => document.querySelector(".title-input")?.select(), 50);
    } },
    { label: "Open in a new tab", icon: "open_in_new", run: () => openInTab(page.title) },
    { label: "Copy link", icon: "link", run: () => navigator.clipboard?.writeText(pageUrl(page.title))
      .then(() => notify("Link copied: paste it in a Claude thread or another page"), fail) },
    { label: "Copy as [[link]]", icon: "data_array", run: () => navigator.clipboard?.writeText(`[[${page.title}]]`) },
    "-",
    { label: "Move to the trash", icon: "delete", run: async () => {
      await flush();
      await wiki.trash(page.id).catch(fail);
      notify(`“${page.title}” is in the trash`);
      goBack();
    } },
  ], e).catch(() => {});
}

// ---------- the modal ----------

/** A dialog: `build(body, close)` fills it and may return `{ok, danger, run, focus, wide}`. */
function modal(title, build) {
  const back = $("modal");
  const box = el("div", { class: "modal", role: "dialog", "aria-label": title });
  const body = el("div", { class: "modal-body" });
  const close = () => {
    back.hidden = true;
    back.replaceChildren();
    document.removeEventListener("keydown", onKey, true);
  };
  const spec = build(body, close) ?? {};
  const error = el("div", { class: "layr-error" });
  const run = async () => {
    if (!spec.run) return close();
    error.textContent = "";
    try {
      await spec.run();
    } catch (err) {
      error.textContent = err?.message ?? String(err);
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && spec.run && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      run();
    }
  };
  document.addEventListener("keydown", onKey, true);
  box.classList.toggle("wide", Boolean(spec.wide));
  box.append(el("div", { class: "modal-head" }, el("span", {}, title),
    el("button", { class: "layr-button ghost icon", "aria-label": "Close", onclick: close }, "✕")), body, error);
  if (spec.run) {
    box.append(el("div", { class: "modal-foot" },
      el("button", { class: "layr-button", onclick: close }, "Cancel"),
      el("button", { class: `layr-button ${spec.danger ? "danger" : "primary"}`, onclick: run }, spec.ok ?? "OK")));
  }
  back.replaceChildren(box);
  back.hidden = false;
  back.onclick = (e) => e.target === back && close();
  setTimeout(() => spec.focus?.focus(), 0);
}

// ---------- filters ----------

function setType(t) {
  state.type = t;
  $("typeFilter").value = t;
  app.dataset.view = "list";
  renderList();
}

// ---------- events from elsewhere ----------

/** Pages changed in another tab, by the AI, or on another device. */
async function changedElsewhere(ids, how) {
  const page = current();
  const editing = state.mode === "edit" && page && ids.includes(page.id);
  const before = page?.markdown;
  await wiki.refresh(ids);
  const after = current();
  if (editing && after && after.markdown !== before) {
    if (state.dirty || editorText?.value !== after.markdown) state.conflict = how;
    if (!state.dirty && editorText) {
      const pos = editorText.selectionStart;
      editorText.value = after.markdown;
      editorText.setSelectionRange(pos, pos);
      state.conflict = null;
    }
    renderList();
    renderBanner();
    return;
  }
  if (state.mode === "edit") renderList();
  else render();
}

layr.events.on("wiki:changed", (data) => {
  if (data?.source === instance) return;
  if (data?.types) wiki.loadTypes().then(() => state.mode !== "edit" && render());
  if (data?.ids?.length) changedElsewhere(data.ids, data.origin === "backend" ? "by the AI" : "in another tab").catch(fail);
});

layr.data.onChange(({ keys = [], collections = {} }) => {
  if (keys.some((k) => k.startsWith("type/"))) wiki.loadTypes().then(() => state.mode !== "edit" && render());
  const ids = collections.pages ?? [];
  if (ids.length) changedElsewhere(ids, "on another device").catch(fail);
});

// ---------- wiring ----------

content.addEventListener("click", (e) => {
  const link = e.target.closest("a");
  if (!link || !content.contains(link)) return;
  if (link.dataset.page !== undefined) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return openInTab(link.dataset.page);
    openTitle(link.dataset.page, link.dataset.heading ?? null);
  } else if (link.dataset.tag) {
    e.preventDefault();
    $("search").value = `#${link.dataset.tag}`;
    state.query = $("search").value;
    app.dataset.view = "list";
    renderList();
  } else if (link.dataset.file) {
    e.preventDefault();
    openAttachment(link.dataset.file);
  } else if (link.getAttribute("href")?.startsWith("#") && link.getAttribute("href").length > 1) {
    e.preventDefault();
    document.getElementById(slug(link.getAttribute("href").slice(1)))?.scrollIntoView();
  }
});
content.addEventListener("auxclick", (e) => {
  const link = e.target.closest("a[data-page]");
  if (link && e.button === 1) {
    e.preventDefault();
    openInTab(link.dataset.page);
  }
});

$("search").addEventListener("input", () => {
  state.query = $("search").value;
  renderList();
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = $("list").querySelector("li[data-id]");
    if (first) go({ view: "page", pageId: first.dataset.id });
    else if (state.query.trim()) newPage(cleanQuery(state.query));
  } else if (e.key === "Escape") {
    $("search").value = "";
    state.query = "";
    renderList();
  }
});
$("typeFilter").addEventListener("change", () => setType($("typeFilter").value));
$("sort").addEventListener("change", () => {
  state.sort = $("sort").value;
  renderList();
});
$("new").addEventListener("click", () => newPage(""));
$("homeBtn").addEventListener("click", () => go({ view: "home" }));
$("trashBtn").addEventListener("click", () => go({ view: "trash" }));
$("back").addEventListener("click", goBack);
$("listBtn").addEventListener("click", () => flush().then(() => (app.dataset.view = "list")));
$("editBtn").addEventListener("click", () => setMode(state.mode === "edit" ? "read" : "edit"));
$("historyBtn").addEventListener("click", () => current() && openHistory(current()));
$("moreBtn").addEventListener("click", moreMenu);

document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "e" && state.view === "page") {
    e.preventDefault();
    setMode(state.mode === "edit" ? "read" : "edit");
  } else if ((e.ctrlKey || e.metaKey) && key === "s") {
    e.preventDefault();
    flush();
  } else if (e.key === "Escape" && state.mode === "edit" && $("modal").hidden && $("complete").hidden) {
    e.preventDefault();
    setMode("read");
  }
});
window.addEventListener("beforeunload", () => flush());
document.addEventListener("visibilitychange", () => document.hidden && flush());

/** What the panel was opened with: a page (title or id), a new page, or the search box. */
async function applyParams(params = {}) {
  if (params.page) {
    const page = wiki.find(params.page);
    if (page && !page.trashed) await go({ view: "page", pageId: page.id });
    else await go({ view: "missing", missingTitle: String(params.page) });
  }
  if (params.new) newPage(typeof params.new === "string" ? params.new : "");
  if (params.search) {
    app.dataset.view = "list";
    $("search").focus();
  }
}

layr.panel.onParams?.((params) => applyParams(params).catch(fail));

try {
  await wiki.load();
} catch (error) {
  content.replaceChildren(el("div", { class: "layr-empty" }, `Couldn't read the wiki: ${error.message}`));
  throw error;
}
const saved = layr.info.state ?? {};
if (saved.page && wiki.pages.get(saved.page)) {
  state.view = "page";
  state.pageId = saved.page;
  state.mode = saved.mode === "edit" ? "edit" : "read";
  app.dataset.view = "page";
} else if (saved.view === "trash") {
  state.view = "trash";
  app.dataset.view = "page";
}
render();
await applyParams(layr.info.params ?? {});
await layr.expect("list", "#list", { min: 1, label: "The page list" });
