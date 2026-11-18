// The table editor: a Markdown table shown as a table while the cursor is elsewhere. Tap or click a cell to edit its
// text (Enter: the cell below, Tab: the next cell, Esc: cancel); the bar above the table adds, removes and moves rows
// and columns and sets a column's alignment; "+" under and beside the table add a row or a column. Every change
// rewrites the table's Markdown (padded so the source lines up). Works with a mouse and with touch.
import { WidgetType } from "../../vendor/editor.js";
import { renderInline } from "../../shared/markdown.js";
import { parseTable, serializeTable, tableOps } from "./markdown-ops.js";
import { h, svg } from "./dom.js";

// The cell to edit once the table is drawn again after a change (the old widget's DOM is gone by then).
let pending = null;

export class TableWidget extends WidgetType {
  constructor(ctx, text) {
    super();
    this.ctx = ctx;
    this.text = text;
  }
  eq(o) {
    return o.text === this.text;
  }
  get estimatedHeight() {
    return 34 * (this.text.split("\n").length - 1) + 10;
  }
  ignoreEvent() {
    return true;
  }
  toDOM(view) {
    const ctx = this.ctx;
    let table = parseTable(this.text);
    const wrap = h("div", { class: "cm-table-widget" });
    if (!table) {
      wrap.textContent = this.text;
      return wrap;
    }
    const readOnly = () => view.state.readOnly;
    let active = null; // {row, col}
    let editor = null; // the textarea while a cell is edited
    const scroller = h("div", { class: "cm-table-scroll" });
    const bar = h("div", { class: "cm-table-bar", role: "toolbar", "aria-label": "Table" });
    const addRow = h("button", { class: "cm-table-add-row", type: "button", title: "Add a row", html: svg("plus") });
    const addCol = h("button", { class: "cm-table-add-col", type: "button", title: "Add a column", html: svg("plus") });
    wrap.append(bar, h("div", { class: "cm-table-main" }, scroller, addCol), addRow);

    /** Write the table back; `focus` = the cell to edit afterwards. */
    const commit = (next, focus = null) => {
      const pos = view.posAtDOM(wrap);
      if (view.state.sliceDoc(pos, pos + this.text.length) !== this.text) return;
      const text = serializeTable(next);
      pending = focus ? { ...focus, at: Date.now() } : null;
      if (text === this.text) {
        if (focus) select(focus.row, focus.col, true);
        return;
      }
      view.dispatch({ changes: { from: pos, to: pos + this.text.length, insert: text }, userEvent: "input.table" });
    };
    /** The model with the cell being edited applied (a bar button acts on what is typed so far). */
    const current = () => {
      if (!editor || !active) return table;
      return tableOps.setCell(table, active.row, active.col, editor.value.replace(/\n/g, " "));
    };
    const cellText = (row, col) => (row < 0 ? table.header[col] : table.rows[row][col]) ?? "";
    const rows = () => table.rows.length;
    const cols = () => table.header.length;

    function draw() {
      const el = h("table", {});
      const align = (c) => (table.align[c] ? `text-align:${table.align[c]}` : null);
      const cell = (tag, row, col) => {
        const td = h(tag, { style: align(col), "data-row": row, "data-col": col });
        // Links in cells are shown but don't take the click: a click edits the cell (Ctrl+click opens the link).
        td.innerHTML = renderInline(cellText(row, col), { resolve: ctx.resolve })
          .replace(/class="wl/g, 'class="cm-cell-link') || "&nbsp;";
        return td;
      };
      el.append(h("thead", {}, h("tr", {}, table.header.map((_c, i) => cell("th", -1, i)))));
      el.append(h("tbody", {}, table.rows.map((r, ri) => h("tr", {}, r.map((_c, ci) => cell("td", ri, ci))))));
      scroller.replaceChildren(el);
    }

    function select(row, col, edit) {
      if (editor) finishEdit(false);
      active = { row: Math.max(-1, Math.min(row, rows() - 1)), col: Math.max(0, Math.min(col, cols() - 1)) };
      wrap.classList.add("active");
      for (const td of scroller.querySelectorAll(".selected")) td.classList.remove("selected");
      const td = scroller.querySelector(`[data-row="${active.row}"][data-col="${active.col}"]`);
      td?.classList.add("selected");
      drawBar();
      if (edit && td && !readOnly()) startEdit(td);
    }

    function startEdit(td) {
      const { row, col } = active;
      editor = h("textarea", { class: "cm-table-input", rows: "1", spellcheck: ctx.setting("spellcheck") ? "true" : "false",
        "aria-label": row < 0 ? `Column ${col + 1} name` : `Row ${row + 1}, column ${col + 1}` });
      editor.value = cellText(row, col);
      const fit = () => {
        editor.style.height = "auto";
        editor.style.height = `${editor.scrollHeight}px`;
      };
      td.replaceChildren(editor);
      td.classList.add("editing");
      editor.addEventListener("input", fit);
      editor.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finishEdit(false);
          view.focus();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const next = tableOps.setCell(table, row, col, editor.value.replace(/\n/g, " "));
          if (row + 1 >= rows()) commit(tableOps.insertRow(next, rows()), { row: row + 1, col });
          else commit(next, { row: row + 1, col });
        } else if (e.key === "Tab") {
          e.preventDefault();
          const next = tableOps.setCell(table, row, col, editor.value.replace(/\n/g, " "));
          let r = row;
          let c = col + (e.shiftKey ? -1 : 1);
          if (c >= cols()) {
            c = 0;
            r++;
          } else if (c < 0) {
            c = cols() - 1;
            r--;
          }
          if (r < -1) return;
          if (r >= rows()) commit(tableOps.insertRow(next, rows()), { row: r, col: c });
          else commit(next, { row: r, col: c });
        }
        e.stopPropagation();
      });
      editor.addEventListener("blur", () => setTimeout(() => {
        if (editor && document.activeElement !== editor) finishEdit(true);
      }, 0));
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      requestAnimationFrame(fit);
    }

    function finishEdit(save) {
      const ed = editor;
      if (!ed) return;
      editor = null;
      const { row, col } = active;
      const value = ed.value.replace(/\n/g, " ");
      if (save && value !== cellText(row, col)) {
        commit(tableOps.setCell(table, row, col, value));
        return;
      }
      draw();
      scroller.querySelector(`[data-row="${row}"][data-col="${col}"]`)?.classList.add("selected");
    }

    const button = (icon, title, run, extra = "") => {
      const b = h("button", { type: "button", class: `cm-table-btn ${extra}`.trim(), title, "aria-label": title,
        html: svg(icon) });
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (!readOnly()) run();
      });
      return b;
    };
    const sep = () => h("span", { class: "cm-table-sep" });

    function drawBar() {
      if (!active || readOnly()) {
        bar.replaceChildren();
        return;
      }
      const { row, col } = active;
      const body = row >= 0;
      const a = table.align[col];
      bar.replaceChildren(
        h("span", { class: "cm-table-label" }, "Row"),
        button("between-vertical-start", "Insert a row above", () => commit(tableOps.insertRow(current(), body ? row : 0),
          { row: body ? row : 0, col })),
        button("rows-3", "Insert a row below", () => commit(tableOps.insertRow(current(), row + 1), { row: row + 1, col })),
        body ? button("arrow-up", "Move the row up", () => commit(tableOps.moveRow(current(), row, -1),
          { row: Math.max(0, row - 1), col })) : null,
        body ? button("arrow-down", "Move the row down", () => commit(tableOps.moveRow(current(), row, 1),
          { row: Math.min(rows() - 1, row + 1), col })) : null,
        body ? button("trash-2", "Delete the row", () => commit(tableOps.deleteRow(current(), row),
          rows() > 1 ? { row: Math.min(row, rows() - 2), col } : null), "danger") : null,
        sep(),
        h("span", { class: "cm-table-label" }, "Column"),
        button("between-horizontal-start", "Insert a column to the left", () => commit(tableOps.insertCol(current(), col),
          { row, col })),
        button("columns-3", "Insert a column to the right", () => commit(tableOps.insertCol(current(), col + 1),
          { row, col: col + 1 })),
        button("arrow-left", "Move the column left", () => commit(tableOps.moveCol(current(), col, -1),
          { row, col: Math.max(0, col - 1) })),
        button("arrow-right", "Move the column right", () => commit(tableOps.moveCol(current(), col, 1),
          { row, col: Math.min(cols() - 1, col + 1) })),
        cols() > 1 ? button("trash-2", "Delete the column", () => commit(tableOps.deleteCol(current(), col),
          { row, col: Math.min(col, cols() - 2) }), "danger") : null,
        sep(),
        button("align-left", "Align left", () => commit(tableOps.setAlign(current(), col, a === "left" ? null : "left"),
          { row, col }), a === "left" ? "on" : ""),
        button("align-center", "Align centre", () => commit(tableOps.setAlign(current(), col,
          a === "center" ? null : "center"), { row, col }), a === "center" ? "on" : ""),
        button("align-right", "Align right", () => commit(tableOps.setAlign(current(), col, a === "right" ? null : "right"),
          { row, col }), a === "right" ? "on" : ""),
        sep(),
        button("code", "Edit the table as Markdown", () => {
          const pos = view.posAtDOM(wrap);
          finishEdit(false);
          view.dispatch({ selection: { anchor: pos + 2 }, scrollIntoView: true, userEvent: "select" });
          view.focus();
        }),
        button("x", "Delete the table", () => {
          const pos = view.posAtDOM(wrap);
          if (view.state.sliceDoc(pos, pos + this.text.length) !== this.text) return;
          const end = Math.min(view.state.doc.length, pos + this.text.length + 1);
          view.dispatch({ changes: { from: pos, to: end, insert: "" }, userEvent: "delete.table" });
        }, "danger"),
      );
    }

    scroller.addEventListener("mousedown", (e) => {
      const td = e.target.closest?.("td, th");
      if (!td || td.classList.contains("editing")) return;
      const link = e.target.closest?.("a");
      if (link && (e.ctrlKey || e.metaKey || e.button === 1)) {
        e.preventDefault();
        if (link.dataset.page) ctx.openLink(link.dataset.page, null, true);
        else if (link.getAttribute("href") && link.getAttribute("href") !== "#") ctx.openUrl(link.getAttribute("href"));
        return;
      }
      e.preventDefault();
      select(Number(td.dataset.row), Number(td.dataset.col), true);
    });
    scroller.addEventListener("click", (e) => {
      if (e.target.closest?.("a")) e.preventDefault();
    });
    for (const b of [addRow, addCol]) {
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
    }
    addRow.addEventListener("click", () => !readOnly() && commit(tableOps.insertRow(current(), rows()),
      { row: rows(), col: active?.col ?? 0 }));
    addCol.addEventListener("click", () => !readOnly() && commit(tableOps.insertCol(current(), cols()),
      { row: active?.row ?? -1, col: cols() }));
    // Leaving the table (focus elsewhere, not on its bar) hides the bar.
    wrap.addEventListener("focusout", () => setTimeout(() => {
      if (!wrap.contains(document.activeElement) && !editor) {
        active = null;
        wrap.classList.remove("active");
        for (const td of scroller.querySelectorAll(".selected")) td.classList.remove("selected");
        drawBar();
      }
    }, 0));

    draw();
    if (pending && Date.now() - pending.at < 1500) {
      const p = pending;
      pending = null;
      requestAnimationFrame(() => wrap.isConnected && select(p.row, p.col, true));
    }
    return wrap;
  }
  destroy() {}
}
