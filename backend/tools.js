// The wiki's tools for AI agents and other plugins (wiki__*), over the shared Wiki model. Results are plain text an
// AI reads easily (pages as their Markdown). Who called decides who a change is recorded as: an agent's change is
// "ai" (with its thread), so the user sees it and can undo it; in review mode (setting aiReview) it waits as a
// proposal until the user accepts it. `buildTools` takes fakes in tests.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cleanFileName } from "../shared/files.js";
import { fixFolder, isInside } from "../shared/folders.js";
import { setProperties, splitFrontmatter } from "../shared/frontmatter.js";
import { cleanTitle, fileTargets, keyOf } from "../shared/links.js";
import { describeProposal } from "../shared/proposals.js";
import { formatDate } from "../shared/templates.js";
import { KINDS } from "../shared/types.js";
import { buildIoTools, IO_READS } from "./io-tools.js";
import { buildViewTools, VIEW_READS } from "./view-tools.js";

export const GUIDE = `The user's wiki (wiki__*): their personal knowledge base, kept for years, Obsidian-style. One page per
thing (a person, a project, a book, a meeting, an idea, a how-to, …), linked to each other, kept in folders.

Format of a page: Markdown. Its title is its name (not repeated inside); titles are unique across the whole wiki, so a
link is just [[Title]] wherever the page is. At the top, optional properties in YAML between --- lines (type, aliases,
tags, and the fields of its type), e.g.
---
type: Book
aliases: [Thinking Fast and Slow]
tags: [psychology]
author: "[[Daniel Kahneman]]"
year: 2011
---
Links: [[Title]], [[Title|shown text]], [[Title#Heading]]; ![[Title]] embeds a page. A link to a page that doesn't
exist yet is fine: it shows red and is listed as wanted. Pictures and files: ![[name.png]], ![[name.png|400]] (width),
![[paper.pdf]] (wiki__attach uploads one). Tags: the tags property or #tag (nested: #area/sub). Tasks: "- [ ] to do",
"- [x] done", a due date as "📅 2026-11-20" (wiki__tasks lists open ones). Callouts: "> [!note]", "> [!question] Open question", "> [!warning]". Highlight ==text==; also allowed
as HTML: <u>underline</u>, <sup>, <sub>, <mark style="background:#hex">…</mark>, <span style="color:#hex">…</span>.
Math $...$.

Folders: wiki__folders lists them; create, list and search take a folder; wiki__move moves a page (links don't
change). Types are the user's own (wiki__types: their fields and templates); a page may have a type nobody defined.
Templates: pages in the templates folder (wiki__templates); wiki__create with template starts from one ({{title}},
{{date}}, {{time}} filled in). wiki__daily_note gives the day's note (made when missing).
Saved views (tables, boards of pages by folder, type or tag, with filters): wiki__views lists them, wiki__query runs
one (or an ad-hoc source and filters) and answers with a table.

Rules for changing it (the user's source of truth; every change is recorded as yours and can be undone):
- Read before you write: wiki__search, then wiki__read. Never create a page whose title, alias or near-synonym exists
  already; add to it. Put new pages in the folder where their kind of page lives (look at wiki__folders and similar
  pages); give them the type similar pages have and fill its fields.
- Prefer small changes: wiki__edit (replace an exact piece), wiki__append (add under a heading),
  wiki__set_properties. wiki__write replaces a whole page: only for new pages or full rewrites asked for.
- Link generously: the first mention of anything that has (or deserves) a page is a [[link]]. Link properties as
  "[[Page]]".
- Say where knowledge comes from (a link, a source page, a DOI). Mark what is uncertain or your own inference with
  "> [!question]" instead of stating it as fact. Never invent references.
- Keep the user's own words; don't reword their notes unless asked. Ask the user before changing their types.
- Review mode: when the user turned it on, your changes don't apply at once: each waits as a proposal in the Wiki's
  Review page until the user accepts or rejects it (the tool's answer says so). Your later edits of the same page
  build on your pending version; wiki__proposals lists what waits.
- Give the user links to pages as layr://wiki/page/<Title> (spaces as %20): they open the page in layr.`;

