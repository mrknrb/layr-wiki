// The web clipper ("Clip a web page"): a URL → Web tools (`scraper__scrape`, the page's main article as Markdown) →
// a new page in the clippings folder with `source` and `clipped` properties. On the PC the backend copies the page's
// pictures into attachments (pages can't load other sites' pictures); elsewhere they stay as links.
import { el, icon } from "../app/dom.js";
import { clipPage } from "./prompts.js";

async function freeTitle(app, wanted) {
  let title = wanted;
  for (let n = 2; app.wiki.resolve(title); n++) title = `${wanted} (${n})`;
  return title;
}

export async function clip(app, url) {
  let address = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(address)) address = `https://${address}`;
  try {
    new URL(address);
  } catch {
    throw new Error("That isn't a web address");
  }
  const read = await app.ai.readWeb(address);
  if (!read?.content?.trim()) throw new Error(read?.loadError ? `The page didn't load: ${read.loadError}` : "The page had no text to clip");
  let markdown = read.content;
  let note = "";
  try {
    const r = await app.tools("clip_images", { markdown, name: read.title ?? "clip" });
    markdown = r.markdown;
    if (r.failed) note = ` ${r.failed} picture(s) not copied (kept as links).`;
  } catch {
    note = " Pictures were not copied (that needs the wiki on your PC); they are links.";
  }
  const page = clipPage({ title: read.title, url: read.url ?? address, markdown });
  const title = await freeTitle(app, page.title);
  const created = await app.wiki.create({ title, folder: app.settings?.get?.("clipFolder") ?? "Clippings",
    markdown: page.markdown });
  return { page: created, note: `${read.truncated ? " The page was long and was cut." : ""}${note}` };
}

export function openClipper(app) {
  if (!app.ai.canClip()) {
    app.ui.modal("Clip a web page", (body, close) => body.append(
      el("p", {}, "The clipper reads web pages through the Web tools plugin."),
      el("p", { class: "layr-muted" }, "Install Web tools from layr's store. The first clip asks whether the wiki may " +
        "open and read web pages; if you said no, allow it in Settings › Tool access."),
      el("div", { class: "ai-modal-buttons" },
        el("button", { class: "layr-button", onclick: () => app.ai.check() }, icon("refresh-cw"), "Check again"),
        el("button", { class: "layr-button primary", onclick: close }, "OK"))));
    return;
  }
  app.ui.modal("Clip a web page", (body, close) => {
    body.classList.add("ai-clip");
    const input = el("input", { class: "layr-input", type: "url", placeholder: "https://…", "aria-label": "Web address" });
    const status = el("div", { class: "ai-clip-status" });
    const go = el("button", { class: "layr-button primary", type: "submit" }, icon("scissors"), "Clip");
    const form = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      go.disabled = true;
      input.disabled = true;
      status.replaceChildren(el("span", { class: "layr-spinner" }), "Opening and reading the page…");
      try {
        const { page, note } = await clip(app, input.value);
        close();
        app.ui.notify(`Clipped as “${page.title}”.${note}`, "success");
        app.openPage(page.id);
      } catch (error) {
        status.replaceChildren(el("span", { class: "layr-error" }, error.message));
        go.disabled = false;
        input.disabled = false;
      }
    } }, el("label", { class: "layr-label" }, "Web address"), el("div", { class: "ai-clip-row" }, input, go), status,
    el("p", { class: "layr-muted ai-small" },
      `The article becomes a page in the “${app.settings?.get?.("clipFolder") || "Clippings"}” folder, with its address ` +
        "and today's date as properties."));
    body.append(form);
    setTimeout(() => input.focus(), 30);
  });
}

export function installClipper(app) {
  app.commands?.register({ id: "clip", title: "Clip a web page", icon: "scissors", run: () => openClipper(app) });
}
