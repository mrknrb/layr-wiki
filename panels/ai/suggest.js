// Suggest links and tags (the page's ⋯ menu): the existing pages this page names without linking them (plain text,
// no AI), plus, when Claude is there and the user asks, related pages and tags the AI suggests. Checkboxes; Apply
// makes them links, a "See also" list and tags in one save.
import { el, icon } from "../app/dom.js";
import { SUGGEST_SYSTEM, applySuggestions, mentionedPages, readSuggestions, suggestPrompt } from "./prompts.js";

function check(label, sub, checked = true) {
  const box = el("input", { type: "checkbox", checked: checked ? true : null });
  return { box, row: el("label", { class: "ai-suggest-row" }, box, el("span", { class: "ai-suggest-label" }, label,
    sub ? el("span", { class: "layr-muted" }, sub) : null)) };
}

export function openSuggest(app, page) {
  const mentioned = mentionedPages(app.wiki, page);
  const picks = { mentioned: [], related: [], tags: [] };
  app.ui.modal(`Suggest links and tags · ${page.title}`, (body, closeModal) => {
    body.classList.add("ai-suggest");
    const mentionList = el("div", { class: "ai-suggest-list" });
    if (mentioned.length) {
      for (const m of mentioned) {
        const c = check(m.page.title, m.name !== m.page.title ? `written as “${m.name}”` : "named in the text");
        picks.mentioned.push({ ...c, value: { title: m.page.title, name: m.name } });
        mentionList.append(c.row);
      }
    } else mentionList.append(el("p", { class: "layr-muted" }, "No other page is named in this page without a link."));

    const aiBox = el("div", { class: "ai-suggest-ai" });
    const aiOn = app.ai.available() && app.settings?.get?.("aiSuggest") !== false;
    const drawAiStart = () => {
      if (!aiOn) {
        aiBox.replaceChildren(el("p", { class: "layr-muted" }, app.ai.available()
          ? "AI suggestions are off in the wiki's settings (AI)."
          : "With the Claude Code plugin, the AI can also suggest related pages and tags."));
        return;
      }
      aiBox.replaceChildren(el("button", { class: "layr-button", onclick: askAi }, icon("sparkles"),
        "Suggest related pages and tags with AI"),
      el("p", { class: "layr-muted ai-small" }, "Sends this page and the list of page titles to Claude."));
    };
    const askAi = async () => {
      aiBox.replaceChildren(el("div", { class: "ai-pop-busy" }, el("span", { class: "layr-spinner" }), "Asking the AI…"));
      try {
        const titles = app.wiki.live().map((p) => p.title).sort((a, b) => a.localeCompare(b));
        const tags = [...new Set(app.wiki.live().flatMap((p) => p.tags ?? []))].sort();
        const answer = await app.ai.ask(suggestPrompt(page, titles, tags), { system: SUGGEST_SYSTEM });
        const { links, tags: newTags } = readSuggestions(app.wiki, page, answer);
        const skip = new Set(mentioned.map((m) => m.page.id));
        const rel = links.filter((l) => !skip.has(l.page.id));
        const list = el("div", { class: "ai-suggest-list" });
        if (rel.length) list.append(el("h4", {}, "Related pages (added under “See also”)"));
        for (const l of rel) {
          const c = check(l.page.title, l.why || null);
          picks.related.push({ ...c, value: l.page.title });
          list.append(c.row);
        }
        if (newTags.length) {
          list.append(el("h4", {}, "Tags"));
          const chips = el("div", { class: "ai-suggest-tags" });
          for (const t of newTags) {
            const c = check(`#${t}`, null);
            picks.tags.push({ ...c, value: t });
            chips.append(c.row);
          }
          list.append(chips);
        }
        if (!rel.length && !newTags.length) list.append(el("p", { class: "layr-muted" }, "The AI had nothing to add."));
        aiBox.replaceChildren(list);
      } catch (error) {
        aiBox.replaceChildren(el("p", { class: "layr-error" }, error.message),
          el("button", { class: "layr-button", onclick: askAi }, "Try again"));
      }
    };
    drawAiStart();

    const apply = async () => {
      const chosen = (list) => list.filter((x) => x.box.checked).map((x) => x.value);
      const sel = { mentioned: chosen(picks.mentioned), related: chosen(picks.related), tags: chosen(picks.tags) };
      if (!sel.mentioned.length && !sel.related.length && !sel.tags.length) return closeModal();
      const fresh = app.wiki.pages?.get(page.id) ?? page;
      try {
        await app.wiki.save(page.id, applySuggestions(fresh.markdown, sel));
        const n = sel.mentioned.length + sel.related.length;
        app.ui.notify(`Added ${n} link${n === 1 ? "" : "s"}${sel.tags.length ? ` and ${sel.tags.length} tag(s)` : ""}`, "success");
        closeModal();
        app.refresh?.();
      } catch (error) {
        app.ui.fail(error);
      }
    };
    body.append(
      el("h4", {}, "Pages named here without a link"), mentionList,
      el("h4", {}, "From the AI"), aiBox,
      el("div", { class: "ai-modal-buttons" },
        el("button", { class: "layr-button ghost", onclick: closeModal }, "Cancel"),
        el("button", { class: "layr-button primary", onclick: apply }, icon("check"), "Apply")));
  });
}

export function installSuggest(app) {
  app.pageMenu?.register((page) => [{ label: "Suggest links and tags…", icon: "auto_awesome", run: () => openSuggest(app, page) }]);
  app.commands?.register({ id: "suggest", title: "Suggest links and tags for this page", icon: "link",
    when: () => Boolean(app.page?.()), run: () => app.page?.() && openSuggest(app, app.page()) });
}