/** Who a tool call is recorded as, from the hub's `_meta["layr/caller"]`. */
export function authorOf(meta) {
  const caller = meta?.["layr/caller"];
  if (caller?.kind === "agent") return { by: "ai", agent: caller.label ?? caller.plugin ?? null };
  if (caller?.kind === "backend" && caller.plugin && caller.plugin !== "wiki") {
    return { by: `plugin:${caller.plugin}`, agent: null };
  }
  return { by: "you", agent: null };
}

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown");
const who = (r) => (r.by === "ai" ? `AI${r.agent ? ` (${r.agent})` : ""}` : r.by === "you" ? "the user" : r.by);
export const pageLink = (title) => `layr://wiki/page/${encodeURIComponent(title)}`;
const list = (pages) => pages.map((p) => `[[${p.title}]]`).join(", ");
const where = (page) => (page.folder ? ` in ${page.folder}` : "");

/** Is a Wiki method's result a proposal (review mode) rather than the change itself? */
export const isProposal = (result) => result?.proposal === true;

/** A tool's answer for a change that waits for review. */
export const proposedText = (p) =>
  `Proposed: ${describeProposal(p)} — waiting for the user's review in the Wiki's Review page (proposal ${p.id}).`;

/** A page as text for an AI: what it is, where, what links to it, pending proposals, then its Markdown. */
export function pageText(wiki, page, author = null) {
  const back = wiki.backlinks(page.id);
  const missing = page.links.filter((t) => !wiki.resolve(t));
  const lines = [
    `# ${page.title}`,
    `type: ${page.type ?? "none"} · folder: ${page.folder || "(top)"} · last change ${when(page.updated)} by ` +
      `${who(page)} · ${pageLink(page.title)}`,
  ];
  if (page.aliases.length) lines.push(`aliases: ${page.aliases.join(", ")}`);
  lines.push(`linked from: ${back.length ? list(back) : "nothing yet"}`);
  if (missing.length) lines.push(`links to pages that don't exist yet: ${missing.map((t) => `[[${t}]]`).join(", ")}`);
  const pending = wiki.proposalsFor?.(page.id) ?? [];
  if (pending.length) {
    lines.push(`waiting for the user's review: ${pending.map((p) => `${describeProposal(p)} by ${who(p)} (${p.id})`)
      .join("; ")}`);
  }
  lines.push("", "----- markdown -----", page.markdown.replace(/\n+$/, ""), "----- end -----");
  const draft = author ? wiki.draft(page, author) : page.markdown;
  if (draft !== page.markdown) {
    lines.push("", "Your pending version (not applied yet; your edits build on it):", "----- proposed markdown -----",
      draft.replace(/\n+$/, ""), "----- end -----");
  }
  return lines.join("\n");
}

