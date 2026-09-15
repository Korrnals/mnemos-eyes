// vesmaro-eyes — task board SPA (vanilla ES modules, no build step).

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  board: null,        // {columns, tasks, counts}
  memories: {},       // task_id -> resolve response
  es: null,           // EventSource
  memServers: null,   // {servers, groups}
  memScope: "all",    // server name | group name | "all"
};

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}

const ENV_LABELS = {
  cluster: "ai-agent cluster",
  laptop: "laptop",
  local: "local",
  cloud: "cloud",
  unknown: "env —",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ------------------------------------------------------------------- board
const COLUMN_TITLES = {
  open: "открыто",
  "in-progress": "в работе",
  blocked: "блокировано",
  resolved: "решено",
  done: "готово",
};

function renderBoard() {
  const board = state.board;
  if (!board) return;
  const el = $("#board");
  el.innerHTML = "";
  for (const col of board.columns) {
    const tasks = board.tasks.filter((t) => t.col === col);
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.col = col;
    colEl.innerHTML = `
      <div class="column-head">
        <span class="column-title">${esc(COLUMN_TITLES[col] || col)}</span>
        <span class="column-count">${tasks.length}</span>
      </div>
      <div class="column-body"></div>`;
    const body = $(".column-body", colEl);
    if (!tasks.length) {
      body.innerHTML = `<div class="column-empty">пусто</div>`;
    }
    for (const t of tasks) body.appendChild(taskCard(t));
    colEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      colEl.classList.add("drag-over");
    });
    colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
    colEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      colEl.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/task-id");
      if (!id) return;
      const task = state.board.tasks.find((t) => t.id === id);
      if (!task || task.col === col) return;
      // Optimistic update; SSE will reconcile.
      task.col = col;
      renderBoard();
      try {
        await api(`/api/tasks/${encodeURIComponent(id)}/move`, {
          method: "POST",
          body: JSON.stringify({ col }),
        });
      } catch (err) {
        console.error("move failed", err);
        await refreshBoard();
      }
    });
    el.appendChild(colEl);
  }
}

function taskCard(t) {
  const card = document.createElement("article");
  card.className = "task";
  card.draggable = true;
  card.dataset.id = t.id;
  card.style.setProperty("--i", String(Math.floor(Math.random() * 5)));

  const chips = [];
  chips.push(`<span class="chip chip-agent" title="агент-исполнитель">⚒ ${esc(t.agents.join(", ") || "—")}</span>`);
  chips.push(`<span class="chip chip-env" title="среда исполнения">${esc(ENV_LABELS[t.env] || t.env)}</span>`);
  for (const s of (t.specialists || []).slice(0, 3)) {
    chips.push(`<span class="chip chip-spec" title="специалист">${esc(s)}</span>`);
  }
  if ((t.memory_ids || []).length) {
    chips.push(`<span class="chip chip-mem" title="связанные памяти mnemos">◉ ${t.memory_ids.length}</span>`);
  }

  card.innerHTML = `
    <div class="task-id">${esc(t.id)}</div>
    <h3 class="task-title">${esc(t.title)}</h3>
    <div class="task-chips">${chips.join("")}</div>`;

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/task-id", t.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openDrawer(t));
  return card;
}

async function refreshBoard() {
  state.board = await api("/api/board");
  renderBoard();
  renderRail();
}

// ------------------------------------------------- memory servers & scope
const SCOPE_KEY = "mnemos-eyes:memscope";

function scopeParam() {
  return state.memScope && state.memScope !== "all" ? state.memScope : "";
}

async function loadMemServers() {
  const data = await api("/api/memories/servers");
  state.memServers = data;
  const sel = $("#mem-scope");
  const prev = localStorage.getItem(SCOPE_KEY) || "all";
  let html = `<option value="all">◉ все серверы памяти</option>`;
  const groups = Object.entries(data.groups || {});
  for (const [group, names] of groups) {
    if (names.length > 1) {
      html += `<option value="${esc(group)}">⬡ кластер «${esc(group)}» (${names.length})</option>`;
    }
  }
  for (const s of data.servers || []) {
    const mark = s.ok ? "●" : "○";
    html += `<option value="${esc(s.name)}">${mark} ${esc(s.name)}</option>`;
  }
  sel.innerHTML = html;
  state.memScope = (prev === "all" || sel.querySelector(`option[value="${CSS.escape(prev)}"]`)) ? prev : "all";
  sel.value = state.memScope;
  sel.onchange = () => {
    state.memScope = sel.value;
    localStorage.setItem(SCOPE_KEY, sel.value);
    updateScopeLabels();
    refreshPulse();
    refreshStores();
    if (drawerTask) openDrawer(drawerTask);
  };
  updateScopeLabels();
}

