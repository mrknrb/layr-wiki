// `app.markdown(root, markdown, {page, depth, tasks, pdf})`: a page's Markdown drawn into `root` (the reading view,
// page embeds, hover previews, the editor's embed widgets). shared/markdown.js makes the safe HTML; this fills in what
// needs the panel: attachments (Supabase Storage), PDFs (pdf.js), code highlighting (part A's bundle), clickable
// tasks, the lightbox, heading links.
import { splitFrontmatter } from "../../shared/frontmatter.js";
import { isImageName, isPdfName, renderMarkdown } from "../../shared/markdown.js";
import { keyOf, parseLink } from "../../shared/links.js";
import { el, icon } from "../app/dom.js";
import { openLightbox } from "./lightbox.js";
import { toggleTask } from "./lines.js";
import { mountPdf, openPdfFull } from "./pdf.js";
import { downloadFile, fileUrl, highlightNow, loadHighlighter, shortError } from "./util.js";

/** The renderer's options for the wiki as it is now. */
export function renderOptions(app, { page = null, depth = 0, tasks = true, pdf = true } = {}) {
  const settings = app.settings?.all?.() ?? {};
  return {
    resolve: (target) => {
      const p = app.wiki.resolve(target);
      return p ? { title: p.title, exists: true } : { title: target, exists: false };
    },
    embed: (target) => {
      const p = app.wiki.resolve(target);
      return p ? { title: p.title, body: p.body } : null;
    },
    page: page ? { title: page.title } : null,
    depth,
    highlight: highlightNow(),
    captions: settings.captions !== false,
    pdfInline: pdf && settings.pdfInline !== false,
    tasks: Boolean(tasks && page),
  };
}

/** Draw `markdown` (a whole page or only its text) into `root`. */
export function renderInto(app, root, markdown, opts = {}) {
  const text = String(markdown ?? "");
  const body = /^---[ \t]*\r?\n/.test(text) ? splitFrontmatter(text).body : text;
  const options = renderOptions(app, opts);
  root.classList.add("md");
  root.innerHTML = renderMarkdown(body, options);
  root._wikiSource = body;
  root._wikiPage = opts.page?.id ?? null;
  enhance(app, root, options);
  return root;
}

/** Everything the HTML can't do by itself. */
function enhance(app, root, options) {
  loadImages(app, root);
  for (const span of root.querySelectorAll(".pdf-embed[data-file]")) {
    mountPdf(app, span, { name: span.dataset.file, page: Number(span.dataset.pdfPage) || 1,
      height: Number(span.dataset.height) || null });
  }
  if (!options.highlight && root.querySelector("pre[data-lang]")) {
    loadHighlighter().then((highlight) => {
      if (!highlight) return;
      for (const code of root.querySelectorAll("pre[data-lang] > code")) {
        try {
          const html = highlight(code.textContent, code.parentElement.dataset.lang);
          if (typeof html === "string") code.innerHTML = html;
        } catch {
          // not a language it knows: stays plain
        }
      }
    });
  }
  for (const pre of root.querySelectorAll("pre")) {
    pre.append(el("button", { class: "code-copy", title: "Copy", "aria-label": "Copy the code",
      onclick: (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(pre.querySelector("code")?.textContent ?? "")
          .then(() => app.ui.notify("Copied"), () => {});
      } }, icon("copy")));
  }
  for (const h of root.querySelectorAll("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")) {
    h.append(el("button", { class: "heading-link", title: "Copy a link to this heading", "aria-label": "Copy link",
      onclick: (e) => {
        e.stopPropagation();
        const title = options.page?.title;
        const text = h.textContent.trim();
        navigator.clipboard?.writeText(title ? `[[${title}#${text}]]` : `#${h.id}`)
          .then(() => app.ui.notify("Link to the heading copied"), () => {});
      } }, icon("link")));
  }
  if (!root._wikiWired) {
    root._wikiWired = true;
    root.addEventListener("click", (e) => onClick(app, root, e));
    root.addEventListener("change", (e) => onChange(app, root, e));
  }
}

/** Fill in embedded pictures (attachments live in the user's Supabase Storage). */
export function loadImages(app, root) {
  for (const img of root.querySelectorAll("img.att[data-file]")) {
    if (img.src) continue;
    const name = img.dataset.file;
    img.classList.add("loading");
    fileUrl(app, name).then((url) => {
      img.src = url;
      img.classList.remove("loading");
    }).catch((error) => {
      img.closest(".figure")?.classList.add("broken");
      img.replaceWith(el("span", { class: "att-missing", title: error.message },
        icon("image"), ` ${name}: ${shortError(error)}`));
    });
  }
}

