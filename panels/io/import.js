// Imports: a Word file (.docx) as a page, a Notion export (.zip, "Markdown & CSV") as pages with folders. The user
// picks the file (layr.files.open); the bytes go to the backend's import_word / import_notion tools (mammoth and
// turndown, fflate there), in parts when big. Needs the wiki's backend, so the PC.
import { el } from "../app/dom.js";
import { backendError, bytesArgs } from "./render.js";

async function pickFolder(app, title) {
  const current = app.page?.()?.folder ?? "";
  const folders = app.wiki.folders?.() ?? [];
  return new Promise((resolve) => {
    let result = null;
    app.ui.modal(title, (body, close) => {
      body.classList.add("io-dialog");
      const input = el("input", { class: "layr-input", value: current, list: "io-folders", placeholder: "The top folder" });
      body.append(
        el("label", { class: "layr-label" }, "Into the folder"), input,
        el("datalist", { id: "io-folders" }, folders.map((f) => el("option", { value: f }))),
        el("p", { class: "layr-muted ai-small" }, "Empty: the top of the wiki. A folder that doesn't exist is made."));
      return { ok: "Choose the file…", focus: input, run: () => {
        result = input.value.trim().replace(/^\/+|\/+$/g, "");
        close();
      } };
    }, { onClose: () => resolve(result) });
  });
}

function progress(text) {
  const box = el("div", { class: "io-progress", role: "status" }, el("span", { class: "layr-spinner" }), el("span", {}, text));
  document.body.append(box);
  return { set: (t) => (box.lastChild.textContent = t), done: () => box.remove() };
}

async function importFile(app, { title, types, tool, what }) {
  const folder = await pickFolder(app, title);
  if (folder === null) return;
  let file;
  try {
    file = await layr.files.open({ types });
  } catch (error) {
    return app.ui.fail(error);
  }
  if (!file) return;
  const p = progress(`Reading ${file.name}…`);
  try {
    const bytes = new Uint8Array(await layr.files.read(file.id));
    const args = await bytesArgs(app, bytes, { onProgress: p.set });
    p.set(`Importing ${file.name}…`);
    let result;
    try {
      result = await app.tools(tool, { ...args, ...(tool === "import_word" ? { name: file.name } : {}), folder });
    } catch (error) {
      throw backendError(error, what);
    }
    const id = result?.id ?? result?.firstId;
    // The backend announces its changes; read the new page now so it opens at once.
    if (id) await app.wiki.refresh?.([id])?.catch?.(() => {});
    app.refresh?.();
    const message = String(result?.message ?? "Imported").replace(/\[\[([^\]]+)\]\]/g, "“$1”");
    app.ui.notify(message.split("\n")[0], result?.problems?.length ? "info" : "success");
    if (result?.problems?.length) console.warn("wiki import problems", result.problems);
    if (id) app.openPage(id);
  } catch (error) {
    app.ui.fail(error);
  } finally {
    p.done();
  }
}

export const importWord = (app) => importFile(app, { title: "Import a Word file", types: [".docx"], tool: "import_word",
  what: "Importing Word files" });

export const importNotion = (app) => importFile(app, { title: "Import a Notion export", types: [".zip"],
  tool: "import_notion", what: "Importing from Notion" });