/** The section of `heading` in `body`: `{start, end}` line indexes (end exclusive), or null. */
function findSection(lines, heading) {
  const want = keyOf(heading.replace(/^#+\s*/, ""));
  const at = lines.findIndex((l) => {
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    return m && keyOf(m[2]) === want;
  });
  if (at < 0) return null;
  const level = /^ {0,3}(#+)/.exec(lines[at])[1].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^ {0,3}(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { start: at, end };
}

/** `markdown` with `text` added at the end of the section under `heading` (made when missing), or at the end. */
export function appendText(markdown, text, heading = null) {
  const add = String(text ?? "").replace(/^\n+|\n+$/g, "");
  if (!add) throw new Error("Nothing to add: text is empty");
  const { yaml, body } = splitFrontmatter(markdown);
  const lines = body.replace(/\n+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.pop();
  let out;
  const section = heading ? findSection(lines, heading) : null;
  if (heading && section) {
    let end = section.end;
    while (end > section.start + 1 && lines[end - 1].trim() === "") end--;
    const after = lines.slice(section.end);
    out = [...lines.slice(0, end), "", add, ...(after.length ? ["", ...after] : [])];
  } else if (heading) {
    out = [...lines, ...(lines.length ? [""] : []), `## ${heading.replace(/^#+\s*/, "")}`, "", add];
  } else {
    out = [...lines, ...(lines.length ? [""] : []), add];
  }
  const newBody = `${out.join("\n")}\n`;
  return yaml === null ? newBody : `---\n${yaml}\n---\n\n${newBody}`;
}

/**
 * What a change of `title` applies to: `{page, title, text}` (text: what the author's change builds on), or in review
 * mode the author's own pending new page `{proposal, title, text}`. Throws when there is neither.
 */
export function targetOf(wiki, title, author) {
  const page = wiki.find(title);
  if (page && !page.trashed) return { page, title: page.title, text: wiki.draft(page, author) };
  const p = wiki.reviewing(author) ? pendingCreate(wiki, title, author) : null;
  if (p) return { proposal: p, title: p.title, text: p.markdown };
  return { page: wiki.need(title), title };
}

/** The author's own new page of this title that waits for review, or null. */
function pendingCreate(wiki, title, author) {
  return wiki.proposals().find((x) => x.op === "create" && keyOf(x.title) === keyOf(title) && x.by === author.by &&
    (x.agent ?? null) === (author.agent ?? null)) ?? null;
}

/** Save `markdown` to a target of targetOf. Gives what the Wiki gave (a page or a proposal). */
export function saveTarget(wiki, target, markdown, author, note = null) {
  if (target.proposal) return wiki.reviseProposal(target.proposal.id, { markdown });
  return wiki.save(target.page.id, markdown, { ...author, ...(note ? { note } : {}) });
}

/** The answer for a change: the proposal text in review mode, else `text`. */
const done = (result, text) => (isProposal(result) ? proposedText(result) : text);

const S = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TITLE = { type: "string", description: "The page's title (any case), or one of its aliases" };
const FOLDER = { type: "string", description: 'A folder path, e.g. "Projects/Thesis" ("" or missing: the top)' };
const FIELD = {
  type: "object",
  properties: {
    key: { type: "string", description: "The property key: lowercase letters, digits, _" },
    label: { type: "string" },
    kind: { type: "string", enum: KINDS },
    options: { type: "array", items: { type: "string" }, description: "select / multiselect: the choices" },
    target: { type: "string", description: "link: suggest only pages of this type" },
    multiple: { type: "boolean", description: "link: a list of links" },
    url: { type: "string", description: "text: a link pattern with {} for the value (https://doi.org/{})" },
  },
  required: ["key"],
};

/**
 * The tools. `getWiki()` → the loaded Wiki; `files`: attachments (Files); `mirror`: the folder copy;
 * `fs`: reads files on the PC (attach, import_folder; tests replace it).
 */
export function buildTools({ getWiki, files, mirror, fs = { readdir, readFile, stat } }) {
  const tools = new Map();
  const add = (name, description, inputSchema, handler) => tools.set(name, { name, description, inputSchema, handler });

  add("guide", "How the user's wiki works and the rules for changing it. Read once before writing to the wiki.",
    S({}), async () => GUIDE);

  add("overview",
    "A summary of the wiki: how many pages of each type and in each top folder, recently changed pages, wanted pages " +
      "(links to pages that don't exist yet), pages nothing links to, duplicate titles, changes waiting for review. " +
      "A good first call.",
    S({}), async () => {
      const wiki = await getWiki();
      const live = wiki.live();
      const byType = new Map();
      for (const p of live) byType.set(p.type ?? "(none)", (byType.get(p.type ?? "(none)") ?? 0) + 1);
      const byFolder = new Map();
      for (const p of live) {
        const top = p.folder ? p.folder.split("/")[0] : "(top)";
        byFolder.set(top, (byFolder.get(top) ?? 0) + 1);
      }
      const wanted = wiki.wanted().slice(0, 20);
      const orphans = wiki.orphans();
      const dups = wiki.duplicates();
      const pending = wiki.proposals();
      const count = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ") || "none";
      return [
        `${live.length} pages (${wiki.trashed().length} in the trash), ${wiki.folders().length} folders.`,
        `By type: ${count(byType)}`,
        `By folder: ${count(byFolder)}`,
        `Review mode: ${wiki.review ? "on (your changes wait for the user's review)" : "off"}` +
          `${pending.length ? `; ${pending.length} change(s) waiting (wiki__proposals)` : ""}`,
        "",
        "Recently changed:",
        ...wiki.recent(15).map((p) =>
          `- [[${p.title}]]${p.type ? ` (${p.type})` : ""}${where(p)}, ${when(p.updated)} by ${who(p)}`),
        "",
        `Wanted pages (${wiki.wanted().length}): ${wanted.map((w) => `[[${w.title}]] ×${w.from.length}`).join(", ") || "none"}`,
        `Pages nothing links to (${orphans.length}): ${list(orphans.slice(0, 30)) || "none"}`,
        ...(dups.length ? [`Duplicate titles: ${dups.map((d) => d[0].title).join(", ")}`] : []),
      ].join("\n");
    });

  add("search",
    "Find pages by words in their title, aliases, tags and text. Returns the best matches with a snippet. Use it " +
      "before creating a page. type / tag / folder narrow it down (query may then be empty).",
    S({
      query: { type: "string", description: "Words to look for" },
      type: { type: "string", description: "Only pages of this type (e.g. Book, Person)" },
      tag: { type: "string", description: "Only pages with this tag (or a tag under it: area → area/sub)" },
      folder: { ...FOLDER, description: "Only pages in this folder and its subfolders" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 20)" },
    }), async ({ query = "", type, tag, folder, limit = 20 }) => {
      const wiki = await getWiki();
      const results = wiki.search(query, { type, tag, folder: folder ?? null, limit });
      if (!results.length) return `No pages match "${query}"${folder ? ` in ${folder}` : ""}.`;
      return (results.map(({ page, snippet }) =>
        `- [[${page.title}]]${page.type ? ` (${page.type})` : ""}${where(page)}` +
          `${page.aliases.length ? ` aka ${page.aliases.join(", ")}` : ""}${snippet ? `: ${snippet}` : ""}`).join("\n"));
    });

  add("list",
    "All page titles (A to Z) with their type, folder and tags, optionally of one folder (with its subfolders unless " +
      "subfolders is false), type or tag. For a full picture of what exists.",
    S({
      folder: FOLDER,
      subfolders: { type: "boolean", description: "With folder: include its subfolders (default true)" },
      type: { type: "string" },
      tag: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 2000, description: "Default 500" },
    }), async ({ folder, subfolders = true, type, tag, offset = 0, limit = 500 }) => {
      const wiki = await getWiki();
      const pages = wiki.list({ folder: folder ?? null, subfolders, type, tag });
      const part = pages.slice(offset, offset + limit);
      const more = pages.length > offset + limit ? `\n(${pages.length - offset - limit} more: offset ${offset + limit})` : "";
      return (`${pages.length} pages\n` + part.map((p) =>
        `- ${p.title}${p.type ? ` (${p.type})` : ""}${where(p)}${p.tags.length ? ` #${p.tags.join(" #")}` : ""}`)
        .join("\n") + more);
    });

  add("read",
    "Read pages: their Markdown (properties and text), folder, what links to them, links to pages that don't exist " +
      "yet, and changes waiting for the user's review.",
    S({
      title: TITLE,
      titles: { type: "array", items: { type: "string" }, description: "Several pages at once" },
    }), async ({ title, titles }, author) => {
      const wiki = await getWiki();
      const names = [...(title ? [title] : []), ...(titles ?? [])];
      if (!names.length) throw new Error("Give title or titles");
      return (names.map((n) => {
        try {
          const target = targetOf(wiki, n, author);
          if (target.proposal) {
            return [`# ${target.title}`,
              `Not created yet: your new page waits for the user's review (proposal ${target.proposal.id}).`,
              "----- proposed markdown -----", target.text.replace(/\n+$/, ""), "----- end -----"].join("\n");
          }
          return pageText(wiki, target.page, author);
        } catch (error) {
          return `# ${n}\n${error.message}`;
        }
      }).join("\n\n"));
    });

  add("folders", "The wiki's folders (nested paths), each with how many pages are in it and below it.", S({}),
    async () => {
      const wiki = await getWiki();
      const live = wiki.live();
      const folders = wiki.folders();
      const top = live.filter((p) => !p.folder).length;
      return [`(top) ${top} page(s)`, ...folders.map((f) => {
        const here = live.filter((p) => keyOf(p.folder) === keyOf(f)).length;
        const below = live.filter((p) => p.folder && isInside(p.folder, f)).length;
        const indent = "  ".repeat(f.split("/").length - 1);
        return `${indent}- ${f}: ${here} page(s)${below > here ? `, ${below} with subfolders` : ""}`;
      })].join("\n");
    });

  add("create",
    "Create a new page, in a folder. With template (a template page, see wiki__templates) or a type with a template " +
      "and no body, it starts from that. Fails when the title (or an alias) exists anywhere: then edit that page.",
    S({
      title: { type: "string", description: "The new page's title: no [ ] # ^ | \\ / : * ? \" < >" },
      folder: FOLDER,
      type: { type: "string", description: "Its type (see wiki__types), e.g. Book, Person, Meeting" },
      template: { type: "string", description: "The title of a template page to start from" },
      body: { type: "string", description: "Its Markdown text without the properties block (optional)" },
      markdown: { type: "string", description: "Or the whole page, properties block included (instead of body)" },
      properties: { type: "object", description: "Properties to set, e.g. {\"aliases\": [\"TFS\"], \"year\": 2011}" },
    }, ["title"]), async ({ title, folder = "", type, template, body, markdown, properties }, author) => {
      const wiki = await getWiki();
      const clash = wiki.resolve(title);
      if (clash) throw new Error(`"${title}" exists already as [[${clash.title}]]${where(clash)}: edit it instead`);
      const page = await wiki.create({ title, folder, type: type ?? null, template: template ?? null, body, properties,
        markdown: markdown ?? null }, author);
      return done(page, `Created [[${page.title}]]${where(page)} (${pageLink(page.title)}).`);
    });

  add("write",
    "Replace a page's whole Markdown (properties block included), or create the page when it doesn't exist (in " +
      "folder). Prefer wiki__edit / wiki__append for changes to existing pages.",
    S({ title: { type: "string" }, markdown: { type: "string", description: "The whole page" }, folder: FOLDER },
      ["title", "markdown"]),
    async ({ title, markdown, folder = "" }, author) => {
      const wiki = await getWiki();
      const page = wiki.find(title);
      if (!page || page.trashed) {
        const pending = wiki.reviewing(author) ? pendingCreate(wiki, title, author) : null;
        if (pending) return proposedText(await wiki.reviseProposal(pending.id, { markdown: String(markdown) }));
        const created = await wiki.create({ title, folder, markdown: String(markdown) }, author);
        return done(created, `Created [[${created.title}]]${where(created)} (${pageLink(created.title)}).`);
      }
      return done(await wiki.save(page.id, String(markdown), author), `Saved [[${page.title}]].`);
    });

  add("edit",
    "Change part of a page: replaces old_text (exactly as it is in the page's Markdown, properties included) with " +
      "new_text. old_text must be found once, unless replace_all.",
    S({
      title: TITLE,
      old_text: { type: "string" },
      new_text: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["title", "old_text", "new_text"]), async ({ title, old_text, new_text, replace_all = false }, author) => {
      const wiki = await getWiki();
      const target = targetOf(wiki, title, author);
      if (!old_text) throw new Error("old_text is empty");
      const count = target.text.split(old_text).length - 1;
      if (!count) throw new Error(`old_text is not in [[${target.title}]]; read the page again (wiki__read)`);
      if (count > 1 && !replace_all) {
        throw new Error(`old_text is in [[${target.title}]] ${count} times: give more context or replace_all`);
      }
      const markdown = replace_all
        ? target.text.split(old_text).join(new_text)
        : target.text.replace(old_text, () => new_text);
      const result = await saveTarget(wiki, target, markdown, author);
      return done(result, `Changed [[${target.title}]] (${count > 1 ? `${count} places` : "1 place"}).`);
    });

  add("append",
    "Add text to a page: at the end of the section under heading (the heading is made when missing), or at the end " +
      "of the page.",
    S({ title: TITLE, text: { type: "string" }, heading: { type: "string", description: "e.g. Notes" } },
      ["title", "text"]), async ({ title, text, heading }, author) => {
      const wiki = await getWiki();
      const target = targetOf(wiki, title, author);
      const result = await saveTarget(wiki, target, appendText(target.text, text, heading ?? null), author);
      return done(result, `Added to [[${target.title}]]${heading ? ` under "${heading}"` : ""}.`);
    });

  add("set_properties",
    "Set properties of a page (the YAML block at its top) without touching anything else. null removes one. Link " +
      "values as \"[[Page]]\"; lists as arrays; dates as YYYY-MM-DD; checkboxes true/false.",
    S({ title: TITLE, properties: { type: "object" } }, ["title", "properties"]), async ({ title, properties }, author) => {
      const wiki = await getWiki();
      const target = targetOf(wiki, title, author);
      const result = await saveTarget(wiki, target, setProperties(target.text, properties ?? {}), author);
      return done(result, `Set ${Object.keys(properties ?? {}).join(", ")} on [[${target.title}]].`);
    });

  add("rename", "Rename a page; every link to it in other pages is changed too.",
    S({ title: TITLE, new_title: { type: "string" } }, ["title", "new_title"]), async ({ title, new_title }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      const old = page.title;
      const result = await wiki.rename(page.id, new_title, author);
      if (isProposal(result)) return proposedText(result);
      return `Renamed [[${old}]] to [[${result.page.title}]]; links fixed in ${result.updated} other page(s).`;
    });

  add("move", "Move a page to another folder (made when missing; \"\" the top). Links to it don't change.",
    S({ title: TITLE, folder: FOLDER }, ["title", "folder"]), async ({ title, folder }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      const result = await wiki.move(page.id, folder ?? "", author);
      return done(result, `Moved [[${page.title}]] to ${result.folder ? result.folder : "the top folder"}.`);
    });

  add("trash", "Move a page to the trash. It keeps its history and wiki__restore brings it back.",
    S({ title: TITLE }, ["title"]), async ({ title }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      return done(await wiki.trash(page.id, author), `[[${page.title}]] is in the trash.`);
    });

  add("history",
    "A page's earlier versions, newest first: when, by whom, and the revision id to give wiki__restore.",
    S({ title: TITLE, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["title"]), async ({ title, limit = 20 }) => {
      const wiki = await getWiki();
      const page = wiki.find(title) ?? wiki.trashed().find((p) => keyOf(p.title) === keyOf(title));
      if (!page) wiki.need(title);
      const revs = (await wiki.revisions(page.id)).slice(0, limit);
      return (`[[${page.title}]]${page.trashed ? " (in the trash)" : ""}: ${revs.length} version(s)\n` +
        revs.map((r) => `- ${r.key.split("/").pop()}: ${when(r.at)} by ${who(r)}, ${r.markdown.length} characters` +
          `${r.note ? ` (${r.note})` : ""}`).join("\n"));
    });

  add("restore",
    "Put back an earlier version of a page (revision from wiki__history), or without revision undo its newest " +
      "change. Also brings a page back from the trash.",
    S({ title: TITLE, revision: { type: "string" } }, ["title"]), async ({ title, revision }, author) => {
      const wiki = await getWiki();
      const page = wiki.find(title) ?? wiki.trashed().find((p) => keyOf(p.title) === keyOf(title));
      if (!page) wiki.need(title);
      const key = revision ? (revision.startsWith("rev/") ? revision : `rev/${page.id}/${revision}`) : null;
      const restored = await wiki.restore(page.id, key, author);
      return done(restored, `Restored [[${restored.title}]].`);
    });

  add("types",
    "The user's page types with their fields (property keys and kinds) and templates, how many pages each has, and " +
      "type names pages use that nobody defined.",
    S({}), async () => {
      const wiki = await getWiki();
      const used = wiki.typesInUse();
      const count = (name) => used.find((t) => keyOf(t.name) === keyOf(name))?.count ?? 0;
      const defined = wiki.types().map((t) => {
        const fields = t.fields.map((f) => `${f.key}:${f.kind}${f.multiple ? "[]" : ""}` +
          `${f.options?.length ? `(${f.options.join("|")})` : ""}${f.target ? `→${f.target}` : ""}`).join(", ");
        return `- ${t.icon} ${t.name} (${count(t.name)} pages): ${fields || "no fields"}` +
          `${t.template ? `; template: ${JSON.stringify(t.template.slice(0, 120))}` : ""}` +
          `${t.description ? ` — ${t.description}` : ""}`;
      });
      const undefinedTypes = used.filter((t) => !t.defined);
      return [
        defined.length ? defined.join("\n") : "The user has no page types yet.",
        ...(undefinedTypes.length
          ? [`Used by pages but not defined: ${undefinedTypes.map((t) => `${t.name} (${t.count})`).join(", ")}`]
          : []),
      ].join("\n");
    });

  add("define_type",
    "Add a page type or change one (by name; what you give replaces what it had, the rest stays): its icon (an " +
      `emoji or a Lucide icon name), colour, description, fields (kind: ${KINDS.join(", ")}) and template (the ` +
      "Markdown new pages of it start with; {{title}}, {{date}} are filled in). Ask the user before changing their " +
      "types.",
    S({
      name: { type: "string" },
      icon: { type: "string" },
      color: { type: "string", description: "#hex or a colour word" },
      description: { type: "string" },
      fields: { type: "array", items: FIELD },
      template: { type: "string", description: "e.g. \"## Summary\\n\\n## Notes\\n\"" },
      sections: { type: "array", items: { type: "string" }, description: "Old: headings to start with (use template)" },
    }, ["name"]), async (args) => {
      const wiki = await getWiki();
      const type = await wiki.defineType(args);
      return `Type ${type.name} saved (${type.fields.length} field(s)).`;
    });

  add("delete_type",
    "Delete a page type's definition. Its pages keep their type: line (shown with a default icon). Ask the user first.",
    S({ name: { type: "string" } }, ["name"]), async ({ name }) => {
      const wiki = await getWiki();
      const { name: gone, pages } = await wiki.deleteType(name);
      return `Type ${gone} deleted; ${pages} page(s) still say type: ${gone}.`;
    });

  add("create_folder", "Make a folder (and its parents). It stays when empty.",
    S({ path: FOLDER }, ["path"]), async ({ path: folder }) => {
      const wiki = await getWiki();
      return `Folder ${await wiki.createFolder(folder)} is there.`;
    });

  add("rename_folder",
    "Rename or move a folder with its pages and subfolders (\"Work\" → \"Archive/Work\"). Links don't change.",
    S({ from: FOLDER, to: FOLDER }, ["from", "to"]), async ({ from, to }) => {
      const wiki = await getWiki();
      const { path: moved, moved: n } = await wiki.renameFolder(from, to);
      return `Folder ${from} is now ${moved}; ${n} page(s) moved with it.`;
    });

  add("templates",
    "The template pages (in the templates folder of the wiki's settings) with their first lines. wiki__create " +
      "with template starts a page from one.",
    S({}), async () => {
      const wiki = await getWiki();
      const folder = wiki.settings.templatesFolder;
      const pages = wiki.templates();
      if (!pages.length) return `No templates yet (pages in the folder "${folder}" are templates).`;
      return `Templates (folder "${folder}"):\n` + pages.map((p) => {
        const first = p.body.split("\n").find((l) => l.trim()) ?? "";
        return `- [[${p.title}]]${p.type ? ` (${p.type})` : ""}${first ? `: ${first.slice(0, 100)}` : ""}`;
      }).join("\n");
    });

  add("daily_note",
    "The daily note of a day (default today): made from the daily template in the daily notes folder when missing " +
      "(unless create is false). Gives the page like wiki__read.",
    S({
      date: { type: "string", description: "YYYY-MM-DD (default: today)" },
      create: { type: "boolean", description: "Make it when missing (default true)" },
    }), async ({ date, create = true }, author) => {
      const wiki = await getWiki();
      const day = date ?? formatDate(new Date(), "YYYY-MM-DD");
      const page = await wiki.dailyNote(day, wiki.settings, { ...author, create });
      if (!page) return `There is no daily note for ${day}.`;
      if (isProposal(page)) return proposedText(page);
      return pageText(wiki, page, author);
    });

  add("proposals",
    "Changes waiting for the user's review (review mode): what each would do, by whom, when. Only the user accepts " +
      "or rejects them, in the Wiki's Review page.",
    S({ title: { type: "string", description: "Only the ones about this page" } }), async ({ title }) => {
      const wiki = await getWiki();
      const all = wiki.proposals().filter((p) => !title || keyOf(p.title) === keyOf(title) ||
        (wiki.find(title) && p.pageId === wiki.find(title).id));
      const head = `Review mode is ${wiki.review ? "on" : "off"}.`;
      if (!all.length) return `${head} Nothing is waiting for review${title ? ` about [[${title}]]` : ""}.`;
      return `${head} ${all.length} change(s) waiting:\n` +
        all.map((p) => `- ${p.id}: ${describeProposal(p)} by ${who(p)}, ${when(p.at)}${p.note ? ` (${p.note})` : ""}`)
          .join("\n");
    });

  add("attach",
    "Upload a file from this PC (a picture, PDF, data file) as an attachment, and optionally embed it at the end " +
      "of a page (or under heading). Pages show it with ![[name]].",
    S({
      path: { type: "string", description: "The file's absolute path on this PC" },
      name: { type: "string", description: "The attachment's name (default: the file's name)" },
      title: { type: "string", description: "A page to embed it in" },
      heading: { type: "string" },
    }, ["path"]), async ({ path: file, name, title, heading }, author) => {
      const bytes = await fs.readFile(file);
      const record = await files.upload(name ?? path.basename(file), bytes);
      if (title) {
        const wiki = await getWiki();
        const target = targetOf(wiki, title, author);
        const result = await saveTarget(wiki, target, appendText(target.text, `![[${record.name}]]`, heading ?? null),
          author);
        return done(result, `Uploaded ${record.name} and embedded it in [[${target.title}]].`)
          .replace(/^Proposed/, `Uploaded ${record.name}. Proposed`);
      }
      return `Uploaded ${record.name}: embed it with ![[${record.name}]].`;
    });

  add("attachments", "The attachments (files pages can embed), newest first.", S({}), async () => {
    const all = (await files.list()).sort((a, b) => b.at - a.at);
    return (all.length ? all.map((f) => `- ${f.name} (${f.mime}, ${Math.ceil(f.size / 1024)} KB, ${when(f.at)})`).join("\n")
      : "No attachments yet.");
  });

  add("import_folder",
    "Import a folder of Markdown files (an Obsidian vault) from this PC: each .md file becomes a page titled by its " +
      "file name, in the same folder as in the vault (under into, when given), and the pictures and files its pages " +
      "embed become attachments. Pages whose title exists are left alone unless overwrite. Folders starting with a " +
      "dot (.obsidian) are skipped.",
    S({ path: { type: "string" }, overwrite: { type: "boolean" }, into: FOLDER }, ["path"]),
    async ({ path: root, overwrite = false, into = "" }, author) => {
      const wiki = await getWiki();
      const mdFiles = [];
      const others = new Map();
      const walk = async (dir, rel) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, rel ? `${rel}/${entry.name}` : entry.name);
          else if (/\.md$/i.test(entry.name)) mdFiles.push({ full, rel });
          else others.set(entry.name.toLowerCase(), full);
        }
      };
      await walk(root, "");
      let created = 0;
      let replaced = 0;
      let skipped = 0;
      let proposed = 0;
      const problems = [];
      const wantedFiles = new Set();
      for (const { full: file, rel } of mdFiles) {
        const title = cleanTitle(path.basename(file).replace(/\.md$/i, ""));
        const markdown = (await fs.readFile(file, "utf8")).replace(/\r\n?/g, "\n");
        try {
          const folder = fixFolder(`${into}/${rel}`);
          const existing = wiki.resolve(title);
          let result;
          if (existing && keyOf(existing.title) === keyOf(title)) {
            if (!overwrite) {
              skipped++;
              continue;
            }
            result = await wiki.save(existing.id, markdown, { ...author, note: "imported" });
            if (!isProposal(result)) replaced++;
          } else {
            result = await wiki.create({ title, folder, markdown }, author);
            if (!isProposal(result)) created++;
          }
          if (isProposal(result)) proposed++;
          for (const f of wiki.find(title)?.files ?? []) wantedFiles.add(f);
          // A page waiting for review embeds its files too: they are uploaded now, so accepting it shows them.
          if (isProposal(result)) for (const f of fileTargets(result.markdown)) wantedFiles.add(f);
        } catch (error) {
          problems.push(`${rel ? `${rel}/` : ""}${path.basename(file)}: ${error.message}`);
        }
      }
      let uploaded = 0;
      for (const name of wantedFiles) {
        const full = others.get(path.basename(name).toLowerCase());
        if (!full) continue;
        try {
          const record = await files.upload(cleanFileName(path.basename(name)), await fs.readFile(full));
          if (record) uploaded++;
        } catch (error) {
          problems.push(`${path.basename(name)}: ${error.message}`);
          if (/database update|Sign in/.test(error.message)) break;
        }
      }
      return (`Imported ${mdFiles.length} Markdown file(s): ${created} new, ${replaced} replaced, ${skipped} left ` +
        `alone (title exists)${proposed ? `, ${proposed} waiting for the user's review` : ""}. ${uploaded} ` +
        "attachment(s) uploaded." +
        (problems.length ? `\nProblems:\n${problems.slice(0, 30).map((p) => `- ${p}`).join("\n")}` : ""));
    });

  add("mirror_status", "The folder copy of the wiki on this PC: where it is, when it was last written, problems.",
    S({}), async () => JSON.stringify(mirror.status(), null, 2));

  add("mirror_now", "Write the folder copy of the wiki now (it is kept up to date by itself).", S({}), async () => {
    await mirror.run({ reload: true });
    return JSON.stringify(mirror.status(), null, 2);
  });

  // More tools, each module with its own part: views (tasks, saved views) and import/export/sharing. Besides the
  // basics they get the helpers for review mode (a change may come back as a proposal).
  const ctx = { add, S, getWiki, files, mirror, fs, pageText, pageLink, isProposal, proposedText, targetOf,
    saveTarget };
  buildViewTools(ctx);
  buildIoTools(ctx);
  return tools;
}

/** Tools that only read (the others may change pages, so the panels hear wiki:changed from the model). */
export const READS = new Set(["guide", "overview", "search", "list", "read", "history", "types", "attachments",
  "mirror_status", "folders", "templates", "proposals", ...VIEW_READS, ...IO_READS]);
