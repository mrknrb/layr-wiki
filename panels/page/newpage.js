// `app.newPage({title, folder, type, template})`: the New page dialog. Title (its problems shown while typing, and a
// page that has it already offered instead), folder, type (the user's types, or none) and template (the pages in the
// templates folder; a type's own template is used when none is picked). Creates the page and opens it to write.
import { keyOf, titleProblem } from "../../shared/links.js";
import { el } from "../app/dom.js";
import { fill, safe } from "./util.js";

/** Every folder path: the model's, plus those the pages are in. */
export function folderList(app) {
  const set = new Set(safe(() => app.wiki.folders?.(), []) ?? []);
  for (const p of app.wiki.live()) {
    const parts = String(p.folder ?? "").split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function newPageDialog(app, { title = "", folder = null, type = null, template = null } = {}) {
  return new Promise((resolve) => {
    let made = null;
    app.ui.modal("New page", (body, close) => {
      const settings = app.settings?.all?.() ?? {};
      const input = el("input", { class: "layr-input", value: title, spellcheck: "false",
        placeholder: "The page's title", "aria-label": "Title" });
      const problem = el("div", { class: "newpage-problem" });
      const start = folder ?? safe(() => app.defaultFolder?.(), "") ?? "";
      const folderSel = el("select", { class: "layr-select", "aria-label": "Folder" },
        el("option", { value: "" }, "Top (no folder)"),
        ...[...new Set([...folderList(app), ...(start ? [start] : [])])].sort()
          .map((f) => el("option", { value: f, selected: keyOf(f) === keyOf(start) }, f.replaceAll("/", " › "))));
      const types = safe(() => app.wiki.types(), []) ?? [];
      const typeSel = el("select", { class: "layr-select", "aria-label": "Type" },
        el("option", { value: "" }, "No type"),
        ...types.map((t) => el("option", { value: t.name, selected: keyOf(t.name) === keyOf(type) }, t.name)));
      const templates = safe(() => app.wiki.templates?.(settings), []) ?? [];
      const templateSel = el("select", { class: "layr-select", "aria-label": "Template" },
        el("option", { value: "" }, "None"),
        ...templates.map((p) => el("option", { value: p.id,
          selected: template && (p.id === template || keyOf(p.title) === keyOf(template)) }, p.title)));
      const hint = el("p", { class: "layr-muted newpage-hint" });
      let clash = null;
      const check = () => {
        const t = input.value.trim();
        clash = t ? app.wiki.resolve(t) : null;
        problem.replaceChildren();
        if (!t) return;
        const p = titleProblem(t);
        if (p) problem.append(el("span", { class: "layr-error" }, p));
        else if (clash) {
          problem.append(el("span", { class: "layr-muted" }, `“${clash.title}” exists already. `),
            el("a", { href: "#", onclick: (e) => {
              e.preventDefault();
              close();
              app.openPage(clash.id);
            } }, "Open it"));
        }
      };
      const explain = () => {
        const t = typeSel.value ? safe(() => app.wiki.type(typeSel.value)) : null;
        hint.textContent = templateSel.value
          ? `Starts with the template's text${t ? `, and the ${t.name} fields` : ""}.`
          : t?.template?.trim() ? `Starts with the ${t.name} template and its fields.`
            : t ? `Starts with the ${t.name} fields.` : "Starts empty.";
      };
      input.addEventListener("input", check);
      typeSel.addEventListener("change", explain);
      templateSel.addEventListener("change", explain);
      check();
      explain();
      const field = (label, control) => el("label", { class: "newpage-field" }, el("span", { class: "layr-label" }, label),
        control);
      body.classList.add("newpage");
      fill(body, field("Title", input), problem,
        el("div", { class: "newpage-row" }, field("Folder", folderSel), field("Type", typeSel)),
        templates.length ? field("Template", templateSel) : null, hint);
      setTimeout(() => input.select(), 0);
      return {
        ok: "Create",
        focus: input,
        run: async () => {
          const t = input.value.trim();
          const p = t ? titleProblem(t) : "Give the page a title";
          if (p) throw new Error(p);
          if (clash) {
            close();
            await app.openPage(clash.id);
            return;
          }
          made = await app.wiki.create({ title: t, folder: folderSel.value, type: typeSel.value || null,
            template: templateSel.value || null }, { by: "you" });
          close();
          await app.openPage(made.id, { mode: "edit" });
        },
      };
    }, { onClose: () => resolve(made) });
  });
}
