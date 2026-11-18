// A force-directed layout for the graph view, small and dependency free (the same forces d3-force uses): nodes repel
// each other (Barnes–Hut: far groups of nodes act as one, so a tick is O(n log n) and 2000 pages stay smooth), links
// pull like springs, and a weak pull to the centre keeps unlinked pages near. Pure; tested in test/views.test.js.
//
// nodes: [{id, x?, y?, fx?, fy?}] (x, y, vx, vy are written into them; fx/fy pin a node, e.g. while it is dragged);
// edges: [[sourceIndex, targetIndex]].

const THETA2 = 0.81; // Barnes–Hut accuracy (θ = 0.9): a cell this small for its distance counts as one body

export class Simulation {
  constructor(nodes, edges, { charge = -60, linkDistance = 40, gravity = 0.04, velocityDecay = 0.4 } = {}) {
    this.nodes = nodes;
    this.edges = edges;
    this.charge = charge;
    this.linkDistance = linkDistance;
    this.gravity = gravity;
    this.velocityDecay = velocityDecay;
    this.alpha = 1;
    this.alphaMin = 0.002;
    this.alphaTarget = 0;
    this.alphaDecay = 1 - Math.pow(this.alphaMin, 1 / 300);
    const degree = new Float64Array(nodes.length);
    for (const [a, b] of edges) {
      degree[a]++;
      degree[b]++;
    }
    this.degree = degree;
    // A phyllotaxis spiral, so the first frames already look orderly and the result is the same every time.
    nodes.forEach((n, i) => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        const r = 10 * Math.sqrt(0.5 + i);
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        n.x = r * Math.cos(angle);
        n.y = r * Math.sin(angle);
      }
      n.vx = n.vx ?? 0;
      n.vy = n.vy ?? 0;
    });
  }

  /** Is it still moving? */
  get active() {
    return this.alpha > this.alphaMin || this.alphaTarget > 0;
  }

  /** Warm it up again (after a drag, or new nodes). */
  reheat(alpha = 0.3) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  run(ticks) {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  tick() {
    const { nodes } = this;
    if (!nodes.length) return;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;
    this.links(alpha);
    this.repel(alpha);
    const g = this.gravity * alpha;
    const keep = 1 - this.velocityDecay;
    for (const n of nodes) {
      n.vx -= n.x * g;
      n.vy -= n.y * g;
      if (n.fx !== undefined && n.fx !== null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = n.vy = 0;
        continue;
      }
      n.vx *= keep;
      n.vy *= keep;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  links(alpha) {
    const { nodes, degree } = this;
    for (const [a, b] of this.edges) {
      const s = nodes[a];
      const t = nodes[b];
      let dx = t.x + t.vx - s.x - s.vx || 1e-6;
      let dy = t.y + t.vy - s.y - s.vy || 1e-6;
      let l = Math.sqrt(dx * dx + dy * dy);
      const strength = 1 / Math.min(degree[a], degree[b]);
      l = ((l - this.linkDistance) / l) * alpha * strength;
      dx *= l;
      dy *= l;
      const bias = degree[a] / (degree[a] + degree[b]);
      t.vx -= dx * bias;
      t.vy -= dy * bias;
      s.vx += dx * (1 - bias);
      s.vy += dy * (1 - bias);
    }
  }

  /** Every node pushes every other away, through a quadtree of the positions (Barnes–Hut). */
  repel(alpha) {
    const { nodes } = this;
    const n = nodes.length;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of nodes) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
    // The tree in flat arrays: per cell its 4 children (-1 none), its body (a node index when it is a leaf with one
    // node, -1 for an inner cell, -2 empty), total strength and its centre of strength.
    const cap = n * 8 + 16;
    const child = new Int32Array(cap * 4).fill(-1);
    const body = new Int32Array(cap).fill(-2);
    const mass = new Float64Array(cap);
    const cx = new Float64Array(cap);
    const cy = new Float64Array(cap);
    const half = new Float64Array(cap);
    const ox = new Float64Array(cap);
    const oy = new Float64Array(cap);
    let cells = 1;
    half[0] = size / 2;
    ox[0] = x0 + size / 2;
    oy[0] = y0 + size / 2;
    const quadOf = (c, x, y) => (x >= ox[c] ? 1 : 0) + (y >= oy[c] ? 2 : 0);
    const childCell = (c, q) => {
      let k = child[c * 4 + q];
      if (k < 0) {
        if (cells >= cap) return -1;
        k = cells++;
        child[c * 4 + q] = k;
        const h = half[c] / 2;
        half[k] = h;
        ox[k] = ox[c] + (q & 1 ? h : -h);
        oy[k] = oy[c] + (q & 2 ? h : -h);
      }
      return k;
    };
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      let c = 0;
      for (let depth = 0; depth < 48; depth++) {
        if (body[c] === -2) {
          body[c] = i;
          break;
        }
        if (body[c] >= 0) {
          // A leaf: push its node one level down, then keep going (two nodes at the same place stay together).
          const j = body[c];
          const q = nodes[j];
          if (Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9) {
            p.x += (Math.random() - 0.5) * 1e-3;
            p.y += (Math.random() - 0.5) * 1e-3;
          }
          body[c] = -1;
          const k = childCell(c, quadOf(c, q.x, q.y));
          if (k < 0) break;
          body[k] = j;
        }
        const k = childCell(c, quadOf(c, p.x, p.y));
        if (k < 0) break;
        c = k;
      }
    }
    // Strength and its centre, children before parents (they were made after them).
    const strengthOf = (i) => this.charge * (1 + Math.sqrt(this.degree[i]) * 0.5);
    for (let c = cells - 1; c >= 0; c--) {
      if (body[c] >= 0) {
        const p = nodes[body[c]];
        const s = strengthOf(body[c]);
        mass[c] = s;
        cx[c] = p.x;
        cy[c] = p.y;
      } else if (body[c] === -1) {
        let m = 0;
        let sx = 0;
        let sy = 0;
        for (let q = 0; q < 4; q++) {
          const k = child[c * 4 + q];
          if (k < 0 || body[k] === -2) continue;
          const w = Math.abs(mass[k]);
          m += mass[k];
          sx += cx[k] * w;
          sy += cy[k] * w;
        }
        const w = Math.abs(m) || 1;
        mass[c] = m;
        cx[c] = sx / w;
        cy[c] = sy / w;
      }
    }
    const stack = new Int32Array(cells + 8);
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      let top = 0;
      stack[top++] = 0;
      while (top) {
        const c = stack[--top];
        if (body[c] === -2 || body[c] === i) continue;
        let dx = cx[c] - p.x;
        let dy = cy[c] - p.y;
        let l = dx * dx + dy * dy;
        const w2 = 4 * half[c] * half[c];
        if (body[c] >= 0 || w2 / THETA2 < l) {
          if (l === 0) {
            dx = (Math.random() - 0.5) * 1e-3;
            dy = (Math.random() - 0.5) * 1e-3;
            l = dx * dx + dy * dy;
          }
          if (l < 1) l = Math.sqrt(l); // closer than one unit: soften, so nothing shoots away
          const f = (mass[c] * alpha) / l;
          p.vx += dx * f;
          p.vy += dy * f;
          continue;
        }
        for (let q = 0; q < 4; q++) {
          const k = child[c * 4 + q];
          if (k >= 0) stack[top++] = k;
        }
      }
    }
  }
}

