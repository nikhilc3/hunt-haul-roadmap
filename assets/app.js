/* Hunt & Haul roadmap. Reads data/plan.json and renders: overview, one page per area
   (click an item to open its details in place), a phase timeline, and search. No build step. */
(function () {
  "use strict";

  const STORE_KEY = "hh-roadmap-v2";
  const STATUS = { planned: "Planned", "in-progress": "In progress", blocked: "Blocked", done: "Done" };
  const STATUS_ORDER = ["done", "in-progress", "blocked", "planned"];
  const PRIORITY = { P0: "Must have", P1: "Should have", P2: "Nice to have" };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const chevron = '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

  const S = {
    plan: null,
    byId: new Map(),     // id -> { node, parent, depth }
    unblocks: new Map(), // id -> [ids that depend on it]
    open: new Set(),
    route: "overview",
    tlFilter: "",
    q: "",
    media: { items: {} },      // contents of data/media.json
    gh: null,                  // { token, login } when connected
    localUrls: new Map(),      // repo path -> object URL for files uploaded in this session
    uploads: new Map(),        // item id -> [{ name, state, msg }]
    confirmRm: null,           // path awaiting a second click to remove
    mediaOpen: new Set(),      // items whose "videos & references" panel is open
  };

  const GH_KEY = "hh-roadmap-github";
  const LIMITS = { image: 10, video: 50 }; // MB

  /* ---------- per-viewer memory (optional) ---------- */
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; } }
  function savePrefs() { try { localStorage.setItem(STORE_KEY, JSON.stringify({ open: [...S.open] })); } catch (e) { /* ignore */ } }

  /* ---------- data helpers ---------- */
  function index(node, parent, depth) {
    S.byId.set(node.id, { node, parent, depth });
    (node.dependsOn || []).forEach((d) => { if (!S.unblocks.has(d)) S.unblocks.set(d, []); S.unblocks.get(d).push(node.id); });
    (node.children || []).forEach((c) => index(c, node, depth + 1));
  }
  const get = (id) => S.byId.get(id);
  const areas = () => S.plan.root.children || [];
  function chain(id) { const out = []; let e = get(id); while (e && e.parent) { out.unshift(e.parent); e = get(e.parent.id); } return out; }
  function areaOf(id) { const e = get(id); if (!e || e.depth === 0) return null; if (e.depth === 1) return e.node; return chain(id)[1]; }
  function descendants(n) { const out = []; (function w(x) { (x.children || []).forEach((c) => { out.push(c); w(c); }); })(n); return out; }
  function counts(nodes) { const c = { planned: 0, "in-progress": 0, blocked: 0, done: 0 }; nodes.forEach((n) => c[n.status]++); return c; }
  function rollup(n) {
    const all = [n, ...descendants(n)];
    if (all.some((x) => x.status === "blocked")) return "blocked";
    if (all.some((x) => x.status === "in-progress")) return "in-progress";
    if (all.every((x) => x.status === "done")) return "done";
    return "planned";
  }
  const phase = (id) => S.plan.meta.phases.find((p) => p.id === id) || { id, name: "" };
  function phaseRange(n) {
    const ps = [n, ...descendants(n)].map((x) => x.phase);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    return lo === hi ? `Phase ${lo}` : `Phases ${lo}–${hi}`;
  }

  /* ---------- small pieces ---------- */
  function bar(c) {
    const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    const col = { done: "var(--st-done)", "in-progress": "var(--st-progress)", blocked: "var(--st-blocked)", planned: "var(--st-planned)" };
    const label = STATUS_ORDER.map((s) => `${c[s]} ${STATUS[s].toLowerCase()}`).join(", ");
    return `<div class="bar" role="img" aria-label="${label}">${STATUS_ORDER.map((s) => c[s] ? `<span style="width:${(c[s] / total) * 100}%;background:${col[s]}"></span>` : "").join("")}</div>`;
  }
  const chip = (s) => `<span class="chip ${s}"><span class="dot ${s}"></span>${STATUS[s]}</span>`;
  const legend = (c) => `<div class="legend">${STATUS_ORDER.map((s) => `<span><span class="dot ${s}"></span>${c[s]} ${STATUS[s].toLowerCase()}</span>`).join("")}</div>`;

  /* ---------- sidebar ---------- */
  function renderSidebar() {
    const cur = S.q ? "" : (S.route.startsWith("phase-") ? "timeline" : (areaOf(S.route) ? areaOf(S.route).id : S.route));
    const item = (href, label, extra, current) =>
      `<a class="nav-item" href="#${href}"${current ? ' aria-current="page"' : ""}>${extra || ""}<span>${esc(label)}</span></a>`;
    $("sidebar").innerHTML = `<div class="sidebar-scroll">
      <div class="nav-group">
        ${item("overview", "Overview", "", cur === "overview")}
        ${item("timeline", "Build order", "", cur === "timeline")}
        ${item("gaps", "Missing for 1:1", `<span class="dot blocked"></span>`, cur === "gaps")}
      </div>
      <div class="nav-group">
        <div class="nav-label">Areas</div>
        ${areas().map((a) => `<a class="nav-item" href="#${esc(a.id)}"${cur === a.id ? ' aria-current="page"' : ""}>
            <span class="dot ${rollup(a)}"></span><span>${esc(a.title)}</span><span class="n">${descendants(a).length}</span></a>`).join("")}
      </div></div>`;
    const active = $("sidebar").querySelector('[aria-current="page"]');
    const row = $("sidebar").querySelector(".sidebar-scroll");
    if (active && row && window.matchMedia("(max-width: 900px)").matches) {
      row.scrollLeft = active.offsetLeft - row.clientWidth / 2 + active.offsetWidth / 2;
    }
  }

  /* ---------- overview ---------- */
  function renderOverview() {
    const m = S.plan.meta, all = [...S.byId.values()].map((e) => e.node).filter((n) => n.id !== S.plan.root.id);
    const c = counts(all);
    return `<div class="page">
      <section>
        <div class="eyebrow"><b>Product plan</b><span>v${esc(m.version)}</span><span>Updated ${esc(m.updated)}</span></div>
        <h1>${esc(m.title)}</h1>
        <p class="lede">${esc(m.subtitle)}</p>
        <div class="loop" aria-label="Core game loop">${m.loop.map((s, i) => `<span class="loop-step"><span>${esc(s)}</span>${i < m.loop.length - 1 ? '<i aria-hidden="true">→</i>' : ""}</span>`).join("")}<span class="loop-repeat">↺ and repeat</span></div>
      </section>

      <section class="summary-card" aria-label="Plan summary">
        <div class="stats">
          <div class="stat"><b>${all.length}</b><span>items</span></div>
          <div class="stat"><b>${areas().length}</b><span>areas</span></div>
          <div class="stat"><b>${m.phases.length}</b><span>phases</span></div>
          <a class="stat stat-gaps" href="#gaps"><b>${allGapNodes().reduce((a, n) => a + n.gaps.length, 0)}</b><span>missing for 1:1 →</span></a>
          ${(() => { const m2 = /(\d+)\s*weeks?/.exec(S.plan.root.estimate || ""); return m2 ? `<div class="stat"><b>~${m2[1]}</b><span>weeks to soft launch</span></div>` : ""; })()}
        </div>
        ${bar(c)}
        ${legend(c)}
      </section>

      <section>
        <div class="section-head"><h2>Areas</h2><p>Pick an area to see everything in it.</p></div>
        <div class="tiles">${areas().map((a) => {
          const d = descendants(a);
          return `<a class="tile" href="#${esc(a.id)}">
            <h3>${esc(a.title)}</h3>
            <p>${esc(a.summary)}</p>
            <div class="tile-foot"><span>${d.length} items · ${phaseRange(a)}</span>${bar(counts(d))}</div>
          </a>`;
        }).join("")}</div>
      </section>

      <section>
        <div class="section-head"><h2>Build order</h2><p>Each phase builds on the one before it.</p></div>
        <ol class="steps">${m.phases.map((p) => {
          const n = all.filter((x) => x.phase === p.id && get(x.id).depth >= 2).length;
          return `<li class="step"><span class="step-num">${p.id}</span><div><h3>${esc(p.name)}</h3><p>${esc(p.goal)}</p></div><a href="#phase-${p.id}">${n} items →</a></li>`;
        }).join("")}</ol>
      </section>

      <p class="foot">The plan lives in <code>data/plan.json</code>. Edit it and push to GitHub, and this site updates itself.</p>
    </div>`;
  }

  /* ---------- gaps: what Claude still needs before it can build an item 1:1 ---------- */
  function gapsBlock(n) {
    const g = n.gaps || [];
    return g.length ? `<div class="gaps"><strong>Missing before Claude can build this 1:1</strong><ul>${g.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "";
  }
  const allGapNodes = () => [...S.byId.values()].map((e) => e.node).filter((n) => (n.gaps || []).length);
  function renderGaps() {
    const nodes = allGapNodes(), total = nodes.reduce((a, n) => a + n.gaps.length, 0);
    const refs = S.plan.meta.references || [];
    const link = (id) => get(id) ? `<a class="link" href="#${esc(id)}">${esc(get(id).node.title)}</a>` : "";
    const group = (title, list) => list.length ? `<section><div class="section-head"><h2>${esc(title)}</h2></div>
      ${list.map((n) => `<div class="gap-item"><a class="gap-title" href="#${esc(n.id)}">${esc(n.title)}</a>${n.priority === "P0" ? ' <span class="must">Must</span>' : ""}
        <ul>${n.gaps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("")}</section>` : "";
    const root = nodes.filter((n) => n.id === S.plan.root.id);
    return `<div class="page">
      <section>
        <div class="crumbs"><a href="#overview">Overview</a> / Missing for a 1:1 build</div>
        <h1 class="area-title">Missing for a 1:1 build</h1>
        <p class="lede">${total} things across ${nodes.length} items that Claude would have to guess at today. Fill these in (a decision, a number, or a reference image/video) and delete the line from <code>gaps</code> in plan.json.</p>
      </section>
      ${group("Whole game", root)}
      ${areas().map((a) => group(a.title, [a, ...descendants(a)].filter((n) => (n.gaps || []).length))).join("")}
      ${refs.map((r) => `<section><div class="section-head"><h2>Reference: ${esc(r.title)}</h2><p>Which item each moment of the clip is a reference for.</p></div>
        <ul class="rows">${r.beats.map(([t, what, ids]) => `<li><div class="ref-beat"><span class="ref-t">${esc(t)}</span><span class="t">${esc(what)}<span class="ref-links">${ids.map(link).join("")}</span></span></div></li>`).join("")}</ul></section>`).join("")}
    </div>`;
  }

  /* ---------- area page + accordion ---------- */
  function itemHTML(n, depth) {
    const open = S.open.has(n.id);
    const kids = n.children || [];
    const mc = mediaFor(n.id).length;
    const meta = [
      (n.gaps || []).length ? `<span class="gap-count" title="${n.gaps.length} thing${n.gaps.length === 1 ? "" : "s"} missing before Claude can build this 1:1">${n.gaps.length} missing</span>` : "",
      mc ? `<span class="media-count" title="${mc} image${mc === 1 ? "" : "s"} or video${mc === 1 ? "" : "s"}">${camIcon}${mc}</span>` : "",
      n.priority === "P0" ? '<span class="must">Must</span>' : "",
      n.status !== "planned" ? chip(n.status) : "",
    ].join("");
    return `<li class="item${open ? " open" : ""}" id="i-${esc(n.id)}">
      <button type="button" class="item-row" data-toggle="${esc(n.id)}" aria-expanded="${open}">
        ${chevron}
        <span class="item-title">${esc(n.title)}${open ? "" : `<small>${esc(n.summary)}</small>`}</span>
        <span class="item-meta">${meta}</span>
      </button>
      ${open ? bodyHTML(n, depth) : ""}
    </li>`;
  }
  function bodyHTML(n, depth) {
    const owners = S.plan.meta.owners;
    const deps = (n.dependsOn || []).filter((d) => S.byId.has(d));
    const unb = S.unblocks.get(n.id) || [];
    const link = (id) => { const x = get(id).node; return `<a class="link" href="#${esc(id)}"><span class="dot ${x.status}"></span>${esc(x.title)}</a>`; };
    const kids = n.children || [];
    return `<div class="item-body">
      <p>${esc(n.summary)}</p>
      <div class="meta-line">
        <span><b>${PRIORITY[n.priority]}</b></span>
        <span>${chip(n.status)}</span>
        <span>Phase ${n.phase} · ${esc(phase(n.phase).name)}</span>
        <span>${esc(owners[n.owner] || n.owner)}</span>
        ${n.estimate ? `<span>${esc(n.estimate)}</span>` : ""}
      </div>
      ${n.notes ? `<div class="callout"><strong>Note</strong>${esc(n.notes)}</div>` : ""}
      ${gapsBlock(n)}
      ${mediaBlock(n)}
      ${n.deliverables && n.deliverables.length ? `<div class="block"><h4>What gets built</h4><ul class="checks">${n.deliverables.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${n.acceptance && n.acceptance.length ? `<div class="block"><h4>Done when</h4><ul class="checks done-when">${n.acceptance.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${deps.length ? `<div class="block"><h4>Needs first</h4><div class="links">${deps.map(link).join("")}</div></div>` : ""}
      ${unb.length ? `<div class="block"><h4>Unlocks</h4><div class="links">${unb.map(link).join("")}</div></div>` : ""}
      ${n.risks && n.risks.length ? `<div class="block"><h4>Risks</h4><ul class="risks">${n.risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
      ${kids.length ? `<div class="block"><h4>Breaks down into</h4><ul class="items">${kids.map((k) => itemHTML(k, depth + 1)).join("")}</ul></div>` : ""}
      <div><button type="button" class="text-btn copy" data-copy="${esc(n.id)}">Copy link to this item</button><span class="copied" hidden></span></div>
    </div>`;
  }
  function renderArea(a) {
    const d = descendants(a), c = counts(d), owners = S.plan.meta.owners;
    return `<div class="page">
      <section>
        <div class="crumbs"><a href="#overview">Overview</a> / ${esc(a.title)}</div>
        <h1 class="area-title">${esc(a.title)}</h1>
        <p class="lede">${esc(a.summary)}</p>
        <dl class="facts">
          <div><dt>Priority</dt><dd>${PRIORITY[a.priority]}</dd></div>
          <div><dt>Lead</dt><dd>${esc(owners[a.owner] || a.owner)}</dd></div>
          <div><dt>When</dt><dd>${phaseRange(a)}</dd></div>
          ${a.estimate ? `<div><dt>Estimate</dt><dd>${esc(a.estimate)}</dd></div>` : ""}
          <div><dt>Progress</dt><dd>${c.done} of ${d.length} done</dd></div>
        </dl>
      </section>
      ${(a.acceptance && a.acceptance.length) || (a.risks && a.risks.length) ? `<section class="callout">
        ${a.acceptance && a.acceptance.length ? `<strong>This area is done when</strong>${a.acceptance.map(esc).join(". ")}.` : ""}
        ${a.risks && a.risks.length ? `<strong style="margin-top:8px">Watch out for</strong>${a.risks.map(esc).join(". ")}.` : ""}
      </section>` : ""}
      <section id="area-media">${mediaBlock(a, true)}</section>
      <section>
        <div class="section-head"><h2>${(a.children || []).length} parts</h2>
          <div class="list-tools"><button type="button" class="text-btn" data-all="open">Open all</button><button type="button" class="text-btn" data-all="close">Close all</button></div>
        </div>
        <ul class="items" id="area-items">${(a.children || []).map((k) => itemHTML(k, 2)).join("")}</ul>
      </section>
    </div>`;
  }

  /* ---------- timeline ---------- */
  function renderTimeline() {
    const all = [...S.byId.values()].filter((e) => e.depth >= 2).map((e) => e.node);
    const list = S.tlFilter ? all.filter((n) => n.status === S.tlFilter) : all;
    const f = (val, label) => `<button type="button" class="filter" data-filter="${val}" aria-pressed="${S.tlFilter === val}">${val ? `<span class="dot ${val}"></span>` : ""}${label}</button>`;
    return `<div class="page">
      <section>
        <div class="crumbs"><a href="#overview">Overview</a> / Build order</div>
        <h1 class="area-title">Build order</h1>
        <p class="lede">Every item grouped by the phase it belongs to. Finish a phase before leaning on the next.</p>
      </section>
      <div class="filters" role="group" aria-label="Show">${f("", "Everything")}${f("in-progress", "In progress")}${f("blocked", "Blocked")}${f("planned", "Planned")}${f("done", "Done")}</div>
      ${S.plan.meta.phases.map((p) => {
        const rows = list.filter((n) => n.phase === p.id).sort((a, b) => a.priority.localeCompare(b.priority));
        return `<section class="phase-block" id="phase-${p.id}">
          <div class="phase-head"><span class="step-num">${p.id}</span><div><h2>${esc(p.name)}</h2><p>${esc(p.goal)}</p></div></div>
          <ul class="rows">${rows.length ? rows.map((n) => `<li><a href="#${esc(n.id)}">
            <span class="dot ${n.status}"></span>
            <span class="t">${esc(n.title)}<small>${esc(areaOf(n.id).title)} · ${PRIORITY[n.priority]}</small></span>
            ${n.status !== "planned" ? chip(n.status) : ""}</a></li>`).join("") : '<li><p class="empty">Nothing here.</p></li>'}</ul>
        </section>`;
      }).join("")}
    </div>`;
  }

  /* ---------- search ---------- */
  function renderSearch() {
    const q = S.q.toLowerCase();
    const hits = [...S.byId.values()].filter((e) => e.depth >= 1).map((e) => e.node).filter((n) =>
      [n.title, n.summary, n.notes, ...(n.deliverables || []), ...(n.acceptance || []), ...(n.gaps || [])].join(" ").toLowerCase().includes(q));
    return `<div class="page">
      <section><div class="crumbs">Search</div><h1 class="area-title">“${esc(S.q)}”</h1><p class="lede">${hits.length} ${hits.length === 1 ? "result" : "results"}</p></section>
      <ul class="rows">${hits.length ? hits.map((n) => {
        const path = chain(n.id).slice(1).map((x) => x.title).join(" › ") || "Area";
        return `<li><a href="#${esc(n.id)}" data-clear-search><span class="dot ${n.status}"></span><span class="t">${esc(n.title)}<small>${esc(path)}</small></span>${n.status !== "planned" ? chip(n.status) : ""}</a></li>`;
      }).join("") : '<li><p class="empty">Nothing matches. Try “truck”, “egg” or “tutorial”.</p></li>'}</ul>
    </div>`;
  }

  /* ---------- media: images and videos per item, stored in the GitHub repo ---------- */
  const camIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>';
  const repo = () => S.plan.meta.repo || "";
  const branch = () => S.plan.meta.branch || "main";
  const onGitHubSite = () => /\.github\.io$/.test(location.hostname) || ["localhost", "127.0.0.1"].includes(location.hostname);
  const canUpload = () => onGitHubSite() && !!(S.gh && S.gh.token) && !!repo();
  const mediaFor = (id) => (S.media.items && S.media.items[id]) || [];
  const rawUrl = (path) => `https://raw.githubusercontent.com/${repo()}/${branch()}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const srcFor = (path) => S.localUrls.get(path) || path.split("/").map(encodeURIComponent).join("/");

  function loadGh() { try { S.gh = JSON.parse(localStorage.getItem(GH_KEY) || "null"); } catch (e) { S.gh = null; } }
  function saveGh() { try { if (S.gh) localStorage.setItem(GH_KEY, JSON.stringify(S.gh)); else localStorage.removeItem(GH_KEY); } catch (e) { /* ignore */ } }

  function gh(path, opts) {
    const o = opts || {};
    return fetch("https://api.github.com" + path, {
      method: o.method || "GET",
      headers: Object.assign({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        (o.token || (S.gh && S.gh.token)) ? { Authorization: "Bearer " + (o.token || S.gh.token) } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
  }
  const b64encodeText = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64decodeText = (b64) => decodeURIComponent(escape(atob(b64.replace(/\s/g, ""))));
  function fileToBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = () => rej(new Error("Couldn't read the file"));
      r.readAsDataURL(file);
    });
  }

  async function loadMedia() {
    if (canUpload()) {
      try {
        const r = await gh(`/repos/${repo()}/contents/data/media.json?ref=${branch()}`);
        if (r.ok) { const j = await r.json(); S.media = JSON.parse(b64decodeText(j.content)); return; }
      } catch (e) { /* fall back to the deployed copy */ }
    }
    try {
      const r = await fetch("data/media.json", { cache: "no-cache" });
      if (r.ok) S.media = await r.json();
    } catch (e) { /* no media yet */ }
    if (!S.media || typeof S.media.items !== "object") S.media = { items: {} };
  }

  // Read-modify-write data/media.json with the file's sha; retry if someone else saved first.
  async function updateManifest(mutate, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let sha, data = { items: {} };
      const r = await gh(`/repos/${repo()}/contents/data/media.json?ref=${branch()}`);
      if (r.ok) { const j = await r.json(); sha = j.sha; data = JSON.parse(b64decodeText(j.content)); }
      else if (r.status !== 404) throw new Error(`GitHub said ${r.status} while reading the media list`);
      if (!data.items) data.items = {};
      mutate(data);
      const w = await gh(`/repos/${repo()}/contents/data/media.json`, { method: "PUT", body: {
        message, branch: branch(), sha, content: b64encodeText(JSON.stringify(data, null, 2) + "\n") } });
      if (w.ok) { S.media = data; return; }
      if (w.status !== 409 && w.status !== 422) throw new Error(`GitHub said ${w.status} while saving the media list`);
    }
    throw new Error("Someone else was saving at the same moment. Try again.");
  }

  function safeName(name) {
    const dot = name.lastIndexOf(".");
    const base = (dot > 0 ? name.slice(0, dot) : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "file";
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    return ext ? `${base}.${ext}` : base;
  }

  function setUpload(id, name, state, msg) {
    const list = S.uploads.get(id) || [];
    const row = list.find((x) => x.name === name);
    if (row) { row.state = state; row.msg = msg; } else list.push({ name, state, msg });
    S.uploads.set(id, list);
    refreshMedia(id);
  }

  async function uploadFiles(id, files) {
    if (!canUpload()) { openConnect(); return; }
    for (const file of files) {
      const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
      if (!kind) { setUpload(id, file.name, "err", "Only images and videos can be added."); continue; }
      if (file.size > LIMITS[kind] * 1024 * 1024) {
        setUpload(id, file.name, "err", `Too big. ${kind === "image" ? "Images" : "Videos"} can be up to ${LIMITS[kind]} MB.`); continue;
      }
      const path = `media/${id}/${Date.now()}-${safeName(file.name)}`;
      try {
        setUpload(id, file.name, "busy", "Uploading…");
        const content = await fileToBase64(file);
        const put = await gh(`/repos/${repo()}/contents/${path}`, { method: "PUT", body: {
          message: `Add ${file.name} to ${get(id).node.title}`, branch: branch(), content } });
        if (put.status === 401 || put.status === 403) throw new Error("GitHub refused the upload. Reconnect with a token that has Contents: Read and write on this repo.");
        if (!put.ok) throw new Error(`GitHub said ${put.status}.`);
        S.localUrls.set(path, URL.createObjectURL(file));
        await updateManifest((data) => {
          (data.items[id] = data.items[id] || []).push({ path, name: file.name, type: kind, size: file.size, added: new Date().toISOString(), by: (S.gh && S.gh.login) || "" });
        }, `List ${file.name} under ${get(id).node.title}`);
        setUpload(id, file.name, "ok", "Added. Everyone sees it once the site redeploys (about a minute).");
      } catch (err) {
        setUpload(id, file.name, "err", err.message);
      }
    }
  }

  async function removeMedia(id, path) {
    try {
      const r = await gh(`/repos/${repo()}/contents/${path}?ref=${branch()}`);
      if (r.ok) {
        const j = await r.json();
        const d = await gh(`/repos/${repo()}/contents/${path}`, { method: "DELETE", body: { message: `Remove ${path}`, branch: branch(), sha: j.sha } });
        if (!d.ok && d.status !== 404) throw new Error(`GitHub said ${d.status} while removing the file.`);
      }
      await updateManifest((data) => {
        data.items[id] = (data.items[id] || []).filter((m) => m.path !== path);
        if (!data.items[id].length) delete data.items[id];
      }, `Unlist ${path}`);
      S.uploads.delete(id);
    } catch (err) {
      setUpload(id, "Remove", "err", err.message);
    }
    S.confirmRm = null;
    refreshMedia(id);
  }

  function mediaBlock(n, isArea) {
    const list = mediaFor(n.id);
    const ups = S.uploads.get(n.id) || [];
    const open = S.mediaOpen.has(n.id) || ups.length > 0;
    const scope = isArea ? [n, ...descendants(n)] : [n];
    const total = scope.reduce((sum, x) => sum + mediaFor(x.id).length, 0);
    const toggle = `<button type="button" class="media-toggle" data-media-toggle="${esc(n.id)}" aria-expanded="${open}">
        ${camIcon}<span>${open ? "Hide" : "Show"} videos &amp; references</span><span class="media-n">${list.length}</span></button>`;
    const zip = total && onGitHubSite()
      ? `<button type="button" class="media-toggle zip" data-zip="${esc(n.id)}" data-scope="${isArea ? "area" : "item"}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v3h16v-3"/></svg>
          <span>${isArea ? `Download all ${total} from this area` : "Download all"} (.zip)</span></button>`
      : "";
    if (!open) {
      return `<div class="block media" data-media="${esc(n.id)}"><div class="media-bar">${toggle}${zip}</div></div>`;
    }
    const shots = list.map((m) => {
      const src = srcFor(m.path), fallback = rawUrl(m.path);
      const view = m.type === "video"
        ? `<video src="${esc(src)}" controls preload="metadata" playsinline onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${esc(fallback)}'}"></video>`
        : `<img src="${esc(src)}" alt="${esc(m.name)}" loading="lazy" onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${esc(fallback)}'}"><button type="button" class="zoom" data-zoom="${esc(m.path)}" aria-label="View ${esc(m.name)} larger"></button>`;
      const rm = canUpload() ? `<button type="button" class="rm${S.confirmRm === m.path ? " confirm" : ""}" data-rm="${esc(m.path)}" data-item="${esc(n.id)}">${S.confirmRm === m.path ? "Click again to remove" : "Remove"}</button>` : "";
      return `<figure class="shot"><div class="shot-frame">${view}</div><figcaption><span title="${esc(m.name)}">${esc(m.name)}</span>${rm}</figcaption></figure>`;
    }).join("");
    let add;
    if (canUpload()) {
      add = `<div class="dropzone" data-drop="${esc(n.id)}">
        <strong>Drop images or videos here</strong>
        <span>or <label for="file-${esc(n.id)}">choose files</label><input type="file" id="file-${esc(n.id)}" data-file="${esc(n.id)}" accept="image/*,video/*" multiple></span>
        <small>Images up to ${LIMITS.image} MB, videos up to ${LIMITS.video} MB</small>
      </div>`;
    } else if (onGitHubSite()) {
      add = `<p class="media-note"><button type="button" data-connect>Connect GitHub</button> to add videos and images here.</p>`;
    } else {
      add = '<p class="media-note">Adding files works on the GitHub Pages site.</p>';
    }
    const upl = ups.length ? `<ul class="uploads">${ups.map((u) => `<li class="${u.state}">${esc(u.name)}: ${esc(u.msg)}</li>`).join("")}</ul>` : "";
    return `<div class="block media open" data-media="${esc(n.id)}">
      <div class="media-bar">${toggle}${zip}</div>
      <div class="media-panel">
        ${list.length ? `<div class="gallery">${shots}</div>` : `<p class="media-note">No videos or references here yet.</p>`}
        ${add}${upl}
      </div>
    </div>`;
  }

  /* ---------- zip download ---------- */
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = () => res(window.JSZip);
      s.onerror = () => rej(new Error("Couldn't load the zip tool. Check your connection."));
      document.head.appendChild(s);
    });
  }
  async function fetchMedia(m) {
    for (const url of [S.localUrls.get(m.path), srcFor(m.path), rawUrl(m.path)].filter(Boolean)) {
      try { const r = await fetch(url); if (r.ok) return await r.blob(); } catch (e) { /* try the next source */ }
    }
    throw new Error(`Couldn't download ${m.name}`);
  }
  async function downloadZip(btn) {
    const e = get(btn.dataset.zip); if (!e) return;
    const label = btn.querySelector("span");
    const before = label.textContent;
    const nodes = btn.dataset.scope === "area" ? [e.node, ...descendants(e.node)] : [e.node];
    const files = [];
    nodes.forEach((x, i) => mediaFor(x.id).forEach((m) => files.push({ m, folder: nodes.length > 1 ? `${String(i + 1).padStart(2, "0")}-${safeName(x.title)}` : "" })));
    btn.disabled = true;
    try {
      label.textContent = "Getting the zip tool…";
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const used = new Set();
      for (let i = 0; i < files.length; i++) {
        label.textContent = `Adding ${i + 1} of ${files.length}…`;
        const { m, folder } = files[i];
        let name = (folder ? folder + "/" : "") + m.name;
        let k = 2; while (used.has(name)) name = (folder ? folder + "/" : "") + `${k++}-${m.name}`;
        used.add(name);
        zip.file(name, await fetchMedia(m));
      }
      label.textContent = "Packing…";
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName(e.node.title)}-references.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      label.textContent = "Downloaded";
      setTimeout(() => { label.textContent = before; btn.disabled = false; }, 1800);
    } catch (err) {
      label.textContent = err.message;
      setTimeout(() => { label.textContent = before; btn.disabled = false; }, 3500);
    }
  }

  // Re-render only the media block (and the row's count) for one item, keeping scroll position.
  function refreshMedia(id) {
    document.querySelectorAll(`[data-media="${CSS.escape(id)}"]`).forEach((el) => {
      const tmp = document.createElement("div");
      const e = get(id);
      tmp.innerHTML = mediaBlock(e.node, e.depth === 1);
      el.replaceWith(tmp.firstElementChild);
    });
    const row = document.querySelector(`#i-${CSS.escape(id)} > .item-row .item-meta`);
    if (row) {
      const mc = mediaFor(id).length;
      const old = row.querySelector(".media-count");
      if (old) old.remove();
      if (mc) row.insertAdjacentHTML("afterbegin", `<span class="media-count">${camIcon}${mc}</span>`);
    }
  }

  function renderGhButton() {
    const b = $("gh-btn");
    if (!onGitHubSite() || !repo()) { b.hidden = true; return; }
    b.hidden = false;
    const on = !!(S.gh && S.gh.token);
    b.title = on ? `Connected to GitHub as ${S.gh.login || "you"}. Click to disconnect.` : "Connect GitHub to add images and videos";
    b.setAttribute("aria-label", b.title);
    b.innerHTML = on
      ? `<span class="dot"></span>${camIcon}<span class="gh-label">${esc(S.gh.login || "Connected")} · Disconnect</span>`
      : `${camIcon}<span class="gh-label">Add media</span>`;
  }
  function openConnect() {
    $("gh-repo").textContent = repo(); $("gh-repo-2").textContent = repo().split("/")[1] || repo();
    $("gh-error").hidden = true; $("gh-token").value = "";
    $("gh-dialog").showModal();
  }
  async function connect(token) {
    const err = $("gh-error"), btn = $("gh-submit");
    err.hidden = true; btn.disabled = true; btn.textContent = "Checking…";
    try {
      const r = await gh(`/repos/${repo()}`, { token });
      if (r.status === 401) throw new Error("That token wasn't accepted. Copy it again from GitHub.");
      if (!r.ok) throw new Error(`This token can't see ${repo()}. Give it access to that repo.`);
      const j = await r.json();
      if (j.permissions && !j.permissions.push) throw new Error("This token can read the repo but not change it. Set Contents to Read and write.");
      let login = "";
      try { const u = await gh("/user", { token }); if (u.ok) login = (await u.json()).login || ""; } catch (e) { /* optional */ }
      S.gh = { token, login }; saveGh();
      $("gh-dialog").close();
      await loadMedia();
      renderGhButton(); render({ keepScroll: true });
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Connect";
    }
  }

  function bindMedia() {
    $("gh-btn").addEventListener("click", () => {
      if (S.gh && S.gh.token) { S.gh = null; saveGh(); renderGhButton(); render({ keepScroll: true }); }
      else openConnect();
    });
    $("gh-cancel").addEventListener("click", () => $("gh-dialog").close());
    $("gh-form").addEventListener("submit", (e) => { e.preventDefault(); const t = $("gh-token").value.trim(); if (t) connect(t); });
    $("lightbox-close").addEventListener("click", () => $("lightbox").close());
    $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) $("lightbox").close(); });

    const main = $("main");
    main.addEventListener("dragover", (e) => {
      const z = e.target.closest("[data-drop]");
      if (!z) return;
      e.preventDefault(); z.classList.add("over");
    });
    main.addEventListener("dragleave", (e) => { const z = e.target.closest("[data-drop]"); if (z && !z.contains(e.relatedTarget)) z.classList.remove("over"); });
    main.addEventListener("drop", (e) => {
      const z = e.target.closest("[data-drop]");
      if (!z) return;
      e.preventDefault(); z.classList.remove("over");
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(z.dataset.drop, [...e.dataTransfer.files]);
    });
    main.addEventListener("change", (e) => {
      const inp = e.target.closest("[data-file]");
      if (inp && inp.files.length) { uploadFiles(inp.dataset.file, [...inp.files]); inp.value = ""; }
    });
    // Stop the browser from opening a file dropped anywhere else on the page.
    window.addEventListener("dragover", (e) => { if (!e.target.closest || !e.target.closest("[data-drop]")) e.preventDefault(); });
    window.addEventListener("drop", (e) => { if (!e.target.closest || !e.target.closest("[data-drop]")) e.preventDefault(); });
  }
  function handleMediaClick(e) {
    const z = e.target.closest("[data-zoom]");
    if (z) { const img = z.previousElementSibling; $("lightbox-img").src = img.currentSrc || img.src; $("lightbox-img").alt = img.alt; $("lightbox").showModal(); return true; }
    if (e.target.closest("[data-connect]")) { openConnect(); return true; }
    const mt = e.target.closest("[data-media-toggle]");
    if (mt) {
      const id = mt.dataset.mediaToggle;
      if (S.mediaOpen.has(id) || S.uploads.has(id)) { S.mediaOpen.delete(id); S.uploads.delete(id); } else S.mediaOpen.add(id);
      refreshMedia(id);
      return true;
    }
    const zb = e.target.closest("[data-zip]");
    if (zb) { if (!zb.disabled) downloadZip(zb); return true; }
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      if (S.confirmRm === rm.dataset.rm) { rm.textContent = "Removing…"; removeMedia(rm.dataset.item, rm.dataset.rm); }
      else { S.confirmRm = rm.dataset.rm; refreshMedia(rm.dataset.item); }
      return true;
    }
    return false;
  }

  /* ---------- routing ---------- */
  function render(opts) {
    const main = $("main");
    let html, focus = null;
    if (S.q) html = renderSearch();
    else if (S.route === "timeline" || S.route.startsWith("phase-")) html = renderTimeline();
    else if (S.route === "gaps") html = renderGaps();
    else if (get(S.route) && get(S.route).depth >= 1) {
      const a = areaOf(S.route);
      if (S.route !== a.id) { chain(S.route).forEach((x) => S.open.add(x.id)); S.open.add(S.route); focus = S.route; savePrefs(); }
      html = renderArea(a);
    } else html = renderOverview();
    main.innerHTML = html;
    renderSidebar();
    document.title = (S.q ? "Search · " : "") + (get(S.route) && get(S.route).depth >= 1 ? areaOf(S.route).title + " · " : "") + "Hunt & Haul Roadmap";
    if (focus) {
      const el = document.getElementById("i-" + focus);
      if (el) { el.scrollIntoView({ block: "start" }); el.classList.add("flash"); }
    } else if (S.route.startsWith("phase-")) {
      const el = document.getElementById(S.route); if (el) el.scrollIntoView({ block: "start" });
    } else if (!opts || !opts.keepScroll) window.scrollTo(0, 0);
  }
  function go() {
    const h = decodeURIComponent(location.hash.slice(1));
    S.route = h && (S.byId.has(h) || h === "timeline" || h === "gaps" || /^phase-\d+$/.test(h)) ? h : "overview";
    if (S.route === S.plan.root.id) S.route = "overview";
    render();
  }

  /* ---------- events ---------- */
  function bind() {
    $("main").addEventListener("click", (e) => {
      if (handleMediaClick(e)) return;
      const t = e.target.closest("[data-toggle]");
      if (t) {
        const id = t.dataset.toggle;
        if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
        savePrefs();
        const li = document.getElementById("i-" + id);
        const depth = get(id).depth;
        if (li) { const tmp = document.createElement("ul"); tmp.innerHTML = itemHTML(get(id).node, depth); li.replaceWith(tmp.firstElementChild); }
        return;
      }
      const all = e.target.closest("[data-all]");
      if (all) {
        const a = areaOf(S.route) || get(S.route).node;
        const ids = descendants(a).filter((n) => (n.children || []).length || get(n.id).depth === 2).map((n) => n.id);
        if (all.dataset.all === "open") ids.forEach((id) => S.open.add(id)); else ids.forEach((id) => S.open.delete(id));
        savePrefs(); render({ keepScroll: true });
        return;
      }
      const f = e.target.closest("[data-filter]");
      if (f) { S.tlFilter = f.dataset.filter; render({ keepScroll: true }); return; }
      const c = e.target.closest("[data-copy]");
      if (c) {
        const url = location.href.split("#")[0] + "#" + c.dataset.copy;
        const out = c.nextElementSibling;
        const ok = () => { out.textContent = "Link copied"; out.hidden = false; setTimeout(() => { out.hidden = true; }, 1600); };
        const fail = () => { out.textContent = url; out.hidden = false; };
        try { navigator.clipboard.writeText(url).then(ok, fail); } catch (err) { fail(); }
        return;
      }
      if (e.target.closest("[data-clear-search]")) { S.q = ""; $("q").value = ""; }
    });
    $("q").addEventListener("input", (e) => { S.q = e.target.value.trim(); render(); });
    $("sidebar").addEventListener("click", (e) => { if (e.target.closest("a") && S.q) { S.q = ""; $("q").value = ""; } });
    window.addEventListener("hashchange", go);
  }

  /* ---------- boot ---------- */
  fetch("data/plan.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(async (plan) => {
      S.plan = plan;
      index(plan.root, null, 0);
      const prefs = loadPrefs();
      if (prefs && Array.isArray(prefs.open)) S.open = new Set(prefs.open.filter((id) => S.byId.has(id)));
      $("brand").textContent = plan.meta.title;
      loadGh();
      await loadMedia();
      bind();
      bindMedia();
      renderGhButton();
      go();
    })
    .catch((err) => {
      $("main").innerHTML = `<p class="loading">Couldn't load <code>data/plan.json</code> (${esc(err.message)}). If you opened index.html straight from your computer, run <code>npx serve .</code> in the folder instead, or use the GitHub Pages link.</p>`;
    });
})();
