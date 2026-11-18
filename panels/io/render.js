// Pages rendered for leaving the wiki (exports, print, public pages): the page part's renderer (app.markdown) into an
// off-screen element, cleaned of anything interactive, pictures fetched from the attachments as data URLs. Also the
// panel's ways to hand files to the user (layr.files.saveAs) and big files to the backend (in parts).
import { renderInline, renderMarkdown } from "../../shared/markdown.js";
import { bytesToBase64, dataUrl, embeddedImages, propsTable } from "./convert.js";

const DROP = "script, style, iframe, object, embed, canvas, video, audio, button, input:not([type=checkbox]), select, " +
  "textarea, form, .no-export, [data-no-export]";

/** Our own renderer's HTML for a page body (no app: the backend's way, also a fallback). */
function plainHtml(app, markdown) {
  const resolve = (t) => {
    const p = app.wiki.resolve(t);
    return p ? { title: p.title, exists: true } : { title: t, exists: false };
  };
  return { html: renderMarkdown(markdown, { resolve }), inline: (v) => renderInline(v, { resolve }) };
}

/** Cleans rendered HTML: no scripts, handlers, frames or controls; pictures without their (blob) addresses. */
function clean(root) {
  for (const n of root.querySelectorAll(DROP)) {
    if (!n.isConnected) continue;
    // A PDF shown inside the page becomes its name.
    const file = n.closest("[data-file]")?.getAttribute("data-file");
    n.replaceWith(file && n.matches("iframe, canvas, object, embed") ? Object.assign(document.createElement("span"),
      { className: "att-file", textContent: `📎 ${file}` }) : "");
  }
  for (const n of root.querySelectorAll("*")) {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || a.name === "contenteditable" || a.name === "draggable" ||
        (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
    if (n.matches("img[data-file]")) {
      n.removeAttribute("src");
      n.removeAttribute("srcset");
      n.removeAttribute("loading");
    }
    if (n.matches("input[type=checkbox]")) n.setAttribute("disabled", "");
  }
  return root.innerHTML;
}

/**
 * Pages → `{rendered: [{title, html, propsHtml}], images: {name: data URL}, missing: n}`. `onProgress(text)` tells
 * what it is doing (a big export takes a while).
 */
export async function renderPages(app, pages, { onProgress = () => {} } = {}) {
  const host = document.createElement("div");
  host.className = "io-offscreen";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  const rendered = [];
  try {
    for (const [i, page] of pages.entries()) {
      onProgress(`Rendering ${i + 1} of ${pages.length}…`);
      const root = document.createElement("div");
      root.className = "wiki-content";
      host.append(root);
      let html;
      const plain = plainHtml(app, page.body ?? page.markdown);
      if (app.markdown) {
        try {
          await app.markdown(root, page.body ?? page.markdown, { page, depth: 0, export: true });
          // Give embeds that fill in later a moment.
          await new Promise((r) => setTimeout(r, 30));
          html = clean(root);
        } catch {
          html = null;
        }
      }
      if (html === null || html === undefined) {
        root.innerHTML = plain.html;
        html = clean(root);
      }
      root.remove();
      rendered.push({ title: page.title, html, propsHtml: propsTable(page.props, plain.inline) });
    }
  } finally {
    host.remove();
  }
  const images = {};
  let missing = 0;
  const names = [...new Set(rendered.flatMap((r) => [...embeddedImages(r.html), ...embeddedImages(r.propsHtml)]))];
  for (const [i, name] of names.entries()) {
    onProgress(`Pictures ${i + 1} of ${names.length}…`);
    try {
      const { record, bytes } = await app.files.download(name);
      images[name] = dataUrl(new Uint8Array(bytes), record.mime);
    } catch {
      missing++;
    }
  }
  return { rendered, images, missing };
}

/** The attachments some pages embed, as bytes (for the Markdown zip). */
export async function attachmentsOf(app, pages, { onProgress = () => {} } = {}) {
  const names = [...new Set(pages.flatMap((p) => p.files ?? []))];
  const out = [];
  let missing = 0;
  for (const [i, name] of names.entries()) {
    onProgress(`Attachments ${i + 1} of ${names.length}…`);
    try {
      const { record, bytes } = await app.files.download(name);
      out.push({ name: record.name, bytes: new Uint8Array(bytes) });
    } catch {
      missing++;
    }
  }
  return { attachments: out, missing };
}

/** Let the user save `data` as a file (the system's Save dialog). Gives false when they cancelled. */
export async function saveFile(name, data, { types = [], mime = "application/octet-stream" } = {}) {
  let ref;
  try {
    ref = await layr.files.saveAs({ name, types });
  } catch (error) {
    if (error?.code !== layr.errors?.NOT_ALLOWED && error?.code !== layr.errors?.UNKNOWN_METHOD) throw error;
    // An older layr without files: the browser's download.
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([data], { type: mime })),
      download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return true;
  }
  if (!ref) return false;
  await layr.files.write(ref.id, data);
  return true;
}

const PART = 4 * 1024 * 1024;

/**
 * Arguments that carry bytes to a backend tool: `{base64}` for small files, else the parts are sent ahead with
 * upload_part and `{upload: id}` names them (one WebSocket message holds at most 32 MB).
 */
export async function bytesArgs(app, bytes, { onProgress = () => {} } = {}) {
  const b64 = bytesToBase64(bytes);
  if (b64.length <= PART * 2) return { base64: b64 };
  const id = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const parts = Math.ceil(b64.length / PART);
  for (let i = 0; i < parts; i++) {
    onProgress(`Sending ${Math.round(((i + 1) / parts) * 100)}%…`);
    await app.tools("upload_part", { id, index: i, data: b64.slice(i * PART, (i + 1) * PART) });
  }
  return { upload: id };
}

/** Is this the phone (no backend, no printing)? */
export const onPhone = () => layr.info?.device?.kind === "phone";

/** A backend call failed: on the phone say it needs the PC. */
export function backendError(error, what) {
  if (onPhone() || error?.code === layr.errors?.NOT_AVAILABLE) {
    return new Error(`${what} needs the wiki on your PC: do it in layr there.`);
  }
  return error;
}