/**
 * The graph of a wiki (pages as nodes, links as undirected edges), narrowed: `folder` (with subfolders), `type`, `tag`,
 * `orphans` (false: pages without links left out), `missing` (true: links to pages that don't exist as ghost nodes),
 * `center` + `depth` (only pages that many links away from that page). Gives `{nodes: [{id, title, page, type,
 * folder, degree, ghost}], edges: [[i, j]]}`.
 */
export function buildGraph(wiki, { folder = null, type = null, tag = null, orphans = true, missing = false, center = null,
  depth = 1 } = {}) {
  const key = (s) => String(s ?? "").trim().toLowerCase();
  const inFolder = (p) => !folder || key(p.folder) === key(folder) || key(p.folder).startsWith(`${key(folder)}/`);
  const hasTag = (p) => !tag || p.tags.some((t) => key(t) === key(tag) || key(t).startsWith(`${key(tag)}/`));
  const keep = (p) => p.id === center || (inFolder(p) && (!type || key(p.type) === key(type)) && hasTag(p));
  const pages = wiki.live().filter(keep);
  const ids = new Set(pages.map((p) => p.id));
  const adj = new Map(pages.map((p) => [p.id, new Set()]));
  const ghosts = new Map(); // missing title key → {title, from: Set}
  for (const p of pages) {
    for (const t of p.links) {
      const target = wiki.resolve(t);
      if (target && ids.has(target.id) && target.id !== p.id) {
        adj.get(p.id).add(target.id);
        adj.get(target.id).add(p.id);
      } else if (!target && missing) {
        const k = `missing:${key(t)}`;
        if (!ghosts.has(k)) ghosts.set(k, { title: t, from: new Set() });
        ghosts.get(k).from.add(p.id);
      }
    }
  }
  for (const [k, g] of ghosts) {
    adj.set(k, new Set(g.from));
    for (const id of g.from) adj.get(id).add(k);
  }
  let chosen = [...adj.keys()];
  if (center && adj.has(center)) {
    const seen = new Set([center]);
    let frontier = [center];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) for (const n of adj.get(id)) if (!seen.has(n)) {
        seen.add(n);
        next.push(n);
      }
      frontier = next;
    }
    chosen = chosen.filter((id) => seen.has(id));
  }
  const set = new Set(chosen);
  if (!orphans) for (const id of chosen) if (id !== center && ![...adj.get(id)].some((n) => set.has(n))) set.delete(id);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const nodes = [...set].map((id) => {
    const p = byId.get(id);
    const g = p ? null : ghosts.get(id);
    return { id, title: p ? p.title : g.title, page: p ?? null, type: p?.type ?? null, folder: p?.folder ?? "",
      degree: 0, ghost: !p };
  });
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = [];
  for (const n of nodes) {
    for (const m of adj.get(n.id)) {
      const j = index.get(m);
      const i = index.get(n.id);
      if (j === undefined || j <= i) continue;
      edges.push([i, j]);
      nodes[i].degree++;
      nodes[j].degree++;
    }
  }
  return { nodes, edges };
}
