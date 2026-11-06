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
  };

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

  /* ---------- area page + accordion ---------- */
  function itemHTML(n, depth) {
    const open = S.open.has(n.id);
    const kids = n.children || [];
    const meta = [
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
      [n.title, n.summary, n.notes, ...(n.deliverables || []), ...(n.acceptance || [])].join(" ").toLowerCase().includes(q));
    return `<div class="page">
      <section><div class="crumbs">Search</div><h1 class="area-title">“${esc(S.q)}”</h1><p class="lede">${hits.length} ${hits.length === 1 ? "result" : "results"}</p></section>
      <ul class="rows">${hits.length ? hits.map((n) => {
        const path = chain(n.id).slice(1).map((x) => x.title).join(" › ") || "Area";
        return `<li><a href="#${esc(n.id)}" data-clear-search><span class="dot ${n.status}"></span><span class="t">${esc(n.title)}<small>${esc(path)}</small></span>${n.status !== "planned" ? chip(n.status) : ""}</a></li>`;
      }).join("") : '<li><p class="empty">Nothing matches. Try “truck”, “egg” or “tutorial”.</p></li>'}</ul>
    </div>`;
  }

  /* ---------- routing ---------- */
  function render(opts) {
    const main = $("main");
    let html, focus = null;
    if (S.q) html = renderSearch();
    else if (S.route === "timeline" || S.route.startsWith("phase-")) html = renderTimeline();
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
    S.route = h && (S.byId.has(h) || h === "timeline" || /^phase-\d+$/.test(h)) ? h : "overview";
    if (S.route === S.plan.root.id) S.route = "overview";
    render();
  }

  /* ---------- events ---------- */
  function bind() {
    $("main").addEventListener("click", (e) => {
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
    .then((plan) => {
      S.plan = plan;
      index(plan.root, null, 0);
      const prefs = loadPrefs();
      if (prefs && Array.isArray(prefs.open)) S.open = new Set(prefs.open.filter((id) => S.byId.has(id)));
      $("brand").textContent = plan.meta.title;
      bind();
      go();
    })
    .catch((err) => {
      $("main").innerHTML = `<p class="loading">Couldn't load <code>data/plan.json</code> (${esc(err.message)}). If you opened index.html straight from your computer, run <code>npx serve .</code> in the folder instead, or use the GitHub Pages link.</p>`;
    });
})();
