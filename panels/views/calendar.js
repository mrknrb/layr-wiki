// Daily notes and the calendar: a month in the left sidebar (days with a daily note marked, days pages were made or
// changed shown faintly; a click opens that day's note, made from the daily template when missing), and the same
// month large as the `calendar` route, with the pages of each day.
import { dayKey } from "../../shared/query.js";
import { monthDays, weekdayNames } from "./database.js";
import { button, el, fail, icon, pageLink } from "./common.js";

let templates = null;
const loadTemplates = () => (templates ??= import("../../shared/templates.js").catch(() => null));
loadTemplates();

/** The title of `date`'s daily note (the setting dailyFormat), or YYYY-MM-DD before the templates module loads. */
async function dailyTitle(app, date) {
  const t = await loadTemplates();
  return t?.dailyTitle ? t.dailyTitle(date, app.settings?.all?.()) : dayKey(date);
}

/** Open `date`'s daily note, making it when it is missing. */
export async function openDaily(app, date = new Date(), { newTab = false } = {}) {
  try {
    const settings = app.settings?.all?.() ?? null;
    let page = null;
    if (app.wiki.dailyNote) page = await app.wiki.dailyNote(date, settings);
    else {
      const title = await dailyTitle(app, date);
      page = app.wiki.resolve(title) ?? (await app.wiki.create({ title, folder: settings?.dailyFolder ?? "" }));
    }
    if (page?.proposal) return app.ui.notify?.("That daily note waits for your review");
    if (page) app.openPage(page.id, { newTab });
  } catch (error) {
    fail(app, error);
  }
}

/** Day "YYYY-MM-DD" → {daily: page, created: n, updated: n} for the days of a month grid. */
async function marks(app, days) {
  const out = new Map();
  for (const d of days) out.set(dayKey(d), { daily: null, created: [], updated: [] });
  const titles = await Promise.all(days.map((d) => dailyTitle(app, d)));
  days.forEach((d, i) => {
    const p = app.wiki.resolve(titles[i]);
    if (p) out.get(dayKey(d)).daily = p;
  });
  for (const p of app.wiki.live()) {
    const c = out.get(dayKey(p.created || 0));
    if (c && c.daily !== p) c.created.push(p);
    const u = out.get(dayKey(p.updated || 0));
    if (u && u.daily !== p && dayKey(p.updated) !== dayKey(p.created)) u.updated.push(p);
  }
  return out;
}

/** A month grid into `host`; `big` lists the pages of each day. Gives `{draw}`. */
function monthView(app, host, { big = false } = {}) {
  const now = new Date();
  let month = new Date(now.getFullYear(), now.getMonth(), 1);
  let token = 0;
  const draw = async () => {
    const my = ++token;
    const days = monthDays(month);
    const info = await marks(app, days);
    if (my !== token) return;
    const today = dayKey(Date.now());
    const grid = el("div", { class: "vw-mcal-grid" }, weekdayNames().map((d) => el("div", { class: "vw-mcal-dow" }, big ? d : d.slice(0, 2))));
    for (const d of days) {
      const key = dayKey(d);
      const m = info.get(key);
      const activity = m.created.length + m.updated.length;
      const cls = ["vw-mcal-day", d.getMonth() !== month.getMonth() ? "out" : "", key === today ? "today" : "",
        m.daily ? "has-note" : "", activity ? "active" : ""].filter(Boolean).join(" ");
      const title = `${d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}` +
        `${m.daily ? " · daily note" : ""}${m.created.length ? ` · ${m.created.length} new` : ""}` +
        `${m.updated.length ? ` · ${m.updated.length} changed` : ""}`;
      if (!big) {
        grid.append(el("button", { type: "button", class: cls, title, "aria-label": title,
          onclick: (e) => openDaily(app, d, { newTab: e.ctrlKey || e.metaKey }) },
        el("span", {}, String(d.getDate())), activity ? el("i", { class: "vw-mcal-dot", style: { opacity: String(Math.min(1, 0.35 + activity / 6)) } }) : null));
        continue;
      }
      grid.append(el("div", { class: cls },
        el("button", { type: "button", class: "vw-mcal-num", title: m.daily ? "Open the daily note" : "Make the daily note",
          onclick: (e) => openDaily(app, d, { newTab: e.ctrlKey || e.metaKey }) }, String(d.getDate()),
        m.daily ? icon("notebook-pen") : null),
        m.created.slice(0, 3).map((p) => el("div", { class: "vw-mcal-page new", title: `${p.title} (made this day)` }, pageLink(p))),
        m.updated.slice(0, Math.max(0, 3 - m.created.length)).map((p) => el("div", { class: "vw-mcal-page", title: `${p.title} (changed this day)` }, pageLink(p))),
        activity > 3 ? el("button", { type: "button", class: "vw-cal-more", onclick: (e) => app.ui.menu([...m.created, ...m.updated]
          .map((p) => ({ label: p.title, run: () => app.openPage(p.id) })), e) }, `+${activity - 3} more`) : null));
    }
    const go = (delta) => {
      month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
      draw();
    };
    host.replaceChildren(el("div", { class: "vw-mcal-head" },
      button("chevron-left", "", () => go(-1), { title: "Previous month" }),
      el("b", { class: "vw-mcal-title" }, month.toLocaleDateString(undefined, { month: big ? "long" : "short", year: "numeric" })),
      button("chevron-right", "", () => go(1), { title: "Next month" }),
      el("span", { class: "layr-spacer" }),
      button(null, "Today", () => {
        const n = new Date();
        month = new Date(n.getFullYear(), n.getMonth(), 1);
        draw();
      })), grid);
  };
  return { draw };
}

/** The left sidebar's calendar. */
export function calendarPanel(app) {
  let view = null;
  return {
    id: "calendar",
    title: "Calendar",
    icon: "calendar-days",
    order: 60,
    render(root) {
      const host = el("div", { class: "vw-mcal" });
      root.append(el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Calendar"),
        el("span", { class: "wiki-bar-fill" }),
        el("button", { class: "layr-button ghost icon small", title: "Open today's note", "aria-label": "Open today's note",
          onclick: () => openDaily(app) }, icon("calendar-check")),
        el("button", { class: "layr-button ghost icon small", title: "Open the calendar", "aria-label": "Open the calendar",
          onclick: () => app.open({ view: "calendar" }) }, icon("maximize-2"))), host,
      el("p", { class: "layr-muted vw-side-note" }, "Click a day for its daily note. Dots: pages made or changed that day."));
      view = monthView(app, host);
      view.draw();
      return () => (view = null);
    },
    update(_root, _app, why) {
      if (why === "changed") view?.draw();
    },
  };
}

/** The calendar route: the month large. */
export function renderCalendar(root, _route, app) {
  const host = el("div", { class: "vw-mcal big" });
  root.append(el("div", { class: "vw-page vw-calendar-page" },
    el("header", { class: "vw-head" }, el("h1", { class: "vw-title" }, icon("calendar-days"), "Calendar"),
      el("span", { class: "layr-spacer" }), button("calendar-check", "Today's note", () => openDaily(app), { cls: "primary" })), host));
  const view = monthView(app, host, { big: true });
  view.draw();
  return app.on("changed", () => view.draw());
}