function updateScopeLabels() {
  const label = $("#pulse-scope-label");
  if (!label) return;
  if (state.memScope === "all") {
    label.textContent = "все серверы памяти · объединённо";
    return;
  }
  const servers = state.memServers?.servers || [];
  const groups = state.memServers?.groups || {};
  if (groups[state.memScope]) {
    label.textContent = `группа «${state.memScope}» · ${groups[state.memScope].length} сервер(ов) · объединённо`;
  } else {
    const s = servers.find((x) => x.name === state.memScope);
    label.textContent = `сервер «${state.memScope}»${s?.url ? " · " + s.url : ""}`;
  }
}

function updateMemStatus(serversHealth) {
  const ok = (serversHealth || []).filter((s) => s.ok).length;
  const total = (serversHealth || []).length;
  const el = $("#mnemos-label");
  el.textContent = total ? `memory: ${ok}/${total} online` : "memory: —";
  $("#mnemos-status").style.borderColor = ok
    ? "var(--color-border-iris)" : "var(--color-error)";
}

// ------------------------------------------------------------------- rail
function renderRail() {
  const board = state.board;
  if (!board) return;

  // Specialist roster with avatars
  const roster = new Map();
  for (const t of board.tasks) {
    for (const s of t.specialists || []) {
      roster.set(s, (roster.get(s) || 0) + 1);
    }
  }
  const rosterEl = $("#roster");
  rosterEl.innerHTML = "";
  const sorted = [...roster.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted) {
    const initials = name.replace(/[^A-Za-zА-Яа-я ]/g, "").trim().split(/\s+/)
      .map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `
      <span class="avatar">${esc(initials)}</span>
      <span class="roster-name">${esc(name)}</span>
      <span class="roster-count">${n}</span>`;
    rosterEl.appendChild(row);
  }

  // Environments
  const envs = new Map();
  for (const t of board.tasks) envs.set(t.env, (envs.get(t.env) || 0) + 1);
  const envsEl = $("#envs");
  envsEl.innerHTML = "";
  for (const [env, n] of [...envs.entries()].sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement("span");
    chip.className = "env-chip";
    chip.innerHTML = `<b>${esc(ENV_LABELS[env] || env)}</b> · ${n}`;
    envsEl.appendChild(chip);
  }
}

// ------------------------------------------------------------- memory pulse
async function refreshPulse() {
  const el = $("#pulse");
  try {
    const scope = scopeParam();
    const qs = `project=mnemos-eyes&limit=8${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`;
    const data = await api(`/api/memories/pulse?${qs}`);
    renderPulse(data);
  } catch (err) {
    el.innerHTML = `<div class="column-empty">память недоступна: ${esc(err.message)}</div>`;
  }
}

function renderPulse(data) {
  const el = $("#pulse");
  el.innerHTML = "";
  if (!data.ok && !(data.items || []).length) {
    el.innerHTML = `<div class="column-empty">память недоступна</div>`;
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    const stats = data.store_stats || [];
    const line = stats
      .filter((s) => s.stats)
      .map((s) => `${esc(s.server)}: ${s.stats.memories_total} памятей`)
      .join(" · ");
    if (line) {
      const projects = stats.filter((s) => s.stats)
        .map((s) => `${esc(s.server)} → ${Object.entries(s.stats.by_project || {})
          .map(([p, n]) => `${esc(p)} (${n})`).join(", ") || "пусто"}`).join("<br/>");
      el.innerHTML = `<div class="column-empty">в выбранном источнике пока нет памятей проекта mnemos-eyes.<br/><br/>Живые хранилища:<br/>${projects}</div>`;
    } else {
      el.innerHTML = `<div class="column-empty">память молчит</div>`;
    }
    return;
  }
  const multi = state.memScope === "all"
    || Object.keys(state.memServers?.groups || {}).includes(state.memScope);
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "pulse-item";
    const tags = (item.tags || []).slice(0, 3)
      .map((t) => `<span class="pulse-tag">${esc(t)}</span>`).join("");
    const srv = multi && item.server
      ? `<span class="pulse-server" title="сервер памяти">${esc(item.server)}</span>` : "";
    div.innerHTML = `
      <div class="pulse-title">${esc(item.title || "")}</div>
      <div class="pulse-tags">${srv}${tags}</div>`;
    div.title = item.id ? `${item.id} · ${item.server || ""}` : "";
    el.appendChild(div);
  }
}

