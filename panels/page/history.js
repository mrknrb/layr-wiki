// A page's history: every version (when, who, lines added and removed), what changed from the version before or
// compared with now, the version as it reads, and Restore (which is itself a new version, so it can be undone).
import { diffLines, diffStats, foldDiff } from "../../shared/diff.js";
import { el, icon } from "../app/dom.js";
import { renderInto } from "./render.js";
import { whoText } from "./util.js";

/** Show the history of `page`; `before()` runs first (the page view saves what is being typed). */
export async function openHistory(app, page, { before = null, select = 0 } = {}) {
  await before?.();
  let revs = [];
  try {
    revs = await app.wiki.revisions(page.id);
  } catch (error) {
    app.ui.fail(error);
  }
  const now = () => app.wiki.pages.get(page.id) ?? page;
  app.ui.modal(`History of ${page.title}`, (body, close) => {
    body.classList.add("page-history");
    if (!revs.length) {
      body.append(el("p", { class: "layr-muted" }, "No history yet."));
      return { wide: true };
    }
    let at = Math.min(select, revs.length - 1);
    let mode = "changes"; // changes | now | text
    const list = el("ul", { class: "rev-list", role: "listbox", "aria-label": "Versions" });
    const view = el("div", { class: "rev-view" });
    const tabs = el("div", { class: "rev-tabs", role: "tablist" });
    const tab = (id, label) => el("button", { class: "rev-tab", role: "tab", "data-mode": id,
      onclick: () => ((mode = id), show()) }, label);
    tabs.append(tab("changes", "Changes"), tab("now", "Compared with now"), tab("text", "Text"));

    const show = () => {
      [...list.children].forEach((li, k) => {
        li.classList.toggle("active", k === at);
        li.setAttribute("aria-selected", String(k === at));
      });
      for (const b of tabs.children) b.classList.toggle("active", b.dataset.mode === mode);
      const rev = revs[at];
      const older = revs[at + 1];
      const current = rev.markdown === now().markdown;
      const head = el("div", { class: "rev-head" },
        el("div", { class: "rev-when-long" }, new Date(rev.at).toLocaleString(), " · ", whoText(rev),
          rev.note ? el("span", { class: "layr-muted" }, ` · ${rev.note}`) : null),
        el("span", { class: "rev-spacer" }),
        current ? el("span", { class: "layr-badge success" }, "Current version") : el("button", {
          class: "layr-button primary small",
          onclick: async () => {
            try {
              await app.wiki.restore(page.id, rev.key, { by: "you" });
              close();
              app.ui.notify("Version restored: the one before it is in the history too", "success");
            } catch (error) {
              app.ui.fail(error);
            }
          },
        }, icon("rotate-ccw"), " Restore this version"));
      let content;
      if (mode === "text") {
        content = el("div", { class: "rev-text" });
        renderInto(app, content, rev.markdown, { tasks: false, pdf: false });
      } else {
        const [from, to, what] = mode === "now"
          ? [rev.markdown, now().markdown, current ? "This is the current version." : "From this version to now:"]
          : [older?.markdown ?? "", rev.markdown, older ? "What this version changed:" : "The first version:"];
        const ops = foldDiff(diffLines(from, to));
        const changed = ops.some((o) => o.op === "add" || o.op === "del");
        content = el("div", {}, el("p", { class: "layr-muted rev-what" }, what),
          changed || mode !== "now" ? el("pre", { class: "diff" }, ...ops.map((o) => o.op === "skip"
            ? el("div", { class: "skip" }, `… ${o.count} unchanged lines …`)
            : el("div", { class: o.op }, el("span", { class: "sign" }, o.op === "add" ? "+" : o.op === "del" ? "−" : " "),
              o.text || " "))) : null);
      }
      view.replaceChildren(head, tabs, content);
    };
    revs.forEach((rev, i) => {
      const { add, del } = diffStats(diffLines(revs[i + 1]?.markdown ?? "", rev.markdown));
      list.append(el("li", { class: "rev-item", role: "option", tabindex: "0", onclick: () => ((at = i), show()),
        onkeydown: (e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            at = Math.max(0, Math.min(revs.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
            show();
            list.children[at]?.focus();
          }
        } },
      el("div", { class: "rev-when" }, app.ui.ago(rev.at),
        el("span", { class: `who${rev.by === "ai" ? " ai" : ""}` }, whoText(rev))),
      el("div", { class: "rev-stat" }, el("span", { class: "add" }, `+${add}`), " ", el("span", { class: "del" }, `−${del}`),
        rev.note ? el("span", { class: "layr-muted" }, ` · ${rev.note}`) : null)));
    });
    body.append(el("div", { class: "rev-wrap" }, list, view));
    show();
    return { wide: true };
  });
}
