/* notes reader — public, read-only. Talks only to /api/public/* (the gate). */
(() => {
  const main = document.getElementById("main");
  const DATE_RE = /^(\d{4})[-_](\d{2})[-_](\d{2})/;
  const MONTH_TAIL_RE = /^(.+?) (\d{4}-\d{2})$/; // "Suchbot Casts 2026-08"

  // ---------- api ----------
  async function api(path) {
    const res = await fetch(`/api/public${path}`);
    if (!res.ok) throw Object.assign(new Error("http " + res.status), { status: res.status });
    return res.json();
  }

  // ---------- markdown (trimmed pipeline, no external deps) ----------
  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function inlineMd(line, publicRefs, titleSet) {
    let s = esc(line);
    // code spans first so their contents stay literal
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // images: external only — local ../assets stay as bracket text (private bucket)
    s = s.replace(/!\[([^]]*)\]\((https:\/\/[^)]+)\)/g, (_, alt, url) =>
      `<img src="${url}" alt="${alt}" loading="lazy">`);
    s = s.replace(/!\[([^]]*)\]\(([^)]+)\)/g, (_, alt) => `<span class="noimg">[${alt}]</span>`);
    // links
    s = s.replace(/\[([^]]+)\]\((https:\/\/[^)]+)\)/g, (_, t, u) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    // page refs — link only if the target is public; else plain text
    s = s.replace(/\[\[([^]|]+)(?:\|([^]]+))?\]\]/g, (m, ref, label) => {
      const r = ref.trim();
      if (publicRefs && publicRefs.includes(r)) {
        return `<a class="ref" href="/p/${encodeURIComponent(r)}">${esc(label || r)}</a>`;
      }
      return esc(label || r);
    });
    // tags as muted text (no link — tag pages aren't a public surface)
    s = s.replace(/(^|\s)(#[\w/-]+)/g, (_, pre, tag) => `${pre}<span class="tag">${tag}</span>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
    s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    return s;
  }

  function renderBlock(content, publicRefs) {
    const c = String(content ?? "");
    if (c.startsWith("```")) {
      const body = c.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
      return `<pre class="code">${esc(body)}</pre>`;
    }
    const lines = c.split("\n");
    return lines
      .map((line) => {
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) return `<h${h[1].length + 1} class="blk-h">${inlineMd(h[2], publicRefs)}</h${h[1].length + 1}>`;
        if (/^-+$/.test(line.trim())) return "<hr>";
        if (/^>\s?/.test(line)) return `<blockquote>${inlineMd(line.replace(/^>\s?/, ""), publicRefs)}</blockquote>`;
        return inlineMd(line, publicRefs);
      })
      .join("<br>");
  }

  // ---------- series ----------
  // Dated pages ("2026-08-17 - Morning Scan") collapse into series cards;
  // month-stamped pages ("Suchbot Casts 2026-08") do too.
  function seriesOf(title) {
    const m = title.match(DATE_RE);
    if (m) {
      const rest = title.slice(m[0].length).replace(/^ *- */, "").trim();
      return { series: rest || "Journal", date: m[0] };
    }
    const mm = title.match(MONTH_TAIL_RE);
    if (mm && mm[1].trim().length > 2) return { series: mm[1].trim(), date: mm[2] };
    return null;
  }

  function groupSeries(pages) {
    const map = new Map();
    for (const p of pages) {
      const s = seriesOf(p.title);
      if (!s) continue;
      if (!map.has(s.series)) map.set(s.series, []);
      map.get(s.series).push({ page: p, date: s.date });
    }
    const series = [...map.entries()].map(([name, entries]) => {
      entries.sort((a, b) => b.date.localeCompare(a.date));
      return { name, entries };
    });
    series.sort((a, b) =>
      b.entries[0].date.localeCompare(a.entries[0].date) || a.name.localeCompare(b.name));
    return series;
  }

  function weekday(dateToken) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) return "";
    const d = new Date(dateToken);
    return isNaN(d) ? "" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  }

  // ---------- views ----------
  function setLoading(msg) {
    main.innerHTML = `<div class="loading">${esc(msg || "loading…")}</div>`;
  }

  // Document-order block list (same DFS the page view uses).
  function docOrder(blocks) {
    const byId = new Map(), kids = new Map();
    for (const b of blocks) byId.set(b["block/id"], b);
    for (const b of blocks) {
      const pid = b["block/parent"] && b["block/parent"]["block/id"];
      if (pid && pid !== b["block/id"] && byId.has(pid)) {
        if (!kids.has(pid)) kids.set(pid, []);
        kids.get(pid).push(b);
      }
    }
    for (const list of kids.values()) list.sort((a, b) => (a["block/order"] || 0) - (b["block/order"] || 0));
    const roots = blocks
      .filter((b) => {
        const pid = b["block/parent"] && b["block/parent"]["block/id"];
        return !pid || pid === b["block/id"] || !byId.has(pid);
      })
      .sort((a, b) => (a["block/order"] || 0) - (b["block/order"] || 0));
    const ordered = [], seen = new Set();
    const dfs = (b) => {
      if (seen.has(b["block/id"])) return;
      seen.add(b["block/id"]);
      ordered.push(b);
      for (const k of kids.get(b["block/id"]) || []) dfs(k);
    };
    roots.forEach(dfs);
    for (const b of blocks) if (!seen.has(b["block/id"])) ordered.push(b);
    return ordered;
  }

  // Plain-text excerpt from a page's blocks: skip headings, code, property
  // lines and images; strip markdown tokens; clamp to ~260 chars.
  function excerptFrom(blocks) {
    const parts = [];
    for (const b of docOrder(blocks)) {
      const c = String(b["block/content"] || "");
      if (c.startsWith("```") || c.startsWith("#")) continue;
      if (/^[\w -]+::/.test(c.trim()) || /^-+$/.test(c.trim())) continue;
      const t = c
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, r, l) => (l || r).trim())
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[*_~`#]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (t) parts.push(t);
      if (parts.join(" ").length > 300) break;
    }
    const e = parts.join(" ");
    return e.length > 260 ? e.slice(0, 257).replace(/\s+\S*$/, "") + "…" : e;
  }

  async function viewLanding() {
    document.title = "mxjxn / notes";
    setLoading();
    const data = await api("/pages");
    const series = groupSeries(data.pages);
    const dated = new Set(series.flatMap((s) => s.entries.map((e) => e.page.title)));
    const evergreen = data.pages.filter((p) => !dated.has(p.title));
    const totalEntries = series.reduce((n, s) => n + s.entries.length, 0);

    // hydrate excerpts in parallel; a failed fetch just means no excerpt
    const posts = await Promise.all(evergreen.map(async (p) => {
      let excerpt = "";
      try {
        excerpt = excerptFrom((await api(`/page/${encodeURIComponent(p.title)}`)).blocks);
      } catch (e) { /* leave empty */ }
      const d = new Date((p.mtime || 0) * 1000);
      return { page: p, excerpt, date: isNaN(d) ? "" : d.toISOString().slice(0, 10) };
    }));

    main.innerHTML = `
      <div class="landing">
        <section class="front">
          <h2 class="sec-h">recent</h2>
          ${posts.map((p, i) => `
            <article class="post${i === 0 ? " feat" : ""}">
              <a class="post-title" href="/p/${encodeURIComponent(p.page.title)}">${esc(p.page.title)}</a>
              ${p.date ? `<div class="post-date">${p.date}</div>` : ""}
              ${p.excerpt ? `<p class="post-excerpt">${esc(p.excerpt)}</p>` : ""}
              <a class="post-more" href="/p/${encodeURIComponent(p.page.title)}">read more →</a>
            </article>`).join("") || '<div class="empty">nothing yet</div>'}
        </section>
        <section class="series-sec">
          <h2 class="sec-h">series <span class="dim">${totalEntries} reports</span></h2>
          ${series.map((s) => `
            <a class="card series" href="/x/${encodeURIComponent(s.name)}">
              <span class="card-title">${esc(s.name)}</span>
              <span class="card-meta">${s.entries.length} ${s.entries.length === 1 ? "entry" : "entries"} · latest ${esc(s.entries[0].date)}</span>
            </a>`).join("") || '<div class="empty">nothing yet</div>'}
        </section>
      </div>`;
  }

  function linkCard(p) {
    const clean = p.title.replace(DATE_RE, "").replace(/^ *- */, "") || p.title;
    const dateM = p.title.match(DATE_RE);
    return `<a class="card" href="/p/${encodeURIComponent(p.title)}">
      ${dateM ? `<span class="card-date">${dateM[0]}</span>` : ""}
      <span class="card-title">${esc(clean)}</span>
    </a>`;
  }

  async function viewSeries(name) {
    setLoading();
    const data = await api("/pages");
    const s = groupSeries(data.pages).find((x) => x.name === name);
    if (!s) {
      document.title = "not found — mxjxn / notes";
      main.innerHTML = `
        <div class="notfound">
          <h2>No such series.</h2>
          <a class="back" href="/">← all public notes</a>
        </div>`;
      return;
    }
    document.title = `${s.name} — mxjxn / notes`;
    main.innerHTML = `
      <article class="page">
        <a class="back" href="/">← all public notes</a>
        <h1 class="page-title">${esc(s.name)}</h1>
        <div class="series-count">${s.entries.length} entries</div>
        <div class="series-list">
          ${s.entries.map((e) => {
            const w = weekday(e.date);
            return `<a class="card entry" href="/p/${encodeURIComponent(e.page.title)}">
              <span class="card-title mono">${esc(e.date)}${w ? `<span class="dim"> · ${w}</span>` : ""}</span>
            </a>`;
          }).join("")}
        </div>
      </article>`;
    window.scrollTo(0, 0);
  }

  async function viewPage(title) {
    setLoading();
    let data;
    try {
      data = await api(`/page/${encodeURIComponent(title)}`);
    } catch (e) {
      document.title = "not found — mxjxn / notes";
      main.innerHTML = `
        <div class="notfound">
          <h2>This page is private or doesn't exist.</h2>
          <p>Only pages explicitly published appear here.</p>
          <a class="back" href="/">← all public notes</a>
        </div>`;
      return;
    }
    document.title = `${data.title} — mxjxn / notes`;
    const firstText = (data.blocks.find((b) => !String(b["block/content"] || "").startsWith("#")) || {})["block/content"] || "";
    let md = document.querySelector('meta[name="description"]');
    if (!md) { md = document.createElement("meta"); md.name = "description"; document.head.appendChild(md); }
    md.content = String(firstText).slice(0, 155);

    const html = docOrder(data.blocks)
      .map((b) => {
        const level = Math.min(b["block/level"] || 0, 6);
        const inner = renderBlock(b["block/content"], data.publicRefs);
        const isHeading = String(b["block/content"] || "").startsWith("#");
        return `<div class="blk lvl-${level}${isHeading ? " is-heading" : ""}">${inner}</div>`;
      })
      .join("");
    main.innerHTML = `
      <article class="page">
        <a class="back" href="/">← all public notes</a>
        <h1 class="page-title">${esc(data.title)}</h1>
        <div class="blocks">${html}</div>
      </article>`;
    window.scrollTo(0, 0);
  }

  async function viewSearch(q) {
    document.title = `search: ${q} — mxjxn / notes`;
    setLoading();
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    const results = data.results
      .map((r) => `
        <a class="card result" href="/p/${encodeURIComponent(r.page)}">
          <span class="card-title">${esc(r.page)}</span>
          ${r.blocks.map((b) => `<span class="snippet">${esc(String(b).replace(/\s+/g, " ").slice(0, 220))}${String(b).length > 220 ? "…" : ""}</span>`).join("")}
        </a>`)
      .join("");
    main.innerHTML = `
      <div class="searchview">
        <h2 class="sec-h">search <span class="dim">“${esc(q)}” — ${data.pages} page${data.pages === 1 ? "" : "s"}</span></h2>
        ${results || '<div class="empty">no public pages match</div>'}
        <a class="back" href="/">← all public notes</a>
      </div>`;
  }

  // ---------- router ----------
  function route() {
    const path = decodeURIComponent(location.pathname);
    const params = new URLSearchParams(location.search);
    if (path.startsWith("/p/")) return viewPage(path.slice(3));
    if (path.startsWith("/x/")) return viewSeries(path.slice(3));
    if (path === "/s" && params.get("q")) return viewSearch(params.get("q"));
    return viewLanding();
  }

  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("search-input").value.trim();
    if (q) history.pushState({}, "", `/s?q=${encodeURIComponent(q)}`);
    route();
  });
  window.addEventListener("popstate", route);

  const pref = new URLSearchParams(location.search).get("q");
  if (pref) document.getElementById("search-input").value = pref;
  route().catch((e) => {
    main.innerHTML = `<div class="notfound"><h2>Upstream unavailable.</h2><a class="back" href="/">retry</a></div>`;
  });
})();
