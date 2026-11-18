// The graph view (route `graph` {id?}) and the local graph in the right sidebar: pages as dots, links as lines, drawn
// on a canvas with our own force layout (force.js). Zoom with the wheel or a pinch, pan by dragging the background,
// drag dots, click one to open it (Ctrl: a new tab), hover to light up its neighbours.
import { buildGraph, Simulation } from "./force.js";
import { allFolders, allTags, button, el, hashColor, icon, typeColor, typesInUse } from "./common.js";

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A canvas that lays out and draws a graph and lets people move around it. */
export class GraphCanvas {
  constructor(host, { onOpen = null, compact = false } = {}) {
    this.host = host;
    this.onOpen = onOpen;
    this.compact = compact;
    this.canvas = el("canvas", { class: "vw-graph-canvas", role: "img", "aria-label": "Graph of pages and their links" });
    this.tip = el("div", { class: "vw-graph-tip", hidden: true });
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext("2d");
    this.nodes = [];
    this.edges = [];
    this.neighbours = [];
    this.view = { k: 1, x: 0, y: 0 }; // screen = world * k + (x, y) + centre
    this.hover = -1;
    this.focus = -1;
    this.matches = null;
    this.touched = false; // the user moved the view: don't fit it again by itself
    this.pointers = new Map();
    this.frame = 0;
    this.dirty = true;
    this.sim = null;
    this.resize = new ResizeObserver(() => this.fitCanvas());
    this.resize.observe(host);
    this.fitCanvas();
    this.bind();
  }

  /** Show `nodes`/`edges` (buildGraph's); dots that were there keep their place. `colorOf(node)`. */
  setData({ nodes, edges }, { colorOf = () => null, focus = null } = {}) {
    const old = new Map(this.nodes.map((n) => [n.id, n]));
    const fresh = !this.nodes.length;
    this.nodes = nodes.map((n) => {
      const was = old.get(n.id);
      return { ...n, x: was?.x, y: was?.y, vx: was?.vx ?? 0, vy: was?.vy ?? 0, color: colorOf(n),
        r: (this.compact ? 3.5 : 3) + Math.sqrt(n.degree) * (this.compact ? 1.6 : 1.4) };
    });
    this.edges = edges;
    this.neighbours = this.nodes.map(() => []);
    for (const [a, b] of edges) {
      this.neighbours[a].push(b);
      this.neighbours[b].push(a);
    }
    this.focus = focus ? this.nodes.findIndex((n) => n.id === focus) : -1;
    if (this.focus >= 0) {
      const f = this.nodes[this.focus];
      if (!Number.isFinite(f.x)) [f.x, f.y] = [0, 0];
    }
    const n = this.nodes.length;
    this.sim = new Simulation(this.nodes, edges, {
      charge: this.compact ? -90 : n > 1000 ? -45 : n > 200 ? -70 : -110,
      linkDistance: this.compact ? 45 : n > 1000 ? 28 : n > 200 ? 38 : 50,
      gravity: this.compact ? 0.08 : n > 500 ? 0.06 : 0.07,
    });
    if (!fresh && nodes.every((x) => old.has(x.id))) this.sim.alpha = 0.25;
    // Settle most of the way before the first frame, so a big graph doesn't start as an explosion.
    if (fresh) this.sim.run(Math.min(120, Math.round(40000 / Math.max(n, 1))));
    this.hover = -1;
    if (!this.touched) this.fitted = false;
    if (fresh || !this.touched) this.fit(false);
    this.kick();
  }