function onClick(app, root, e) {
  const img = e.target.closest("img");
  if (img && root.contains(img) && !img.closest("a") && !img.closest(".pdf-embed")) {
    e.preventDefault();
    // Every picture of this page (not of embeds inside it) is one step in the lightbox.
    const all = [...root.querySelectorAll("img")].filter((i) => !i.closest(".pdf-embed") && !i.closest("a") &&
      i.closest(".md") === img.closest(".md"));
    openLightbox(app, all.map(describe), Math.max(0, all.indexOf(img)));
    return;
  }
  const att = e.target.closest("a.att-link[data-file]");
  if (att && root.contains(att)) {
    e.preventDefault();
    e.stopPropagation();
    const name = att.dataset.file;
    if (/\.pdf$/i.test(name)) openPdfFull(app, name, 1);
    else if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name)) openLightbox(app, [{ file: name, caption: name }], 0);
    else downloadFile(app, name).catch((error) => app.ui.fail(error));
  }
}

const describe = (img) => ({
  file: img.dataset.file ?? null,
  src: img.dataset.file ? null : img.getAttribute("src"),
  caption: img.closest(".figure")?.querySelector(".figure-caption")?.textContent ?? img.getAttribute("alt") ?? "",
});

/** A task ticked in the reading view: tick the same line in the page's text. */
async function onChange(app, root, e) {
  const box = e.target.closest?.("input.task-box[data-line]");
  if (!box || !root.contains(box)) return;
  const owner = box.dataset.taskPage ? app.wiki.resolve(box.dataset.taskPage) : app.wiki.pages.get(root._wikiPage);
  const fail = (text) => {
    box.checked = !box.checked;
    app.ui.notify(text, "error");
  };
  if (!owner) return fail("This task's page isn't there any more");
  const markdown = toggleTask(owner.markdown, Number(box.dataset.line), box.checked);
  if (markdown === null) return fail("The page changed: the task isn't on that line any more");
  box.closest("li")?.classList.toggle("done", box.checked);
  try {
    // Remembered so the page view doesn't draw the page again for its own tick.
    if (!box.dataset.taskPage) root._wikiSource = splitFrontmatter(markdown).body;
    await app.wiki.save(owner.id, markdown, { by: "you" });
  } catch (error) {
    fail(error?.message ?? String(error));
  }
}

// ---------- what the editor (part A) calls ----------

/** `app.viewImage(name)`: the picture in the lightbox, with the open page's other pictures to step through. */
export function viewImage(app, name) {
  const page = app.page?.();
  const names = (page?.files ?? []).filter(isImageName);
  const list = names.some((n) => keyOf(n) === keyOf(name)) ? names : [name];
  openLightbox(app, list.map((file) => ({ file, caption: file })), Math.max(0, list.findIndex((n) => keyOf(n) === keyOf(name))));
}

/** `app.openAttachment(name)`: a PDF full size, a picture in the lightbox, anything else downloaded. */
export function openAttachment(app, name) {
  if (isPdfName(name)) return openPdfFull(app, name, 1);
  if (isImageName(name)) return viewImage(app, name);
  return downloadFile(app, name).catch((error) => app.ui.fail(error));
}

/**
 * `app.renderEmbed(el, target)`: an embed drawn into `el` (the editor's cards): `paper.pdf#page=2` as the PDF viewer,
 * a picture, or a page (`Page#Heading`) rendered.
 */
export function renderEmbed(app, host, target) {
  const { target: name, heading, label } = parseLink(String(target ?? ""));
  if (isPdfName(name)) {
    const page = Number(/(?:^|&)page=(\d+)/.exec(heading ?? "")?.[1]) || 1;
    const height = Number(/(?:^|&)height=(\d+)/.exec(heading ?? "")?.[1]) ||
      (/^\d{2,4}$/.test(label ?? "") ? Number(label) : null);
    return mountPdf(app, host, { name, page, height });
  }
  if (isImageName(name)) {
    const img = el("img", { class: "att", "data-file": name, alt: name });
    host.replaceChildren(img);
    return loadImages(app, host);
  }
  const page = app.wiki.resolve(name);
  return renderInto(app, host, page ? (heading ? `![[${page.title}#${heading}]]` : page.body) : `[[${name}]]`,
    { page, depth: 1, tasks: false });
}