// ------------------------------------------------------------ stores rail
async function refreshStores() {
  const el = $("#stores");
  if (!state.memServers) { try { await loadMemServers(); } catch { /* ignore */ } }
  const servers = (state.memServers?.servers || []);
  el.innerHTML = "";
  if (!servers.length) {
    el.innerHTML = `<div class="column-empty">серверы не объявлены</div>`;
    return;
  }
  // health snapshot comes from /api/health (cheap enough) — reuse last healthLoop data via cache
  const cache = state._healthCache || [];
  for (const s of servers) {
    const h = cache.find((x) => x.name === s.name) || {};
    const row = document.createElement("div");
    row.className = "store-row";
    row.innerHTML = `
      <span class="dot ${h.ok ? "dot-on" : "dot-off"}"></span>
      <span class="store-name">${esc(s.name)}</span>
      <span class="store-total">${h.memories_total != null ? h.memories_total + " памятей" : (h.error ? "недоступен" : "…")}</span>
      <span class="store-group">${esc(s.group)}</span>`;
    row.title = `${s.url}${s.description ? " — " + s.description : ""}`;
    row.addEventListener("click", () => {
      state.memScope = s.name;
      localStorage.setItem(SCOPE_KEY, s.name);
      $("#mem-scope").value = s.name;
      updateScopeLabels();
      refreshPulse();
    });
    el.appendChild(row);
  }
}

// ------------------------------------------------------------------ drawer
let drawerTask = null;

async function openDrawer(t) {
  drawerTask = t;
  $("#drawer-col").textContent = COLUMN_TITLES[t.col] || t.col;
  $("#drawer-title").textContent = t.title;
  $("#drawer-summary").textContent = t.summary || "";
  $("#drawer-spec").textContent = t.spec || "";
  $("#spec-section").hidden = !t.spec;

  const meta = $("#drawer-meta");
  meta.innerHTML = `
    <span class="chip chip-agent">⚒ ${esc(t.agents.join(", ") || "—")}</span>
    <span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env)}</span>
    ${(t.specialists || []).map((s) => `<span class="chip chip-spec">${esc(s)}</span>`).join("")}
    ${(t.mnemos_tags || []).map((s) => `<span class="chip">${esc(s)}</span>`).join("")}`;

  const memEl = $("#drawer-memories");
  memEl.innerHTML = `<div class="column-empty">загрузка памяти…</div>`;
  showDrawer();
  try {
    const scope = scopeParam();
    const url = `/api/tasks/${encodeURIComponent(t.id)}/memories${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`;
    const resolved = (t.memory_ids || []).length ? await api(url) : { items: {}, unresolved: [], sources: {} };
    const searchHtml = await memorySearchWidget(t);
    if (drawerTask !== t) return;
    memEl.innerHTML = "";
    for (const mid of t.memory_ids || []) {
      const m = resolved.items[mid];
      const card = m ? memoryCard(m) : unresolvedCard(mid, resolved);
      const src = m && resolved.sources?.[mid];
      if (src) {
        const badge = document.createElement("div");
        badge.className = "memory-provenance";
        badge.innerHTML = `<span class="pulse-server">сервер: ${esc(src)}</span>`;
        card.insertBefore(badge, card.firstChild);
      }
      memEl.appendChild(card);
    }
    memEl.insertAdjacentHTML("beforeend", searchHtml);
    wireMemSearch(memEl, t);
  } catch (err) {
    memEl.innerHTML = `<div class="column-empty">память недоступна: ${esc(err.message)}</div>`;
  }
}

function memoryCard(m) {
  const div = document.createElement("div");
  div.className = "memory-card";
  const tags = (m.tags || []).map((t) => `<span class="pulse-tag">${esc(t)}</span>`).join("");
  div.innerHTML = `
    <div class="memory-provenance">
      <span class="memory-dot" title="provenance"></span>
      <span>${esc(m.status || "")}</span>
      <span>${esc((m.created_at || "").slice(0, 10))}</span>
    </div>
    <div class="memory-title">${esc(m.title || "")}</div>
    <div class="memory-excerpt">${esc(m.excerpt || "")}</div>
    <div class="memory-tags">${tags}</div>`;
  return div;
}

function unresolvedCard(mid, resolved) {
  const u = (resolved.unresolved || []).find((u) => u.id === mid);
  const div = document.createElement("div");
  div.className = "memory-card unresolved";
  div.innerHTML = `
    <div class="memory-provenance"><span>◉ память не найдена</span></div>
    <div class="memory-excerpt">${esc(mid)}${u ? ` · HTTP ${u.status}` : ""}</div>`;
  return div;
}

