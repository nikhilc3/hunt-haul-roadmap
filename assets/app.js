/* Hunt & Haul roadmap: renders data/plan.json as an interactive tree + phase board. No build step. */
(function () {
  "use strict";

  const STORE_KEY = "hh-roadmap-v1";
  const STATUS_LABEL = { planned: "Planned", "in-progress": "In progress", blocked: "Blocked", done: "Done" };
  const STATUS_ORDER = ["done", "in-progress", "blocked", "planned"];
  const PRIORITY_LABEL = { P0: "P0 · must have", P1: "P1 · should have", P2: "P2 · nice to have" };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    plan: null,
    byId: new Map(),       // id -> { node, parent, depth }
    blocks: new Map(),     // id -> [ids that depend on it]
    expanded: new Set(),
    selected: null,
    view: "tree",
    filters: { q: "", status: "", priority: "", owner: "", phase: null },
  };

  /* ---------- persistence (per-viewer convenience only) ---------- */
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ expanded: [...state.expanded], view: state.view }));
    } catch (e) { /* storage unavailable */ }
  }

  /* ---------- data ---------- */
  function index(node, parent, depth) {
    state.byId.set(node.id, { node, parent, depth });
    for (const d of node.dependsOn || []) {
      if (!state.blocks.has(d)) state.blocks.set(d, []);
      state.blocks.get(d).push(node.id);
    }
    (node.children || []).forEach((c) => index(c, node, depth + 1));
  }
  function ancestors(id) {
    const out = [];
    let cur = state.byId.get(id);
    while (cur && cur.parent) { out.unshift(cur.parent); cur = state.byId.get(cur.parent.id); }
    return out;
  }
  function descendants(node) {
    const out = [];
    (function walk(n) { (n.children || []).forEach((c) => { out.push(c); walk(c); }); })(node);
    return out;
  }
  function statusCounts(nodes) {
    const c = { planned: 0, "in-progress": 0, blocked: 0, done: 0 };
    nodes.forEach((n) => { c[n.status] = (c[n.status] || 0) + 1; });
    return c;
  }
  function allNodes() { return [...state.byId.values()].map((v) => v.node); }

  /* ---------- filtering ---------- */
  function filterActive() {
    const f = state.filters;
    return !!(f.q || f.status || f.priority || f.owner || f.phase);
  }
  function matches(node) {
    const f = state.filters;
    if (f.status && node.status !== f.status) return false;
    if (f.priority && node.priority !== f.priority) return false;
    if (f.owner && node.owner !== f.owner) return false;
    if (f.phase && node.phase !== f.phase) return false;
    if (f.q) {
      const hay = [node.title, node.summary, node.id, node.notes, ...(node.deliverables || [])].join(" ").toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }
  function visibleSet() {
    if (!filterActive()) return null;
    const vis = new Set();
    for (const n of allNodes()) {
      if (matches(n)) {
        vis.add(n.id);
        ancestors(n.id).forEach((a) => vis.add(a.id));
      }
    }
    return vis;
  }
  function highlight(text) {
    const q = state.filters.q;
    const safe = esc(text);
    if (!q) return safe;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return safe;
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  /* ---------- small pieces ---------- */
  const statusPill = (s) => `<span class="status st-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
  const priChip = (p) => `<span class="pri pri-${esc(p)}" title="${esc(PRIORITY_LABEL[p] || p)}">${esc(p)}</span>`;
  function phaseName(id) {
    const p = state.plan.meta.phases.find((x) => x.id === id);
    return p ? p.name : "";
  }
  function bar(counts) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const colors = { done: "var(--st-done)", "in-progress": "var(--st-progress)", blocked: "var(--st-blocked)", planned: "var(--line-strong)" };
    return `<div class="bar" role="img" aria-label="${STATUS_ORDER.map((s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`).join(", ")}">` +
      STATUS_ORDER.map((s) => counts[s] ? `<span style="width:${(counts[s] / total) * 100}%;background:${colors[s]}"></span>` : "").join("") +
      "</div>";
  }
  const chevron = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

  /* ---------- header + phases ---------- */
  function renderHeader() {
    const m = state.plan.meta;
    $("title").textContent = m.title;
    $("lede").textContent = m.subtitle;
    $("ver").textContent = `v${m.version}`;
    $("updated").textContent = m.updated;
    $("loop").innerHTML = m.loop.map((s, i) =>
      `<span class="loop-step">${esc(s)}</span>${i < m.loop.length - 1 ? '<span class="loop-arrow" aria-hidden="true">→</span>' : ""}`
    ).join("") + '<span class="loop-back">↺ repeat</span>';
    const sel = $("f-owner");
    sel.innerHTML = '<option value="">All owners</option>' +
      Object.entries(m.owners).map(([k, v]) => `<option value="${esc(k)}">${esc(k)} · ${esc(v)}</option>`).join("");
  }

  function renderPhases() {
    const nodes = allNodes().filter((n) => n.id !== state.plan.root.id);
    $("phases").innerHTML = state.plan.meta.phases.map((p) => {
      const items = nodes.filter((n) => n.phase === p.id);
      const c = statusCounts(items);
      const on = state.filters.phase === p.id;
      return `<button type="button" class="phase" data-phase="${p.id}" aria-pressed="${on}">
        <span class="phase-num">PHASE ${p.id}</span>
        <span class="phase-name">${esc(p.name)}</span>
        <span class="phase-goal">${esc(p.goal)}</span>
        ${bar(c)}
        <span class="phase-meta">${items.length} items · ${c.done} done</span>
      </button>`;
    }).join("");
  }

  /* ---------- tree view ---------- */
  function renderTree() {
    const vis = visibleSet();
    const forceOpen = filterActive();
    const sel = state.selected;

    function li(node, depth) {
      if (vis && !vis.has(node.id)) return "";
      const kids = node.children || [];
      const open = forceOpen || state.expanded.has(node.id);
      const dim = vis && !matches(node);
      const total = kids.length ? descendants(node).length : 0;
      const caret = kids.length
        ? `<button type="button" class="caret" data-toggle="${esc(node.id)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(node.title)}">${chevron}</button>`
        : '<span class="caret leaf" aria-hidden="true"></span>';
      const row = `<div class="node${node.id === sel ? " is-selected" : ""}${dim ? " is-dim" : ""}">
          ${caret}
          <button type="button" class="node-main" data-select="${esc(node.id)}" aria-current="${node.id === sel ? "true" : "false"}">
            <span class="node-title">${highlight(node.title)}</span>
            <span class="tags">
              ${total ? `<span class="kids">${total}</span>` : ""}
              ${priChip(node.priority)}
              <span class="ph">Ph ${node.phase}</span>
              <span class="own">${esc(node.owner)}</span>
              ${statusPill(node.status)}
            </span>
          </button>
        </div>`;
      const sub = kids.length && open ? `<ul>${kids.map((k) => li(k, depth + 1)).join("")}</ul>` : "";
      return `<li class="depth-${Math.min(depth, 2)}">${row}${sub}</li>`;
    }
    const html = li(state.plan.root, 0);
    $("view").innerHTML = html ? `<ul class="tree" role="tree">${html}</ul>` : '<p class="empty" style="padding:20px">No items match these filters.</p>';
  }

  /* ---------- board view (by phase) ---------- */
  function renderBoard() {
    const items = allNodes().filter((n) => state.byId.get(n.id).depth >= 2 && (!filterActive() || matches(n)));
    const phases = state.filters.phase ? state.plan.meta.phases.filter((p) => p.id === state.filters.phase) : state.plan.meta.phases;
    $("view").innerHTML = `<div class="board">` + phases.map((p) => {
      const col = items.filter((n) => n.phase === p.id)
        .sort((a, b) => a.priority.localeCompare(b.priority) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      return `<div class="col"><h3>${p.id} · ${esc(p.name)} <small>${col.length}</small></h3>` +
        (col.length ? col.map((n) => {
          const path = ancestors(n.id).slice(1).map((a) => a.title).join(" › ");
          return `<button type="button" class="card${n.id === state.selected ? " is-selected" : ""}" data-select="${esc(n.id)}">
            <span class="card-path">${esc(path)}</span>
            <span class="card-title">${highlight(n.title)}</span>
            <span class="card-tags">${priChip(n.priority)} ${statusPill(n.status)} <span class="own">${esc(n.owner)}</span></span>
          </button>`;
        }).join("") : '<p class="empty">Nothing here.</p>') + "</div>";
    }).join("") + "</div>";
  }

  function renderView() {
    if (state.view === "board") renderBoard(); else renderTree();
    $("v-tree").setAttribute("aria-pressed", String(state.view === "tree"));
    $("v-board").setAttribute("aria-pressed", String(state.view === "board"));
    $("expand-all").hidden = state.view !== "tree";
    $("collapse-all").hidden = state.view !== "tree";
    const total = state.byId.size;
    const shown = filterActive() ? allNodes().filter(matches).length : total;
    $("count").textContent = filterActive() ? `${shown} of ${total} items match` : `${total} items`;
  }

  /* ---------- detail ---------- */
  function renderDetail() {
    const box = $("detail");
    const entry = state.byId.get(state.selected);
    if (!entry) { box.innerHTML = ""; return; }
    const n = entry.node;
    const owners = state.plan.meta.owners;
    const anc = ancestors(n.id);
    const desc = descendants(n);
    const deps = (n.dependsOn || []).filter((d) => state.byId.has(d));
    const blocks = state.blocks.get(n.id) || [];
    const list = (arr, cls) => arr && arr.length ? `<ul class="${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : '<p class="empty">None listed yet.</p>';
    const chip = (id) => { const t = state.byId.get(id).node; return `<button type="button" class="chip" data-select="${esc(id)}">${esc(t.title)} ${statusPill(t.status)}</button>`; };

    box.innerHTML = `<div class="detail-inner">
      <div class="detail-actions">
        <button type="button" class="btn close-sheet" id="close-sheet">Close</button>
        <button type="button" class="btn" id="copy-link">Copy link to this item</button>
        <span class="copied" id="copied" hidden>Link copied</span>
      </div>
      ${anc.length ? `<nav class="crumbs" aria-label="Path">${anc.map((a) => `<button type="button" data-select="${esc(a.id)}">${esc(a.title)}</button>`).join('<span class="sep">›</span>')}</nav>` : ""}
      <h2>${esc(n.title)}</h2>
      <p class="summary">${esc(n.summary)}</p>
      <dl class="facts">
        <div class="fact"><dt>Status</dt><dd>${statusPill(n.status)}</dd></div>
        <div class="fact"><dt>Priority</dt><dd>${esc(PRIORITY_LABEL[n.priority] || n.priority)}</dd></div>
        <div class="fact"><dt>Phase</dt><dd>${n.phase} · ${esc(phaseName(n.phase))}</dd></div>
        <div class="fact"><dt>Owner</dt><dd>${esc(n.owner)} · ${esc(owners[n.owner] || "")}</dd></div>
        <div class="fact"><dt>Estimate</dt><dd>${esc(n.estimate || "Not estimated")}</dd></div>
        <div class="fact"><dt>Items under</dt><dd>${desc.length}</dd></div>
      </dl>
      ${desc.length ? `<div class="section"><h4><span>Progress of everything under this</span><span>${statusCounts(desc).done}/${desc.length} done</span></h4>${bar(statusCounts(desc))}</div>` : ""}
      ${n.notes ? `<div class="note">${esc(n.notes)}</div>` : ""}
      <div class="section"><h4>Deliverables</h4>${list(n.deliverables, "checks")}</div>
      <div class="section"><h4>Done when</h4>${list(n.acceptance, "checks")}</div>
      <div class="section"><h4>Depends on</h4>${deps.length ? `<div class="chips">${deps.map(chip).join("")}</div>` : '<p class="empty">Nothing. Can start any time.</p>'}</div>
      ${blocks.length ? `<div class="section"><h4>Unblocks</h4><div class="chips">${blocks.map(chip).join("")}</div></div>` : ""}
      <div class="section"><h4>Risks</h4>${n.risks && n.risks.length ? `<ul class="plain risk">${n.risks.map((r) => `<li><span style="color:var(--ink)">${esc(r)}</span></li>`).join("")}</ul>` : '<p class="empty">None flagged.</p>'}</div>
      ${(n.children || []).length ? `<div class="section"><h4><span>Breaks down into</span><span>${n.children.length}</span></h4><div class="subs">${n.children.map((c) =>
        `<button type="button" class="sub" data-select="${esc(c.id)}"><span>${esc(c.title)}</span>${priChip(c.priority)}${statusPill(c.status)}</button>`).join("")}</div></div>` : ""}
    </div>`;

    $("copy-link").addEventListener("click", () => {
      const url = location.href.split("#")[0] + "#" + n.id;
      const c = $("copied");
      const done = () => { c.textContent = "Link copied"; c.hidden = false; setTimeout(() => { c.hidden = true; }, 1600); };
      const fallback = () => { c.textContent = url; c.hidden = false; c.style.userSelect = "all"; };
      try {
        navigator.clipboard.writeText(url).then(done, fallback);
      } catch (e) { fallback(); }
    });
    $("close-sheet").addEventListener("click", () => box.classList.remove("open"));
  }

  /* ---------- actions ---------- */
  function select(id, opts) {
    if (!state.byId.has(id)) return;
    state.selected = id;
    ancestors(id).forEach((a) => state.expanded.add(a.id));
    savePrefs();
    renderView();
    renderDetail();
    if (!opts || !opts.fromHash) {
      if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
    }
    if (!opts || !opts.quiet) $("detail").classList.add("open");
    const row = document.querySelector(`[data-select="${CSS.escape(id)}"]`);
    if (row && opts && opts.scroll) row.scrollIntoView({ block: "nearest" });
  }

  function bind() {
    $("view").addEventListener("click", (e) => {
      const t = e.target.closest("[data-toggle]");
      if (t) {
        const id = t.dataset.toggle;
        if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
        savePrefs(); renderView();
        return;
      }
      const s = e.target.closest("[data-select]");
      if (s) select(s.dataset.select);
    });
    $("detail").addEventListener("click", (e) => {
      const s = e.target.closest("[data-select]");
      if (s) select(s.dataset.select, { scroll: true });
    });
    $("phases").addEventListener("click", (e) => {
      const b = e.target.closest("[data-phase]");
      if (!b) return;
      const p = Number(b.dataset.phase);
      state.filters.phase = state.filters.phase === p ? null : p;
      renderPhases(); renderView();
    });
    $("q").addEventListener("input", (e) => { state.filters.q = e.target.value.trim(); renderView(); });
    $("f-status").addEventListener("change", (e) => { state.filters.status = e.target.value; renderView(); });
    $("f-priority").addEventListener("change", (e) => { state.filters.priority = e.target.value; renderView(); });
    $("f-owner").addEventListener("change", (e) => { state.filters.owner = e.target.value; renderView(); });
    $("v-tree").addEventListener("click", () => { state.view = "tree"; savePrefs(); renderView(); });
    $("v-board").addEventListener("click", () => { state.view = "board"; savePrefs(); renderView(); });
    $("expand-all").addEventListener("click", () => { allNodes().forEach((n) => { if ((n.children || []).length) state.expanded.add(n.id); }); savePrefs(); renderView(); });
    $("collapse-all").addEventListener("click", () => { state.expanded = new Set([state.plan.root.id]); savePrefs(); renderView(); });
    window.addEventListener("hashchange", () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id && id !== state.selected) select(id, { fromHash: true, scroll: true });
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("detail").classList.remove("open"); });
  }

  /* ---------- boot ---------- */
  function boot(plan) {
    state.plan = plan;
    index(plan.root, null, 0);
    const prefs = loadPrefs();
    if (prefs && Array.isArray(prefs.expanded) && prefs.expanded.length) {
      state.expanded = new Set(prefs.expanded.filter((id) => state.byId.has(id)));
    } else {
      state.expanded = new Set([plan.root.id, "world", "map-creation", "base"]);
    }
    if (prefs && (prefs.view === "board" || prefs.view === "tree")) state.view = prefs.view;
    renderHeader();
    renderPhases();
    bind();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    select(state.byId.has(fromHash) ? fromHash : "map-creation", { fromHash: true, quiet: true });
  }

  fetch("data/plan.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(boot)
    .catch((err) => {
      $("view").innerHTML = `<div class="error">Could not load <code>data/plan.json</code> (${esc(err.message)}).<br>
        Opening index.html straight from disk blocks this file. Serve the folder instead, for example <code>npx serve .</code>, or use the GitHub Pages link.</div>`;
    });
})();
