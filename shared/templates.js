// Templates and daily notes. A template is a page in the templates folder (setting `templatesFolder`); a new page made
// from it gets its text with `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}` filled in,
// the way Obsidian's core Templates plugin does. Dates are written with moment-style formats (the subset below, text
// in [brackets] kept as it is), in this device's time zone. Daily notes: one page a day titled by `dailyFormat`
// (slashes in it make subfolders, "YYYY/MM/YYYY-MM-DD"), in `dailyFolder`, from the `dailyTemplate` page. Pure.
import { cleanFolder, joinPath } from "./folders.js";
import { normalizeSettings } from "./settings.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm|ss/g;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/** A date (Date, ms or "YYYY-MM-DD") → a Date; "YYYY-MM-DD" means that day here, not at midnight UTC. */
export function toDate(date) {
  if (date instanceof Date) return date;
  if (typeof date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (date === undefined || date === null) return new Date();
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${date}`);
  return d;
}

/** `date` written as `format`: YYYY YY MMMM MMM MM M dddd ddd DD D HH H mm ss; "[text]" stays text. */
export function formatDate(date, format = "YYYY-MM-DD") {
  const d = toDate(date);
  const values = {
    YYYY: () => pad(d.getFullYear(), 4),
    YY: () => pad(d.getFullYear() % 100),
    MMMM: () => MONTHS[d.getMonth()],
    MMM: () => MONTHS[d.getMonth()].slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    dddd: () => DAYS[d.getDay()],
    ddd: () => DAYS[d.getDay()].slice(0, 3),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
  };
  return String(format ?? "").replace(TOKENS, (token, literal) => (literal !== undefined ? literal : values[token]()));
}

/** `markdown` with the template's placeholders filled in (unknown ones are left as they are). */
export function fillTemplate(markdown, { title = "", date = new Date(), settings = null } = {}) {
  const s = normalizeSettings(settings);
  const d = toDate(date);
  return String(markdown ?? "").replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_, what, format) => {
    const kind = what.toLowerCase();
    if (kind === "title") return String(title ?? "");
    const f = format?.trim() || (kind === "date" ? s.dateFormat : s.timeFormat);
    return formatDate(d, f);
  });
}

/** Where `date`'s daily note is: `{folder, title}` (a "/" in the daily format makes subfolders of the daily folder). */
export function dailyPath(date, settings = null) {
  const s = normalizeSettings(settings);
  const path = cleanFolder(formatDate(date, s.dailyFormat || "YYYY-MM-DD"));
  const at = path.lastIndexOf("/");
  const title = at < 0 ? path : path.slice(at + 1);
  const folder = joinPath(s.dailyFolder, at < 0 ? "" : path.slice(0, at));
  return { folder, title: title || formatDate(date, "YYYY-MM-DD") };
}

/** The title of `date`'s daily note. */
export const dailyTitle = (date, settings = null) => dailyPath(date, settings).title;
