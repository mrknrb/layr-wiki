// The wiki's tools for AI agents and other plugins (wiki__*), over the shared Wiki model. Results are plain text an
// AI reads easily (pages as their Markdown). Who called decides who a change is recorded as: an agent's change is
// "ai" (with its thread), so the user sees it and can undo it. `buildTools` takes fakes in tests.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { cleanFileName } from "../shared/files.js";
import { setProperties, splitFrontmatter } from "../shared/frontmatter.js";
import { cleanTitle, keyOf } from "../shared/links.js";

export const GUIDE = `The user's personal wiki (wiki__*): their long-term knowledge base, kept for years, Obsidian-style. One page per
thing (a gene, a protein, a method, a paper, an experiment, a person, an idea), linked to each other.

Format of a page: Markdown. Its title is its name (not repeated inside). At the top, optional properties in YAML
between --- lines (type, aliases, tags, and the fields of its type), e.g.
---
type: Gene
aliases: [p53, TP53 protein]
tags: [tumor-suppressor]
organism: "[[Homo sapiens]]"
ncbi_gene: 7157
---
Links: [[Title]], [[Title|shown text]], [[Title#Heading]]. A link to a page that doesn't exist yet is fine: it shows
red and is listed as wanted. Pictures and files: ![[name.png]] (wiki__attach uploads one). Tags: tags property or
#tag. Callouts: "> [!note]", "> [!question] Open question", "> [!warning]". Highlights ==text==. Math $...$.

Rules for changing it (the user's source of truth; every change is recorded as yours and can be undone):
- Read before you write: wiki__search, then wiki__read. Never create a page whose title, alias or near-synonym exists
  already; add to it. Titles: the common name (gene symbol for genes, "Author Year Short title" for papers).
- Prefer small changes: wiki__edit (replace an exact piece), wiki__append (add under a heading),
  wiki__set_properties. wiki__write replaces a whole page: only for new pages or full rewrites asked for.
- Give pages a type (wiki__types lists them, with their fields) and fill the fields you know; link properties as
  "[[Page]]". Put stable ids (UniProt, NCBI Gene, DOI, PMID) in their fields.
- Link generously: the first mention of anything that has (or deserves) a page is a [[link]].
- Say where knowledge comes from: link the Paper page, or give the DOI/PMID. Mark what is uncertain or your own
  inference with "> [!question]" instead of stating it as fact. Never invent references.
- Keep the user's own words; don't reword their notes unless asked.
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

/** A page as text for an AI: what it is, what links to it, then its Markdown. */
export function pageText(wiki, page) {
  const back = wiki.backlinks(page.id);
  const missing = page.links.filter((t) => !wiki.resolve(t));
  const lines = [
    `# ${page.title}`,
    `type: ${page.type ?? "none"} · last change ${when(page.updated)} by ${who(page)} · ${pageLink(page.title)}`,
  ];
  if (page.aliases.length) lines.push(`aliases: ${page.aliases.join(", ")}`);
  lines.push(`linked from: ${back.length ? list(back) : "nothing yet"}`);
  if (missing.length) lines.push(`links to pages that don't exist yet: ${missing.map((t) => `[[${t}]]`).join(", ")}`);
  lines.push("", "----- markdown -----", page.markdown.replace(/\n+$/, ""), "----- end -----");
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

