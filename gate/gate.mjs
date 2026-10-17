// logseq-public-gate — read-only public surface over logseqd (8471)
// Whitelist-enforced: only pages marked public:: true or visibility:: public
// are retrievable. No write handlers exist. Binds 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";

const LOGSEQD = process.env.LOGSEQD_URL || "http://127.0.0.1:8471";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "8473", 10);
const WHITELIST_TTL_MS = 15_000;

// ---------- whitelist (public:: true OR visibility:: public) ----------
let wlCache = { at: 0, titles: null };

async function fetchWhitelist() {
  if (wlCache.titles && Date.now() - wlCache.at < WHITELIST_TTL_MS) return wlCache.titles;
  const titles = new Set();
  for (const [key, value] of [["public", "true"], ["visibility", "public"]]) {
    try {
      const res = await fetch(
        `${LOGSEQD}/property?key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}&scope=page`
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results || []) {
        if (r["page/title"]) titles.add(r["page/title"]);
      }
    } catch {
      /* logseqd down or partial — skip this key */
    }
  }
  wlCache = { at: Date.now(), titles };
  return titles;
}

function invalidateWhitelist() {
  wlCache = { at: 0, titles: null };
}

// ---------- helpers ----------
async function logseqdJson(path) {
  const res = await fetch(`${LOGSEQD}${path}`);
  if (!res.ok) throw new Error(`logseqd ${res.status}`);
  return res.json();
}

function mtimeForTitle(title) {
  // Best effort — from whitelist file paths via a fresh lookup is wasteful;
  // derive from graph dir directly using Logseq's ___ slash encoding.
  try {
    const safe = title.replace(/\//g, "___");
    const p = `/root/mxjxn-logseq-notes/pages/${safe}.md`;
    return Math.round(fs.statSync(p).mtimeMs / 1000);
  } catch {
    return null;
  }
}

// Curation attribute, read straight from the file's property zone (lines
// before the first bullet). File-based on purpose: logseqd's index doesn't
// retract removed properties, and this needs to reflect removals instantly.
// Only `position` is ever exposed — other properties stay behind the gate.
function propForTitle(title, key) {
  try {
    const safe = title.replace(/\//g, "___");
    const p = `/root/mxjxn-logseq-notes/pages/${safe}.md`;
    const head = fs.readFileSync(p, "utf8").slice(0, 2048);
    const zone = head.split(/\n(?=\t?- )/)[0];
    const re = new RegExp("^" + key + "::?\\s*(.+)$", "m"); // Logseq `key::` or YAML `key:`
    const m = zone.match(re);
    const v = m && m[1].trim().replace(/^["']|["']$/g, "");
    return v || null;
  } catch {
    return null;
  }
}

function positionForTitle(title) {
  return propForTitle(title, "position");
}

// `article:: true` opts a public page into mxjxn.com's recent-articles
// section specifically — the reader (notes.mxjxn.com) ignores it.
function articleForTitle(title) {
  return propForTitle(title, "article") === "true";
}

const REF_RE = /\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/g;
function extractRefs(blocks) {
  const refs = new Set();
  for (const b of blocks) {
    const c = b["block/content"] || "";
    let m;
    while ((m = REF_RE.exec(c))) refs.add(m[1].trim());
  }
  return [...refs];
}

// ---------- handlers ----------
async function handlePages() {
  const wl = await fetchWhitelist();
  const pages = [...wl].map((title) => {
    const position = positionForTitle(title);
    return {
      title,
      mtime: mtimeForTitle(title),
      ...(position ? { position } : {}),
      ...(articleForTitle(title) ? { article: true } : {}),
    };
  });
  pages.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { count: pages.length, pages };
}

async function handlePage(title) {
  const wl = await fetchWhitelist();
  if (!wl.has(title)) return null; // private or nonexistent — same answer
  const data = await logseqdJson(`/page/${encodeURIComponent(title)}`);
  const refs = extractRefs(data.blocks || []);
  const publicRefs = refs.filter((r) => wl.has(r));
  return { title, blocks: data.blocks || [], publicRefs };
}

async function handleSearch(q) {
  const wl = await fetchWhitelist();
  const data = await logseqdJson(`/search?q=${encodeURIComponent(q)}`);
  const results = [];
  for (const r of data.results || []) {
    if (!wl.has(r.page)) continue; // filter BEFORE collect — private pages never leave
    results.push({ page: r.page, blocks: (r.blocks || []).slice(0, 3) });
  }
  return { query: q, results, pages: results.length };
}

async function handleRecent(n) {
  const all = await handlePages();
  return { pages: all.pages.slice(0, n) };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };

  if (req.method !== "GET") return send(405, { error: "read-only" });

  const url = new URL(req.url, `http://${HOST}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["public", ...]

  if (parts[0] !== "public") return send(404, { error: "not found" });

  try {
    if (parts.length === 2 && parts[1] === "pages") {
      if (url.searchParams.get("invalidate") === "1") invalidateWhitelist();
      return send(200, await handlePages());
    }
    if (parts.length === 2 && parts[1] === "search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return send(400, { error: "missing q" });
      return send(200, await handleSearch(q.trim()));
    }
    if (parts.length === 2 && parts[1] === "recent") {
      return send(200, await handleRecent(Math.min(parseInt(url.searchParams.get("n") || "10", 10) || 10, 50)));
    }
    if (parts.length >= 2 && parts[1] === "page") {
      const title = decodeURIComponent(parts.slice(2).join("/"));
      if (!title) return send(400, { error: "missing title" });
      const data = await handlePage(title);
      if (!data) return send(404, { error: "not found" });
      return send(200, data);
    }
    return send(404, { error: "not found" });
  } catch (e) {
    if (String(e.message).includes("logseqd")) return send(502, { error: "upstream unavailable" });
    return send(500, { error: "gate error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[gate] listening on ${HOST}:${PORT} — read-only, whitelist-enforced`);
});
