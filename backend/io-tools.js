// Tools to bring things into the wiki and take them out: Word and Notion imports, exports, public links. Added to
// buildTools (tools.js) with its helpers: ctx = {add(name, description, inputSchema, handler), S, getWiki, files,
// mirror, fs}. The panel sends files as base64 (big ones in parts through upload_part: one WebSocket message holds at
// most 32 MB); agents give a path on this PC. The pure conversions live in ../panels/io/convert.js, shared with the
// panel.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { cleanFileName, mimeOf } from "../shared/files.js";
import { setProperties } from "../shared/frontmatter.js";
import { cleanTitle, keyOf } from "../shared/links.js";
import { isImageName, renderInline, renderMarkdown } from "../shared/markdown.js";
import { readSettings } from "../shared/settings.js";
import {
  base64ToBytes, bytesToBase64, convertNotionMarkdown, csvToMarkdown, dataUrl, embeddedImages, exportDocument,
  markdownFiles, newSlug, notionLookups, planNotion, projectRef, propsTable, SHARE_MAX_BYTES, shareDoc, shareLink,
  shareRequest, standaloneHtml, zipStore,
} from "../panels/io/convert.js";

/** Tools here that only read (or don't touch pages). */
export const IO_READS = ["export", "upload_part"];

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PART_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_CLIP_IMAGE = 15 * 1024 * 1024;
const MAX_CLIP_IMAGES = 40;

/** Loaded on first use: these libraries take half a second, and most backends never import a file. */
const lib = {};
async function docxLibs() {
  lib.mammoth ??= (await import("mammoth")).default;
  lib.htmlToDocx ??= (await import("html-to-docx")).default;
  return lib;
}
async function turndown() {
  if (!lib.turndown) {
    const TurndownService = (await import("turndown")).default;
    const { gfm } = await import("turndown-plugin-gfm");
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-",
      emDelimiter: "*", hr: "---" });
    td.use(gfm);
    // Pictures uploaded during the import come back as wiki embeds.
    td.addRule("attachment", {
      filter: (node) => node.nodeName === "IMG" && /^wiki-attachment:/.test(node.getAttribute("src") ?? ""),
      replacement: (_c, node) => `![[${decodeURIComponent(node.getAttribute("src").slice("wiki-attachment:".length))}]]`,
    });
    td.addRule("droppedImage", {
      filter: (node) => node.nodeName === "IMG" && !/^(https?:|wiki-attachment:)/.test(node.getAttribute("src") ?? ""),
      replacement: (_c, node) => (node.getAttribute("alt") ? `*[picture: ${node.getAttribute("alt")}]*` : ""),
    });
    lib.turndown = td;
  }
  return lib.turndown;
}

/**
 * Word's HTML → Markdown the wiki renders: tables get a header row (Markdown tables need one; Word's first row is
 * usually it), paragraphs inside cells are flattened, and turndown's wide list markers are made normal.
 */