const S = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const TITLE = { type: "string", description: "The page's title (any case), or one of its aliases" };

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
    "A summary of the wiki: how many pages of each type, recently changed pages, wanted pages (links to pages that " +
      "don't exist yet), pages nothing links to, duplicate titles. A good first call.",
    S({}), async () => {
      const wiki = await getWiki();
      const live = wiki.live();
      const byType = new Map();
      for (const p of live) byType.set(p.type ?? "(none)", (byType.get(p.type ?? "(none)") ?? 0) + 1);
      const wanted = wiki.wanted().slice(0, 20);
      const orphans = wiki.orphans();
      const dups = wiki.duplicates();
      return [
        `${live.length} pages (${wiki.trashed().length} in the trash).`,
        `By type: ${[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`,
        "",
        "Recently changed:",
        ...wiki.recent(15).map((p) => `- [[${p.title}]]${p.type ? ` (${p.type})` : ""}, ${when(p.updated)} by ${who(p)}`),
        "",
        `Wanted pages (${wiki.wanted().length}): ${wanted.map((w) => `[[${w.title}]] ×${w.from.length}`).join(", ") || "none"}`,
        `Pages nothing links to (${orphans.length}): ${list(orphans.slice(0, 30)) || "none"}`,
        ...(dups.length ? [`Duplicate titles: ${dups.map((d) => d[0].title).join(", ")}`] : []),
      ].join("\n");
    });

  add("search",
    "Find pages by words in their title, aliases, tags and text. Returns the best matches with a snippet. Use it " +
      "before creating a page. type / tag narrow it down (query may then be empty).",
    S({
      query: { type: "string", description: "Words to look for" },
      type: { type: "string", description: "Only pages of this type (e.g. Gene, Paper)" },
      tag: { type: "string", description: "Only pages with this tag" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 20)" },
    }), async ({ query = "", type, tag, limit = 20 }) => {
      const wiki = await getWiki();
      const results = wiki.search(query, { type, tag, limit });
      if (!results.length) return `No pages match "${query}".`;
      return (results.map(({ page, snippet }) =>
        `- [[${page.title}]]${page.type ? ` (${page.type})` : ""}${page.aliases.length ? ` aka ${page.aliases.join(", ")}` : ""}` +
          `${snippet ? `: ${snippet}` : ""}`).join("\n"));
    });

  add("list",
    "All page titles (A to Z) with their type and tags, optionally of one type or tag. For a full picture of what " +
      "exists.",
    S({
      type: { type: "string" },
      tag: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 2000, description: "Default 500" },
    }), async ({ type, tag, offset = 0, limit = 500 }) => {
      const wiki = await getWiki();
      const pages = wiki.search("", { type, tag, limit: 100000 }).map((r) => r.page)
        .sort((a, b) => a.title.localeCompare(b.title));
      const part = pages.slice(offset, offset + limit);
      const more = pages.length > offset + limit ? `\n(${pages.length - offset - limit} more: offset ${offset + limit})` : "";
      return (`${pages.length} pages\n` + part.map((p) =>
        `- ${p.title}${p.type ? ` (${p.type})` : ""}${p.tags.length ? ` #${p.tags.join(" #")}` : ""}`).join("\n") + more);
    });

  add("read",
    "Read pages: their Markdown (properties and text), what links to them, and links to pages that don't exist yet.",
    S({
      title: TITLE,
      titles: { type: "array", items: { type: "string" }, description: "Several pages at once" },
    }), async ({ title, titles }) => {
      const wiki = await getWiki();
      const names = [...(title ? [title] : []), ...(titles ?? [])];
      if (!names.length) throw new Error("Give title or titles");
      return (names.map((n) => {
        try {
          return pageText(wiki, wiki.need(n));
        } catch (error) {
          return `# ${n}\n${error.message}`;
        }
      }).join("\n\n"));
    });

  add("create",
    "Create a new page. With a type and no body it starts from the type's template (its fields and sections). " +
      "Fails when the title (or an alias) exists: then edit that page instead.",
    S({
      title: { type: "string", description: "The new page's title: no [ ] # ^ | \\ / : * ? \" < >" },
      type: { type: "string", description: "Its type (see wiki__types), e.g. Gene, Protein, Paper, Experiment" },
      body: { type: "string", description: "Its Markdown text without the properties block (optional)" },
      properties: { type: "object", description: "Properties to set, e.g. {\"aliases\": [\"p53\"], \"uniprot\": \"P04637\"}" },
    }, ["title"]), async ({ title, type, body, properties }, author) => {
      const wiki = await getWiki();
      const clash = wiki.resolve(title);
      if (clash) throw new Error(`"${title}" exists already as [[${clash.title}]]: edit it instead`);
      let markdown = wiki.template(type ?? null);
      if (body !== undefined) {
        const { yaml } = splitFrontmatter(markdown);
        markdown = yaml === null ? String(body) : `---\n${yaml}\n---\n\n${String(body).replace(/^\n+/, "")}`;
      }
      if (properties && Object.keys(properties).length) markdown = setProperties(markdown, properties);
      const page = await wiki.create({ title, type: type ?? null, markdown }, author);
      return `Created [[${page.title}]] (${pageLink(page.title)}).`;
    });

  add("write",
    "Replace a page's whole Markdown (properties block included), or create the page when it doesn't exist. Prefer " +
      "wiki__edit / wiki__append for changes to existing pages.",
    S({ title: { type: "string" }, markdown: { type: "string", description: "The whole page" } }, ["title", "markdown"]),
    async ({ title, markdown }, author) => {
      const wiki = await getWiki();
      const page = wiki.find(title);
      if (!page || page.trashed) {
        const created = await wiki.create({ title, markdown: String(markdown) }, author);
        return `Created [[${created.title}]] (${pageLink(created.title)}).`;
      }
      await wiki.save(page.id, String(markdown), author);
      return `Saved [[${page.title}]].`;
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
      const page = wiki.need(title);
      if (!old_text) throw new Error("old_text is empty");
      const count = page.markdown.split(old_text).length - 1;
      if (!count) throw new Error(`old_text is not in [[${page.title}]]; read the page again (wiki__read)`);
      if (count > 1 && !replace_all) throw new Error(`old_text is in [[${page.title}]] ${count} times: give more context or replace_all`);
      const markdown = replace_all ? page.markdown.split(old_text).join(new_text) : page.markdown.replace(old_text, () => new_text);
      await wiki.save(page.id, markdown, author);
      return (`Changed [[${page.title}]] (${count > 1 ? `${count} places` : "1 place"}).`);
    });

  add("append",
    "Add text to a page: at the end of the section under heading (the heading is made when missing), or at the end " +
      "of the page.",
    S({ title: TITLE, text: { type: "string" }, heading: { type: "string", description: "e.g. Results" } },
      ["title", "text"]), async ({ title, text, heading }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      await wiki.save(page.id, appendText(page.markdown, text, heading ?? null), author);
      return (`Added to [[${page.title}]]${heading ? ` under "${heading}"` : ""}.`);
    });

  add("set_properties",
    "Set properties of a page (the YAML block at its top) without touching anything else. null removes one. Link " +
      "values as \"[[Page]]\"; lists as arrays.",
    S({ title: TITLE, properties: { type: "object" } }, ["title", "properties"]), async ({ title, properties }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      await wiki.setProps(page.id, properties ?? {}, author);
      return `Set ${Object.keys(properties ?? {}).join(", ")} on [[${page.title}]].`;
    });

  add("rename", "Rename a page; every link to it in other pages is changed too.",
    S({ title: TITLE, new_title: { type: "string" } }, ["title", "new_title"]), async ({ title, new_title }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      const old = page.title;
      const { page: renamed, updated } = await wiki.rename(page.id, new_title, author);
      return `Renamed [[${old}]] to [[${renamed.title}]]; links fixed in ${updated} other page(s).`;
    });

  add("trash", "Move a page to the trash. It keeps its history and wiki__restore brings it back.",
    S({ title: TITLE }, ["title"]), async ({ title }, author) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      await wiki.trash(page.id, author);
      return `[[${page.title}]] is in the trash.`;
    });

  add("history",
    "A page's earlier versions, newest first: when, by whom, and the revision id to give wiki__restore.",
    S({ title: TITLE, limit: { type: "integer", minimum: 1, maximum: 120 } }, ["title"]), async ({ title, limit = 20 }) => {
      const wiki = await getWiki();
      const page = wiki.find(title);
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
      return `Restored [[${restored.title}]].`;
    });

  add("types", "The page types with their fields (property keys), and how many pages each has.", S({}), async () => {
    const wiki = await getWiki();
    const count = new Map();
    for (const p of wiki.live()) if (p.type) count.set(keyOf(p.type), (count.get(keyOf(p.type)) ?? 0) + 1);
    return (wiki.types().map((t) =>
      `- ${t.icon ?? ""} ${t.name} (${count.get(keyOf(t.name)) ?? 0} pages)${t.builtIn ? "" : " [the user's]"}: ` +
        `${(t.fields ?? []).map((f) => `${f.key}${f.kind && f.kind !== "text" ? `:${f.kind}` : ""}`).join(", ") || "no fields"}` +
        `${t.sections?.length ? `; sections ${t.sections.join(", ")}` : ""}`).join("\n"));
  });

  add("define_type",
    "Add a page type or change one (by name): its icon (an emoji), fields (property keys with labels; kind text, " +
      "link, links, list, date, number or url; url: a pattern with {} for the value, for database ids) and the " +
      "sections new pages of it start with. Ask the user before changing their types.",
    S({
      name: { type: "string" },
      icon: { type: "string" },
      description: { type: "string" },
      fields: { type: "array", items: { type: "object", properties: { key: { type: "string" }, label: { type: "string" },
        kind: { type: "string" }, url: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        required: ["key"] } },
      sections: { type: "array", items: { type: "string" } },
    }, ["name"]), async (args) => {
      const wiki = await getWiki();
      const type = await wiki.defineType(args);
      return `Type ${type.name} saved.`;
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
        const page = wiki.need(title);
        await wiki.save(page.id, appendText(page.markdown, `![[${record.name}]]`, heading ?? null), author);
        return `Uploaded ${record.name} and embedded it in [[${page.title}]].`;
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
      "file name, and the pictures and files its pages embed become attachments. Pages whose title exists are left " +
      "alone unless overwrite.",
    S({ path: { type: "string" }, overwrite: { type: "boolean" } }, ["path"]), async ({ path: root, overwrite = false }, author) => {
      const wiki = await getWiki();
      const mdFiles = [];
      const others = new Map();
      const walk = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (/\.md$/i.test(entry.name)) mdFiles.push(full);
          else others.set(entry.name.toLowerCase(), full);
        }
      };
      await walk(root);
      let created = 0;
      let replaced = 0;
      let skipped = 0;
      const problems = [];
      const wantedFiles = new Set();
      for (const file of mdFiles) {
        const title = cleanTitle(path.basename(file).replace(/\.md$/i, ""));
        const markdown = (await fs.readFile(file, "utf8")).replace(/\r\n?/g, "\n");
        try {
          const existing = wiki.resolve(title);
          if (existing && keyOf(existing.title) === keyOf(title)) {
            if (!overwrite) {
              skipped++;
              continue;
            }
            await wiki.save(existing.id, markdown, { ...author, note: "imported" });
            replaced++;
          } else {
            await wiki.create({ title, markdown }, author);
            created++;
          }
          for (const f of wiki.find(title)?.files ?? []) wantedFiles.add(f);
        } catch (error) {
          problems.push(`${path.basename(file)}: ${error.message}`);
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
        `alone (title exists). ${uploaded} attachment(s) uploaded.` +
        (problems.length ? `\nProblems:\n${problems.slice(0, 30).map((p) => `- ${p}`).join("\n")}` : ""));
    });

  add("mirror_status", "The folder copy of the wiki on this PC: where it is, when it was last written, problems.",
    S({}), async () => JSON.stringify(mirror.status(), null, 2));

  add("mirror_now", "Write the folder copy of the wiki now (it is kept up to date by itself).", S({}), async () => {
    await mirror.run({ reload: true });
    return JSON.stringify(mirror.status(), null, 2);
  });

  return tools;
}

/** Tools that only read (the others may change pages, so the panels hear wiki:changed from the model). */
export const READS = new Set(["guide", "overview", "search", "list", "read", "history", "types", "attachments",
  "mirror_status"]);
