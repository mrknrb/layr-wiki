// Attachments (pictures, PDFs, data files) in the user's Supabase Storage, so every device sees them: the private
// bucket `lf-wiki` (supabase/migrations/lf_0004_wiki_files.sql), one object per content, `<user id>/<sha256>`, which
// only the user can read or write (row level security on storage.objects). Pages embed them by name, the way Obsidian
// does: `![[gel 2026-11-17.png]]`. The names are plugin data `file/<name, lowercase>` → `{name, sha256, mime, size,
// at, by}` (synced like the pages). Works in pages and in Node (fetch). The session comes from layr__supabase_session
// (docs/ARCHITECTURE.md › Supabase for plugins).

export const BUCKET = "lf-wiki";
export const MAX_BYTES = 50 * 1024 * 1024;
export const MIGRATION_HINT =
  "Attachments need the database update: the user runs supabase/migrations/lf_0004_wiki_files.sql " +
  "(node scripts/db-migrate.mjs)";

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", avif: "image/avif", pdf: "application/pdf", csv: "text/csv", tsv: "text/tab-separated-values",
  txt: "text/plain", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip",
  fasta: "text/plain", fa: "text/plain", gb: "text/plain", ab1: "application/octet-stream",
};

export const mimeOf = (name) => MIME[String(name ?? "").split(".").pop().toLowerCase()] ?? "application/octet-stream";
export const fileKey = (name) => `file/${String(name ?? "").trim().toLowerCase()}`;

/** A file name usable in `![[...]]` and on Windows: link and path characters become `-`; it keeps an extension. */
export function cleanFileName(name) {
  const raw = String(name ?? "").split(/[\\/]/).pop();
  let clean = raw
    .replace(/[\[\]#^|:*?"<>\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!/\.[a-z0-9]{1,5}$/i.test(clean)) clean = `${clean || "file"}.bin`;
  return clean.replace(/^\.+/, "") || "file.bin";
}

// ---------- sha256 (Web Crypto when there is one, else this small one) ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function sha256Js(bytes) {
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i] + add[i]) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

const toBytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** The sha256 of some bytes as lowercase hex. */
export async function sha256Hex(data) {
  const bytes = toBytes(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // not a secure context: fall through
    }
  }
  return sha256Js(bytes);
}

// ---------- the store ----------

export class Files {
  /** `session()` → `{url, key, accessToken, userId}`; `adapter`: the wiki's data adapter (dataGet, dataSet, ...). */
  constructor({ session, adapter, who = "you", fetch = (...a) => globalThis.fetch(...a) }) {
    this.session = session;
    this.a = adapter;
    this.who = who;
    this.fetch = fetch;
  }

  async list() {
    const rows = await this.a.dataList({ prefix: "file/", limit: 1000 });
    return rows.map((r) => r.value).filter(Boolean);
  }

  /** The attachment of this name (any case), or null. */
  async get(name) {
    return (await this.a.dataGet(fileKey(name))) ?? null;
  }

  async request(method, sha, { body, mime, s } = {}) {
    const session = s ?? (await this.session());
    if (!session?.accessToken) throw new Error("Sign in to layr to use attachments");
    const url = `${session.url}/storage/v1/object/${method === "GET" ? "authenticated/" : ""}${BUCKET}/` +
      `${session.userId}/${sha}`;
    const headers = { authorization: `Bearer ${session.accessToken}`, apikey: session.key };
    if (body) Object.assign(headers, { "content-type": mime, "x-upsert": "true", "cache-control": "31536000" });
    const res = await this.fetch(url, { method, headers, body });
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (/bucket not found/i.test(text)) throw new Error(MIGRATION_HINT);
    if (method === "POST" && (res.status === 409 || /duplicate|already exists/i.test(text))) return res;
    if (/row-level security|unauthorized|not authorized/i.test(text) && method === "POST") throw new Error(MIGRATION_HINT);
    throw new Error(`Storage answered ${res.status}: ${text.slice(0, 200)}`);
  }

  /**
   * Upload bytes as an attachment named `name`. The same content under the same name is reused; a different content
   * under a taken name gets " (2)", " (3)"... Gives the record `{name, sha256, mime, size, at, by}`.
   */
  async upload(name, data, mime = null) {
    const bytes = toBytes(data);
    if (bytes.length > MAX_BYTES) throw new Error(`An attachment can be at most ${MAX_BYTES / 1024 / 1024} MB`);
    const sha256 = await sha256Hex(bytes);
    const clean = cleanFileName(name);
    const dot = clean.lastIndexOf(".");
    let final = clean;
    for (let n = 2; ; n++) {
      const existing = await this.get(final);
      if (!existing) break;
      if (existing.sha256 === sha256) return existing;
      final = `${clean.slice(0, dot)} (${n})${clean.slice(dot)}`;
    }
    const type = mime || mimeOf(final);
    await this.request("POST", sha256, { body: bytes, mime: type });
    const record = { name: final, sha256, mime: type, size: bytes.length, at: Date.now(), by: this.who };
    await this.a.dataSet(fileKey(final), record);
    return record;
  }

  /**
   * Delete an attachment: its record, and the stored bytes when no other name holds the same content. Pages that
   * still embed it show it as missing (the Attachments page offers this only for unused files).
   */
  async remove(name) {
    const record = await this.get(name);
    if (!record) return false;
    await this.a.dataDelete(fileKey(record.name));
    const others = (await this.list()).some((r) => r.sha256 === record.sha256);
    if (!others) await this.request("DELETE", record.sha256).catch(() => {});
    return true;
  }

  /** The bytes of an attachment: `{record, bytes: ArrayBuffer}`. */
  async download(name) {
    const record = await this.get(name);
    if (!record) throw new Error(`No attachment "${name}"`);
    const res = await this.request("GET", record.sha256);
    return { record, bytes: await res.arrayBuffer() };
  }
}