export async function htmlToMarkdown(html) {
  const td = await turndown();
  const fixed = String(html ?? "")
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_m, inner) => {
      const body = inner.replace(/<\/?(thead|tbody)\b[^>]*>/g, "");
      let first = true;
      const rows = body.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g, (_r, cells) => {
        // A Markdown cell is one line: paragraphs and line breaks in it become spaces.
        let flat = cells.replace(/<\/p>\s*<p\b[^>]*>/g, " ").replace(/<\/?p\b[^>]*>/g, "").replace(/<br\s*\/?>/g, " ");
        if (first) flat = flat.replace(/<td\b/g, "<th").replace(/<\/td>/g, "</th>");
        const row = `<tr>${flat}</tr>`;
        if (first) {
          first = false;
          return `<thead>${row}</thead><tbody>`;
        }
        return row;
      });
      return `<table>${rows}</tbody></table>`;
    });
  return td.turndown(fixed)
    .replace(/^(\s*)([-*+])\s{2,}/gm, "$1$2 ")
    .replace(/^(\s*)(\d+\.)\s{2,}/gm, "$1$2 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

/** A title not taken yet in the wiki: `Title`, `Title (2)`, … */
export function freeTitle(wiki, wanted, also = new Set()) {
  const base = cleanTitle(wanted);
  let title = base;
  for (let n = 2; ; n++) {
    let free = !also.has(keyOf(title));
    if (free) {
      try {
        wiki.checkTitle(title);
      } catch {
        free = false;
      }
    }
    if (free && wiki.resolve(title)) free = false;
    if (free) return title;
    title = `${base} (${n})`;
  }
}

/** Create a page in a folder (the folder argument is ignored by a model without folders). */
async function createPage(wiki, { title, folder, markdown }, author) {
  return wiki.create({ title, folder: folder || "", markdown }, author);
}

/**
 * Remote pictures in clipped Markdown (`![alt](https://…)`) → attachments, so they show (pages can't load other
 * sites). `fetchImpl` fetches; gives `{markdown, copied, failed}`. Pictures that fail stay as links.
 */
export async function copyRemoteImages(markdown, { files, fetchImpl = fetch, base = "clip" }) {
  const seen = new Map();
  let copied = 0;
  let failed = 0;
  const urls = [...String(markdown).matchAll(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[2]);
  for (const url of [...new Set(urls)].slice(0, MAX_CLIP_IMAGES)) {
    try {
      const res = await fetchImpl(url, { redirect: "follow" });
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mime)) throw new Error("not a picture");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_CLIP_IMAGE) throw new Error("too big");
      let name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || `${base}.png`;
      const ext = mime === "image/svg+xml" ? "svg" : mime.split("/")[1].replace("jpeg", "jpg");
      if (!isImageName(name)) name = `${name.replace(/\.[a-z0-9]{1,5}$/i, "") || base}.${ext}`;
      const record = await files.upload(cleanFileName(name), bytes, mime);
      seen.set(url, record.name);
      copied++;
    } catch (error) {
      failed++;
      if (/Sign in|database update/.test(error.message ?? "")) break;
    }
  }
  const out = String(markdown).replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) =>
    seen.has(url) ? `![[${seen.get(url)}]]` : `[${alt ? `Picture: ${alt}` : "Picture"}](${url})`);
  return { markdown: out, copied, failed };
}