  /** Light up the dots whose title holds `words` (null: none). Gives how many. */
  highlight(words) {
    const q = String(words ?? "").trim().toLowerCase();
    this.matches = q ? new Set(this.nodes.map((n, i) => (n.title.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0)) : null;
    this.kick();
    return this.matches?.size ?? 0;
  }

  /** Centre the view on a dot. */
  centerOn(id) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) return;
    this.view.x = -n.x * this.view.k;
    this.view.y = -n.y * this.view.k;
    this.touched = true;
    this.kick();
  }

  fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.kick();
  }

  /** Zoom and pan so every dot shows. */
  fit(animate = true) {
    if (!this.nodes.length || !this.w) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    const pad = Math.min(this.compact ? 36 : 60, this.w * 0.08); // room for the labels at the edges
    const k = Math.min(4, Math.max(0.05, Math.min((this.w - pad * 2) / (x1 - x0 || 1), (this.h - pad * 2) / (y1 - y0 || 1))));
    const target = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
    if (!animate) {
      this.view = target;
      return this.kick();
    }
    const from = { ...this.view };
    const t0 = performance.now();
    const step = (t) => {
      const a = Math.min(1, (t - t0) / 300);
      const e = a * (2 - a);
      this.view = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      this.kick();
      if (a < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  zoomBy(f, cx = this.w / 2, cy = this.h / 2) {
    const k = Math.min(8, Math.max(0.03, this.view.k * f));
    const ox = cx - this.w / 2;
    const oy = cy - this.h / 2;
    this.view.x = ox - ((ox - this.view.x) * k) / this.view.k;
    this.view.y = oy - ((oy - this.view.y) * k) / this.view.k;
    this.view.k = k;
    this.touched = true;
    this.kick();
  }

  toWorld(sx, sy) {
    return { x: (sx - this.w / 2 - this.view.x) / this.view.k, y: (sy - this.h / 2 - this.view.y) / this.view.k };
  }

  /** The dot under a point on the screen, or -1. */
  hit(sx, sy) {
    const p = this.toWorld(sx, sy);
    let best = -1;
    let bestD = Infinity;
    const slack = (this.compact ? 8 : 6) / this.view.k;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < n.r + slack && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  kick() {
    this.dirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.loop());
  }

  loop() {
    this.frame = 0;
    if (!this.canvas.isConnected) return;
    const running = this.sim?.active;
    if (running) {
      const ticks = this.nodes.length > 1200 ? 1 : 2;
      for (let i = 0; i < ticks; i++) this.sim.tick();
      if (!this.touched && this.sim.alpha < 0.05 && !this.fitted) {
        this.fitted = true;
        this.fit(true);
      }
    }
    if (running || this.dirty) {
      this.dirty = false;
      this.draw();
    }
    if (this.sim?.active) this.frame = requestAnimationFrame(() => this.loop());
  }

  draw() {
    const { ctx, nodes, edges, view, dpr } = this;
    if (!this.w) return;
    const fg = css("--fg", "#ddd");
    const dim = css("--fg-dim", "#999");
    const line = css("--border", "#444");
    const accent = css("--accent", "#7c9cff");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.translate(this.w / 2 + view.x, this.h / 2 + view.y);
    ctx.scale(view.k, view.k);
    const active = this.hover >= 0 ? this.hover : -1;
    const near = active >= 0 ? new Set([active, ...this.neighbours[active]]) : null;
    const lit = (i) => (near ? near.has(i) : this.matches ? this.matches.has(i) : true);

    // Lines: all at once, then the lit ones on top.
    ctx.lineWidth = Math.max(0.6, 1 / view.k);
    ctx.strokeStyle = line;
    ctx.globalAlpha = near || this.matches ? 0.35 : 0.9;
    ctx.beginPath();
    for (const [a, b] of edges) {
      ctx.moveTo(nodes[a].x, nodes[a].y);
      ctx.lineTo(nodes[b].x, nodes[b].y);
    }
    ctx.stroke();
    if (near) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(1.2, 1.6 / view.k);
      ctx.beginPath();
      for (const j of this.neighbours[active]) {
        ctx.moveTo(nodes[active].x, nodes[active].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
      }
      ctx.stroke();
    }

    // Dots.
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      ctx.globalAlpha = lit(i) ? 1 : 0.18;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (n.ghost) {
        ctx.strokeStyle = dim;
        ctx.lineWidth = Math.max(0.8, 1 / view.k);
        ctx.setLineDash([2 / view.k, 2 / view.k]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = i === active ? accent : n.color || dim;
        ctx.fill();
      }
      if (i === this.focus || (this.matches?.has(i) && !near)) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels: when zoomed in enough, and always for the hovered dot, its neighbours, matches and the focus.
    const size = (this.compact ? 11 : 12) / view.k;
    ctx.font = `${size}px ${css("--font", "system-ui")}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tl = this.toWorld(0, 0);
    const br = this.toWorld(this.w, this.h);
    // All labels when zoomed in, or for a small graph that isn't squeezed (else they pile up into a smudge).
    const showAll = view.k * (this.compact ? 1.2 : 1) > 1.1 || (nodes.length <= (this.compact ? 30 : 60) && view.k > 0.8);
    let drawn = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.x < tl.x - 50 || n.x > br.x + 50 || n.y < tl.y - 20 || n.y > br.y + 20) continue;
      const must = i === active || i === this.focus || near?.has(i) || this.matches?.has(i);
      const big = n.r * view.k > 9;
      if (!must && !(showAll && lit(i)) && !(big && lit(i))) continue;
      if (!must && drawn > 600) continue;
      drawn++;
      ctx.globalAlpha = must || !near ? 1 : 0.4;
      ctx.fillStyle = i === active ? fg : dim;
      const text = n.title.length > 40 ? `${n.title.slice(0, 38)}…` : n.title;
      ctx.fillText(text, n.x, n.y + n.r + 2 / view.k);
    }
    ctx.globalAlpha = 1;
  }

  bind() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let drag = null; // {kind: "node"|"pan", i, start, moved}
    let pinch = null;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        if (drag?.kind === "node") this.release(drag.i);
        drag = null;
        return;
      }
      const i = this.hit(p.x, p.y);
      drag = { kind: i >= 0 ? "node" : "pan", i, start: p, last: p, moved: false, ctrl: e.ctrlKey || e.metaKey };
      if (i >= 0) {
        this.hover = i;
        this.kick();
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = pos(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.view.x += mid.x - pinch.mid.x;
        this.view.y += mid.y - pinch.mid.y;
        this.zoomBy(d / (pinch.d || d), mid.x, mid.y);
        pinch = { d, mid };
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 4) return;
        drag.moved = true;
        this.tip.hidden = true;
        if (drag.kind === "pan") {
          this.view.x += p.x - drag.last.x;
          this.view.y += p.y - drag.last.y;
          this.touched = true;
          this.kick();
        } else {
          const w = this.toWorld(p.x, p.y);
          const n = this.nodes[drag.i];
          n.fx = w.x;
          n.fy = w.y;
          this.sim.alphaTarget = 0.25;
          this.sim.reheat(0.25);
          this.kick();
        }
        drag.last = p;
        return;
      }
      if (e.pointerType === "touch") return;
      const i = this.hit(p.x, p.y);
      if (i !== this.hover) {
        this.hover = i;
        c.style.cursor = i >= 0 ? "pointer" : "grab";
        this.showTip(i, p);
        this.kick();
      } else if (i >= 0) this.showTip(i, p);
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (pinch) {
        if (this.pointers.size < 2) pinch = null;
        return;
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === "node") this.release(d.i);
      if (!d.moved && d.i >= 0 && e.type === "pointerup") this.onOpen?.(this.nodes[d.i], e);
      if (e.pointerType === "touch") {
        this.hover = -1;
        this.kick();
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => {
      if (drag) return;
      this.hover = -1;
      this.tip.hidden = true;
      this.kick();
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = pos(e);
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    }, { passive: false });
    c.addEventListener("dblclick", (e) => {
      const p = pos(e);
      if (this.hit(p.x, p.y) < 0) this.fit();
    });
    c.style.touchAction = "none";
    c.style.cursor = "grab";
  }

  release(i) {
    const n = this.nodes[i];
    if (!n) return;
    n.fx = n.fy = undefined;
    this.sim.alphaTarget = 0;
  }

  showTip(i, p) {
    if (i < 0 || this.compact) {
      this.tip.hidden = true;
      return;
    }
    const n = this.nodes[i];
    this.tip.textContent = `${n.title}${n.ghost ? " (no page yet)" : ""} · ${n.degree} link${n.degree === 1 ? "" : "s"}`;
    this.tip.hidden = false;
    this.tip.style.left = `${Math.min(p.x + 14, this.w - 200)}px`;
    this.tip.style.top = `${p.y + 14}px`;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.remove();
    this.tip.remove();
  }
}

/** A dot's colour: by its type's colour (or the folder's), grey for none. */
function colorer(app, by) {
  return (n) => {
    if (n.ghost) return null;
    if (by === "folder") return n.folder ? hashColor(n.folder.split("/")[0].toLowerCase()) : null;
    return n.type ? typeColor(app.wiki, n.type) : null;
  };
}

const STORE = "wiki.graph";
const loadOpts = () => {
  try {
    return { orphans: true, missing: false, colorBy: "type", depth: 2, ...JSON.parse(localStorage.getItem(STORE) ?? "{}") };
  } catch {
    return { orphans: true, missing: false, colorBy: "type", depth: 2 };
  }
};

/** The whole-wiki graph view; `route.id`: start around that page. */
export function renderGraph(root, route, app) {
  const opts = { ...loadOpts(), folder: null, type: null, tag: null, search: "" };
  let scope = route.id && app.wiki.pages.get(route.id) ? "local" : "all";
  root.classList.add("vw-graph-root");
  const stage = el("div", { class: "vw-graph-stage" });
  const graph = new GraphCanvas(stage, { onOpen: (n, e) => open(n, e) });
  const legend = el("div", { class: "vw-graph-legend" });
  const stats = el("span", { class: "layr-muted vw-graph-stats" });
  const open = (n, e) => {
    if (n.ghost) app.openPage(n.title, { newTab: e.ctrlKey || e.metaKey });
    else app.openPage(n.id, { newTab: e.ctrlKey || e.metaKey || e.button === 1 });
  };
  const persist = () => localStorage.setItem(STORE, JSON.stringify({ orphans: opts.orphans, missing: opts.missing,
    colorBy: opts.colorBy, depth: opts.depth }));

  const rebuild = () => {
    const center = scope === "local" ? route.id : null;
    const data = buildGraph(app.wiki, { ...opts, center, depth: opts.depth });
    graph.setData(data, { colorOf: colorer(app, opts.colorBy), focus: center });
    if (opts.search) graph.highlight(opts.search);
    stats.textContent = `${data.nodes.length} pages · ${data.edges.length} links`;
    drawLegend(data);
  };
  const drawLegend = (data) => {
    const counts = new Map();
    for (const n of data.nodes) {
      if (n.ghost) continue;
      const k = opts.colorBy === "folder" ? n.folder.split("/")[0] : n.type ?? "";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const items = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
    legend.replaceChildren(...items.map(([k]) => el("span", { class: "vw-legend-item" },
      el("i", { style: { background: k ? (opts.colorBy === "folder" ? hashColor(k.toLowerCase()) : typeColor(app.wiki, k)) : "var(--fg-dim)" } }),
      k || (opts.colorBy === "folder" ? "Top folder" : "No type"))));
  };

  const select = (label, value, options, set) => el("label", { class: "vw-field" }, el("span", {}, label),
    el("select", { class: "layr-select", onchange: (e) => set(e.target.value || null) },
      el("option", { value: "" }, "All"), options.map((o) => el("option", { value: o, selected: o === value }, o))));
  const check = (label, key) => el("label", { class: "vw-check-row" }, el("input", { type: "checkbox", checked: opts[key],
    onchange: (e) => { opts[key] = e.target.checked; persist(); rebuild(); } }), el("span", {}, label));
  const searchBox = el("input", { class: "layr-input", type: "search", placeholder: "Highlight pages…",
    oninput: (e) => {
      opts.search = e.target.value;
      const n = graph.highlight(opts.search);
      stats.textContent = opts.search ? `${n} found` : `${graph.nodes.length} pages · ${graph.edges.length} links`;
    },
    onkeydown: (e) => {
      if (e.key !== "Enter") return;
      const first = graph.matches && [...graph.matches][0];
      if (first !== undefined) graph.centerOn(graph.nodes[first].id);
    } });
  const page = route.id ? app.wiki.pages.get(route.id) : null;
  const controls = el("div", { class: "vw-graph-controls" },
    el("div", { class: "vw-graph-row" }, searchBox, button("sliders-horizontal", "", () => {
      controls.classList.toggle("open");
      sessionStorage.setItem("wiki.graph.filters", controls.classList.contains("open") ? "1" : "");
    }, { title: "Filters", cls: "vw-graph-more" })),
    page ? el("div", { class: "vw-seg small" },
      el("button", { type: "button", class: scope === "all" ? "active" : "", onclick: (e) => { scope = "all"; setSeg(e); rebuild(); } }, "Whole wiki"),
      el("button", { type: "button", class: scope === "local" ? "active" : "", onclick: (e) => { scope = "local"; setSeg(e); rebuild(); } },
        `Around ${page.title.length > 18 ? `${page.title.slice(0, 16)}…` : page.title}`)) : null,
    el("div", { class: "vw-graph-filters" },
      page ? el("label", { class: "vw-field" }, el("span", {}, "Links away (around the page)"),
        el("select", { class: "layr-select", onchange: (e) => { opts.depth = Number(e.target.value); persist(); rebuild(); } },
          [1, 2, 3].map((d) => el("option", { value: String(d), selected: d === opts.depth }, String(d))))) : null,
      select("Folder", opts.folder, allFolders(app.wiki), (v) => { opts.folder = v; rebuild(); }),
      select("Type", opts.type, typesInUse(app.wiki).map((t) => t.name), (v) => { opts.type = v; rebuild(); }),
      select("Tag", opts.tag, allTags(app.wiki), (v) => { opts.tag = v; rebuild(); }),
      check("Pages without links", "orphans"),
      check("Pages that don't exist yet", "missing"),
      el("label", { class: "vw-field" }, el("span", {}, "Colour by"),
        el("select", { class: "layr-select", onchange: (e) => { opts.colorBy = e.target.value; persist(); rebuild(); } },
          el("option", { value: "type", selected: opts.colorBy === "type" }, "Type"),
          el("option", { value: "folder", selected: opts.colorBy === "folder" }, "Folder")))),
    stats);
  if (sessionStorage.getItem("wiki.graph.filters")) controls.classList.add("open");
  const setSeg = (e) => {
    for (const b of e.currentTarget.parentElement.children) b.classList.toggle("active", b === e.currentTarget);
  };
  const zoom = el("div", { class: "vw-graph-zoom" },
    button("plus", "", () => graph.zoomBy(1.3), { title: "Zoom in" }),
    button("minus", "", () => graph.zoomBy(1 / 1.3), { title: "Zoom out" }),
    button("maximize", "", () => graph.fit(), { title: "Show everything" }));
  stage.append(controls, zoom, legend);
  root.append(stage);
  requestAnimationFrame(() => {
    graph.fitCanvas();
    rebuild();
  });
  let timer = null;
  const off = app.on("changed", () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 300);
  });
  return () => {
    clearTimeout(timer);
    off();
    graph.destroy();
  };
}

/** The right sidebar's local graph: the open page and the pages 1 or 2 links away. */
export function localGraphPanel(app) {
  let graph = null;
  let depth = Number(localStorage.getItem("wiki.localGraphDepth")) || 1;
  let shownId = null;
  let body = null;
  const draw = (root) => {
    const page = app.page();
    shownId = page?.id ?? null;
    if (!page) {
      graph?.destroy();
      graph = null;
      body.replaceChildren(el("p", { class: "layr-muted vw-side-note" }, "Open a page to see its neighbourhood."));
      return;
    }
    if (!graph || !body.contains(graph.canvas)) {
      body.replaceChildren();
      graph = new GraphCanvas(body, { compact: true, onOpen: (n, e) => (n.ghost ? app.openPage(n.title)
        : app.openPage(n.id, { newTab: e.ctrlKey || e.metaKey })) });
    }
    const data = buildGraph(app.wiki, { center: page.id, depth, missing: true });
    graph.setData(data, { colorOf: colorer(app, "type"), focus: page.id });
    root.querySelector(".vw-local-count").textContent = `${data.nodes.length - 1} linked`;
  };
  return {
    id: "local-graph",
    title: "Local graph",
    icon: "graph",
    order: 50,
    render(root) {
      root.classList.add("vw-local");
      const depthSel = el("select", { class: "layr-select vw-local-depth", title: "How many links away",
        onchange: (e) => {
          depth = Number(e.target.value);
          localStorage.setItem("wiki.localGraphDepth", String(depth));
          draw(root);
        } }, [1, 2].map((d) => el("option", { value: String(d), selected: d === depth }, `${d} link${d > 1 ? "s" : ""} away`)));
      body = el("div", { class: "vw-local-stage" });
      root.append(el("div", { class: "wiki-side-head" }, el("span", { class: "wiki-side-title" }, "Local graph"),
        el("span", { class: "wiki-bar-fill" }), el("span", { class: "layr-muted vw-local-count" }), depthSel,
        el("button", { class: "layr-button ghost icon small", title: "Open the graph view", "aria-label": "Open the graph view",
          onclick: () => app.open({ view: "graph", ...(shownId ? { id: shownId } : {}) }) }, icon("maximize-2"))), body);
      requestAnimationFrame(() => draw(root));
      return () => {
        graph?.destroy();
        graph = null;
      };
    },
    update(root, _app, why) {
      if (!body || !root.contains(body)) return;
      if (why === "route" && (app.page()?.id ?? null) === shownId) return;
      draw(root);
    },
  };
}