function memorySearchWidget(t) {
  return Promise.resolve(`
    <div class="mem-search">
      <input type="search" placeholder="найти память и привязать…" aria-label="поиск памяти" />
      <button type="button">искать</button>
    </div>
    <div class="mem-hits"></div>`);
}

function wireMemSearch(memEl, t) {
  const input = $(".mem-search input", memEl);
  const btn = $(".mem-search button", memEl);
  const hits = $(".mem-hits", memEl);
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    hits.innerHTML = `<div class="column-empty">поиск…</div>`;
    try {
      const scope = scopeParam();
      const scopeQ = scope ? `&scope=${encodeURIComponent(scope)}` : "";
      const data = await api(`/api/mnemos/search?q=${encodeURIComponent(q)}&limit=6${scopeQ}`);
      hits.innerHTML = "";
      for (const r of (data.results || [])) {
        const row = document.createElement("div");
        row.className = "mem-hit";
        row.innerHTML = `
          <span class="mem-hit-title">${esc(r.title || (r.content || "").slice(0, 70))}</span>
          <span class="mem-hit-server">${esc(r.server || "")}</span>
          <span class="mem-hit-score">${typeof r.score === "number" ? r.score.toFixed(3) : ""}</span>
          <button type="button">+</button>`;
        $("button", row).addEventListener("click", async () => {
          const ids = new Set(t.memory_ids || []);
          ids.add(r.id);
          t.memory_ids = [...ids];
          try {
            await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
              method: "PATCH",
              body: JSON.stringify({ memory_ids: t.memory_ids }),
            });
            row.remove();
            const scope2 = scopeParam();
            const resolved = await api(`/api/tasks/${encodeURIComponent(t.id)}/memories${scope2 ? `?scope=${encodeURIComponent(scope2)}` : ""}`);
            const m = resolved.items[r.id];
            if (m) memEl.insertBefore(memoryCard(m), $(".mem-search", memEl));
          } catch (err) { console.error(err); }
        });
        hits.appendChild(row);
      }
      if (!hits.children.length) {
        hits.innerHTML = `<div class="column-empty">ничего не найдено${(data.errors || []).length ? " · " + esc(data.errors.map((e) => `${e.server}: ${e.status}`).join(", ")) : ""}</div>`;
      }
    } catch (err) {
      hits.innerHTML = `<div class="column-empty">${esc(err.message)}</div>`;
    }
  };
  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
}

function showDrawer() {
  const d = $("#drawer"), b = $("#drawer-backdrop");
  b.hidden = false;
  d.hidden = false;
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
}
function closeDrawer() {
  const d = $("#drawer"), b = $("#drawer-backdrop");
  b.classList.remove("open");
  d.classList.remove("open");
  drawerTask = null;
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 260);
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ------------------------------------------------------------------ live
function setConn(kind, label) {
  const dot = $("#conn-dot");
  dot.className = `dot ${kind}`;
  $("#conn-label").textContent = label;
}

function setMnemos(ok, label) {
  $("#mnemos-label").textContent = `mnemos: ${label}`;
  $("#mnemos-status").style.borderColor = ok
    ? "var(--color-border-iris)" : "var(--color-error)";
}

async function healthLoop() {
  try {
    const h = await api("/api/health");
    state._healthCache = h.servers || [];
    updateMemStatus(h.servers);
    const anyOk = (h.servers || []).some((s) => s.ok);
    setMnemos(anyOk, anyOk ? "ok" : "down");
  } catch { setMnemos(false, "unreachable"); }
}

function connectSSE() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/events");
  state.es = es;
  es.onopen = () => setConn("dot-on", "live");
  es.onerror = () => setConn("dot-wait", "reconnecting…");
  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.kind === "hello") return;
    if (ev.kind === "task.moved" || ev.kind === "task.created"
        || ev.kind === "task.updated" || ev.kind === "task.deleted") {
      refreshBoard();
    }
  };
}

// ------------------------------------------------------------------ theme
const THEME_KEY = "mnemos-eyes:theme";
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "dark";
  applyTheme(cur === "dark" ? "light" : "dark");
});
applyTheme(localStorage.getItem(THEME_KEY)
  || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

// ------------------------------------------------------------------ boot
(async function boot() {
  connectSSE();
  await refreshBoard();
  await loadMemServers().catch(() => {});
  refreshPulse();
  refreshStores();
  healthLoop();
  setInterval(healthLoop, 30000);
  setInterval(refreshPulse, 60000);
})();