export function buildIoTools({ add, S, getWiki, files, fs, isProposal = (r) => r?.proposal === true,
  proposedText = (p) => `Proposed: create [[${p.title}]], waiting for the user's review.` }) {
  /** Parts of big files the panel sends ahead: id → {parts: [], at}. */
  const uploads = new Map();
  const sweep = () => {
    for (const [id, u] of uploads) if (Date.now() - u.at > PART_TTL_MS) uploads.delete(id);
  };

  /** The bytes a tool was given: a path on this PC, base64, or an upload id. */
  const bytesOf = async ({ path: file, base64, upload }) => {
    if (upload) {
      const u = uploads.get(upload);
      if (!u) throw new Error("That upload is gone (older than 15 minutes?): send the file again");
      uploads.delete(upload);
      return base64ToBytes(u.parts.join(""));
    }
    if (base64) return base64ToBytes(base64);
    if (file) return new Uint8Array(await fs.readFile(file));
    throw new Error("Give path (a file on this PC) or base64");
  };

  const SOURCE = {
    path: { type: "string", description: "The file's absolute path on this PC" },
    base64: { type: "string", description: "Or the file's bytes as base64" },
    upload: { type: "string", description: "Or the id of an upload sent in parts with upload_part (panels)" },
  };

  add("upload_part",
    "Panels only: one part of a big file, sent ahead of import_word / import_notion / export (base64, in order).",
    S({ id: { type: "string" }, index: { type: "integer", minimum: 0 }, data: { type: "string" } }, ["id", "index", "data"]),
    async ({ id, index, data }) => {
      sweep();
      const u = uploads.get(id) ?? { parts: [], at: Date.now(), size: 0 };
      u.parts[index] = data;
      u.size += data.length;
      u.at = Date.now();
      if (u.size > MAX_UPLOAD * 1.4) throw new Error("The file is too big");
      uploads.set(id, u);
      return { ok: true, parts: u.parts.length };
    });

  add("import_word",
    "Import a Word file (.docx) as a new page: its text as Markdown (headings, lists, tables, links, bold and " +
      "italic), its pictures as attachments. The page is titled by the file's name (or title).",
    S({
      ...SOURCE,
      name: { type: "string", description: "The file's name (the page's title without .docx)" },
      title: { type: "string", description: "The new page's title (default: from name)" },
      folder: { type: "string", description: "The wiki folder it goes in (default: the top)" },
    }), async (args, author) => {
      const { mammoth } = await docxLibs();
      const bytes = await bytesOf(args);
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
      const wiki = await getWiki();
      const wanted = args.title || String(args.name ?? (args.path ? path.basename(args.path) : "Imported document"))
        .replace(/\.docx$/i, "");
      const title = freeTitle(wiki, wanted);
      const problems = [];
      let pictures = 0;
      let n = 0;
      const result = await mammoth.convertToHtml({ buffer }, {
        convertImage: mammoth.images.imgElement(async (image) => {
          n++;
          try {
            const ext = (image.contentType ?? "image/png").split("/")[1].replace("jpeg", "jpg").replace("+xml", "");
            const record = await files.upload(cleanFileName(`${title} ${n}.${ext}`), await image.read(), image.contentType);
            pictures++;
            return { src: `wiki-attachment:${encodeURIComponent(record.name)}` };
          } catch (error) {
            if (!problems.includes(error.message)) problems.push(error.message);
            return { src: "", alt: `picture ${n}` };
          }
        }),
      });
      const markdown = await htmlToMarkdown(result.value);
      const page = await createPage(wiki, { title, folder: args.folder, markdown }, author);
      const warnings = result.messages.filter((m) => m.type === "warning").length;
      if (isProposal(page)) return { proposal: page.id, title, pictures, problems, message: proposedText(page) };
      return {
        id: page.id, title: page.title, pictures, skippedPictures: n - pictures, problems,
        message: `Imported [[${page.title}]] (${pictures} picture(s)` +
          `${n - pictures ? `, ${n - pictures} not copied: ${problems[0] ?? "failed"}` : ""})` +
          `${warnings ? `; Word formatting the wiki can't show was left out (${warnings} note(s))` : ""}.`,
      };
    });

  add("import_notion",
    "Import a Notion export (Markdown & CSV, as its .zip or an unpacked folder): pages keep Notion's nesting as " +
      "folders (without Notion's ids), links between them become [[links]], pictures and files become attachments, " +
      "and each database becomes one page with its rows as a table. Titles that exist get \" (2)\".",
    S({ ...SOURCE, folder: { type: "string", description: "The wiki folder it goes in (default: the top)" } }),
    async (args, author) => {
      const wiki = await getWiki();
      /** Every file of the export: path → () => bytes. */
      const entries = new Map();
      const isDir = args.path && !args.base64 && !args.upload && (await fs.stat(args.path)).isDirectory();
      if (isDir) {
        const walk = async (dir, rel) => {
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(full, r);
            else entries.set(r, async () => new Uint8Array(await fs.readFile(full)));
          }
        };
        await walk(args.path, "");
      } else {
        const { unzipSync } = await import("fflate");
        const zip = unzipSync(await bytesOf(args));
        // Notion puts big exports in zips inside the zip.
        for (const [name, data] of Object.entries(zip)) {
          if (name.endsWith("/")) continue;
          if (/\.zip$/i.test(name)) {
            for (const [inner, d] of Object.entries(unzipSync(data))) if (!inner.endsWith("/")) entries.set(inner, async () => d);
          } else entries.set(name, async () => data);
        }
      }
      if (![...entries.keys()].some((p) => /\.(md|csv)$/i.test(p))) {
        throw new Error("No Notion pages in it: export from Notion as \"Markdown & CSV\"");
      }
      const plan = planNotion([...entries.keys()], { taken: (t) => Boolean(wiki.resolve(t)), folder: args.folder ?? "" });
      const keyed = new Map([...entries].map(([p, read]) => [p.replace(/\\/g, "/").toLowerCase(), read]));
      const read = (p) => keyed.get(p.toLowerCase())();
      const text = async (p) => new TextDecoder().decode(await read(p));
      // Attachments first, so pages embed the names they really got.
      const lookups = notionLookups(plan);
      const uploaded = new Map();
      const problems = [];
      let stopUploads = false;
      for (const f of plan.files) {
        if (stopUploads) break;
        try {
          const record = await files.upload(f.name, await read(f.path), mimeOf(f.name));
          uploaded.set(lookups.key(f.path), record.name);
        } catch (error) {
          problems.push(`${f.name}: ${error.message}`);
          if (/Sign in|database update/.test(error.message)) stopUploads = true;
        }
      }
      const { titleOf, fileOf } = notionLookups(plan, uploaded);
      const titles = new Map(plan.pages.map((p) => [keyOf(p.title), p.title]));
      let created = 0;
      let proposed = 0;
      let firstId = null;
      for (const p of plan.pages) {
        try {
          const raw = await text(p.path);
          const markdown = p.kind === "csv"
            ? `${csvToMarkdown(raw, { linkOf: (cell) => titles.get(keyOf(cleanTitle(cell))) ?? null })}\n`
            : convertNotionMarkdown(raw, { path: p.path, title: p.title, titleOf, fileOf });
          const page = await createPage(wiki, { title: p.title, folder: p.folder, markdown }, author);
          if (isProposal(page)) proposed++;
          else {
            firstId ??= page.id;
            created++;
          }
        } catch (error) {
          problems.push(`${p.title}: ${error.message}`);
        }
      }
      const databases = plan.pages.filter((p) => p.kind === "csv").length;
      return {
        created, proposed, attachments: uploaded.size, databases, firstId, problems: problems.slice(0, 30),
        message: `Imported ${created} page(s) from Notion` +
          `${proposed ? ` (${proposed} new page(s) wait for the user's review in the Wiki's Review page)` : ""}` +
          `${databases ? ` (${databases} database(s) as pages with a table)` : ""}, ${uploaded.size} attachment(s).` +
          `${stopUploads ? ` Attachments stopped: ${problems.at(-1)}` : ""}` +
          `${problems.length ? `\nProblems:\n${problems.slice(0, 30).map((x) => `- ${x}`).join("\n")}` : ""}`,
      };
    });

  /** Rendered pages for an export made here (agents): our renderer, pictures inlined from the attachments. */
  const renderPages = async (wiki, pages) => {
    const resolve = (t) => {
      const p = wiki.resolve(t);
      return p ? { title: p.title, exists: true } : { title: t, exists: false };
    };
    const rendered = pages.map((p) => ({
      title: p.title,
      html: renderMarkdown(p.body, { resolve }),
      propsHtml: propsTable(p.props, (v) => renderInline(v, { resolve })),
    }));
    const images = {};
    for (const name of new Set(rendered.flatMap((r) => embeddedImages(r.html)))) {
      try {
        const { record, bytes } = await files.download(name);
        images[name] = dataUrl(new Uint8Array(bytes), record.mime);
      } catch {
        // shown as "[picture: name]"
      }
    }
    return { rendered, images };
  };

  add("export",
    "Export pages as one HTML file (pictures and styles inside it, links between the pages work), a Word file " +
      "(.docx), or Markdown (a .zip with the attachments). Give titles (or a folder) and path to write the file on " +
      "this PC; without path the file comes back as base64.",
    S({
      format: { type: "string", enum: ["html", "docx", "markdown"] },
      titles: { type: "array", items: { type: "string" }, description: "The pages, in order" },
      folder: { type: "string", description: "Or every page in this folder (and its subfolders)" },
      title: { type: "string", description: "The document's title (default: the first page's)" },
      path: { type: "string", description: "Where to write it on this PC (absolute)" },
      html: { type: "string", description: "Panels: the finished HTML to turn into .docx" },
      upload: { type: "string", description: "Panels: the HTML sent ahead with upload_part" },
    }, ["format"]), async (args) => {
      let html = args.upload ? new TextDecoder().decode(await bytesOf({ upload: args.upload })) : args.html ?? null;
      let docTitle = args.title ?? "Wiki export";
      let out;
      if (html === null || args.format === "markdown") {
        const wiki = await getWiki();
        let pages = (args.titles ?? []).map((t) => wiki.need(t));
        if (args.folder !== undefined && args.folder !== null) {
          const f = keyOf(args.folder).replace(/^\/+|\/+$/g, "");
          pages.push(...wiki.live().filter((p) => {
            const pf = keyOf(p.folder ?? "");
            return !f || pf === f || pf.startsWith(`${f}/`);
          }).sort((a, b) => a.title.localeCompare(b.title)));
        }
        pages = [...new Map(pages.map((p) => [p.id, p])).values()];
        if (!pages.length) throw new Error("Give titles or a folder with pages");
        docTitle = args.title ?? (pages.length === 1 ? pages[0].title : `${pages[0].title} and ${pages.length - 1} more`);
        if (args.format === "markdown") {
          const names = new Set(pages.flatMap((p) => p.files ?? []));
          const attachments = [];
          for (const name of names) {
            try {
              const { record, bytes } = await files.download(name);
              attachments.push({ name: record.name, bytes: new Uint8Array(bytes) });
            } catch {
              // a missing attachment: the page still links its name
            }
          }
          out = { bytes: zipStore(markdownFiles(pages, attachments)), ext: "zip", mime: "application/zip" };
        } else {
          const { rendered, images } = await renderPages(wiki, pages);
          html = exportDocument({ title: docTitle, pages: rendered, images });
        }
      }
      if (!out && args.format === "html") {
        out = { bytes: new TextEncoder().encode(html), ext: "html", mime: "text/html" };
      } else if (!out) {
        const { htmlToDocx } = await docxLibs();
        // html-to-docx wants the body's HTML; styles in <style> don't carry over to Word anyway.
        const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
        const buffer = await htmlToDocx(body, null, { title: docTitle, creator: "layr Wiki", table: { row: { cantSplit: true } },
          footer: false, pageNumber: false });
        out = { bytes: new Uint8Array(buffer), ext: "docx", mime: DOCX_MIME };
      }
      const name = `${cleanFileName(`${docTitle}.${out.ext}`)}`;
      if (args.path) {
        await writeFile(args.path, out.bytes);
        return { path: args.path, size: out.bytes.length, message: `Wrote ${args.path} (${Math.ceil(out.bytes.length / 1024)} KB).` };
      }
      return { name, mime: out.mime, size: out.bytes.length, base64: bytesToBase64(out.bytes) };
    });

  add("clip_images",
    "Panels: copy the remote pictures of a clipped web page's Markdown into attachments (pages can't load other " +
      "sites' pictures). Gives {markdown, copied, failed}.",
    S({ markdown: { type: "string" }, name: { type: "string", description: "A base name for unnamed pictures" } },
      ["markdown"]), async ({ markdown, name }) =>
      copyRemoteImages(markdown, { files, base: cleanTitle(name ?? "clip").slice(0, 60) }));

  add("clip_page",
    "Save Markdown you read from the web as a new page in the clippings folder, with source and clipped properties " +
      "(its pictures copied as attachments). For agents that read a page with scraper__read.",
    S({
      url: { type: "string" },
      title: { type: "string" },
      markdown: { type: "string" },
      folder: { type: "string", description: "Default: the Clippings folder of the wiki's settings" },
    }, ["url", "title", "markdown"]), async ({ url, title, markdown, folder }, author) => {
      const wiki = await getWiki();
      const settings = await readSettings(wiki.a);
      const t = freeTitle(wiki, title);
      const { markdown: body } = await copyRemoteImages(markdown, { files, base: t.slice(0, 60) });
      const md = setProperties(body, { source: url, clipped: new Date().toISOString().slice(0, 10) });
      const page = await createPage(wiki, { title: t, folder: folder ?? settings.clipFolder ?? "Clippings", markdown: md },
        author);
      return isProposal(page) ? proposedText(page) : `Clipped ${url} as [[${page.title}]].`;
    });

  // ---------- public links (the panel's Publish does the same: panels/io/share.js) ----------

  const shareKey = (id) => `share/${id}`;

  add("publish",
    "Publish a page as a public read-only web page (or update its public copy): anyone with the link can read it. " +
      "Only when the user asked for it. Needs the user's share viewer address (wiki settings › Sharing). Gives the link.",
    S({ title: { type: "string", description: "The page's title (any case), or one of its aliases" } }, ["title"]),
    async ({ title }) => {
      const wiki = await getWiki();
      const page = wiki.need(title);
      const settings = await readSettings(wiki.a);
      const viewer = String(settings.shareViewer ?? "").trim();
      if (!viewer) {
        throw new Error("The user has no share viewer yet: they host share/index.html (see the Wiki's README, " +
          "Public links) and put its address in the wiki's Settings › Sharing");
      }
      const session = await files.session();
      if (!session?.accessToken) throw new Error("Sign in to layr to publish pages");
      const ref = projectRef(session.url);
      const existing = await wiki.a.dataGet(shareKey(page.id));
      const slug = existing?.slug ?? newSlug();
      const { rendered, images } = await renderPages(wiki, [page]);
      const anchors = new Map();
      for (const row of await wiki.a.dataList({ prefix: "share/", limit: 1000 })) {
        const other = wiki.pages.get(row.key.slice(6));
        if (other && other.id !== page.id && row.value?.url) anchors.set(keyOf(other.title), row.value.url);
      }
      const html = standaloneHtml(rendered[0].propsHtml + rendered[0].html, { anchors, images });
      const doc = shareDoc({ title: page.title, html, updated: page.updated, published: existing?.at ?? Date.now() });
      const bytes = new TextEncoder().encode(JSON.stringify(doc));
      if (bytes.length > SHARE_MAX_BYTES) throw new Error("The page is too big to publish (its pictures): at most 20 MB");
      await shareRequest(session, "POST", slug, bytes, files.fetch);
      const record = { slug, url: shareLink(viewer, { ref, uid: session.userId, slug }), at: existing?.at ?? Date.now(),
        title: page.title, updated: page.updated, published: Date.now() };
      await wiki.a.dataSet(shareKey(page.id), record);
      wiki.a.emit?.("wiki:changed", { ids: [page.id], shares: true });
      return `${existing ? "Updated" : "Published"} [[${page.title}]]: ${record.url}`;
    });

  add("unpublish", "Stop sharing a page publicly: its public link stops working.",
    S({ title: { type: "string", description: "The page's title (any case), or one of its aliases" } }, ["title"]),
    async ({ title }) => {
      const wiki = await getWiki();
      const page = wiki.find(title) ?? wiki.need(title);
      const existing = await wiki.a.dataGet(shareKey(page.id));
      if (!existing?.slug) return `[[${page.title}]] isn't public.`;
      await shareRequest(await files.session(), "DELETE", existing.slug, null, files.fetch);
      await wiki.a.dataDelete(shareKey(page.id));
      wiki.a.emit?.("wiki:changed", { ids: [page.id], shares: true });
      return `[[${page.title}]] is private again.`;
    });
}
