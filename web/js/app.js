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

// ------------------------------------------------------------- filters
const filter = { text: "", project: "", agent: "", env: "", tag: "" };

async function refreshBoard() {
  state.board = await api("/api/board");
  renderBoard();
  renderRail();
  refreshFilterOptions();
}

function taskMatches(t) {
  if (filter.project && t.project !== filter.project
      && !(t.mnemos_tags || []).includes("project:" + filter.project)) return false;
  if (filter.agent && !(t.agents || []).includes(filter.agent)) return false;
  if (filter.env && t.env !== filter.env) return false;
  if (filter.tag
      && !(t.mnemos_tags || []).includes(filter.tag)
      && !(t.specialists || []).includes(filter.tag)
      && !(t.agents || []).includes(filter.tag)) return false;
  if (filter.text) {
    const hay = `${t.id} ${t.title} ${t.summary} ${t.spec} ${(t.agents||[]).join(" ")} ${(t.specialists||[]).join(" ")} ${(t.mnemos_tags||[]).join(" ")}`.toLowerCase();
    if (!hay.includes(filter.text.toLowerCase())) return false;
  }
  return true;
}

function refreshFilterOptions() {
  const tasks = state.board?.tasks || [];
  const fill = (sel, values, label) => {
    const el = $(sel);
    const cur = el.value;
    const uniq = [...new Set(values.filter(Boolean))].sort();
    el.innerHTML = `<option value="">${label}: все</option>`
      + uniq.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (uniq.includes(cur)) el.value = cur;
  };
  fill("#f-project", tasks.map((t) => t.project).filter(Boolean), "проект");
  fill("#f-agent", tasks.flatMap((t) => t.agents || []), "агент");
  fill("#f-env", [...new Set(tasks.map((t) => t.env))], "среда");
  fill("#f-tag", tasks.flatMap((t) => t.mnemos_tags || []), "тег");
}

// ------------------------------------------------- tags & card helpers
function tagClass(tag) {
  if (tag.startsWith("project:")) return "tag-project";
  if (tag.startsWith("agent:")) return "tag-agent";
  if (tag.startsWith("@")) return "tag-agent";
  if (tag.startsWith("mnemos:")) return "tag-type";
  if (tag.startsWith("domain:")) return "tag-domain";
  return "tag-other";
}

function tagChip(tag) {
  return `<span class="chip tagchip ${tagClass(tag)}" data-tag="${esc(tag)}">${esc(tag)}</span>`;
}

function ageOf(dateStr) {
  if (!dateStr) return "";
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return days + " дн.";
  return Math.floor(days / 30) + " мес.";
}

function miniAvatars(agents) {
  return (agents || []).slice(0, 3).map((a) => {
    const ini = a.replace(/[^a-z-]/g, "").split("-").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
    return `<span class="mini-avatar" data-agent="${esc(a)}" title="активность агента ${esc(a)}">${esc(ini)}</span>`;
  }).join("");
}

function taskCard(t) {
  const card = document.createElement("article");
  card.className = "task";
  card.draggable = true;
  card.dataset.id = t.id;
  card.style.setProperty("--i", String(Math.floor(Math.random() * 5)));

  const chips = [];
  chips.push(`<span class="chip chip-env" title="среда исполнения">${esc(ENV_LABELS[t.env] || t.env)}</span>`);
  if ((t.memory_ids || []).length) {
    chips.push(`<span class="chip chip-mem" title="связанные памяти mnemos">◉ ${t.memory_ids.length}</span>`);
  }

  const allTags = [...(t.mnemos_tags || []), ...(t.specialists || [])];
  const cardTags = allTags.slice(0, 4);
  const more = allTags.length - cardTags.length;
  const proj = t.project || (t.mnemos_tags || []).find((x) => x.startsWith("project:"))?.slice(8) || "";

  card.innerHTML = `
    <div class="task-top">
      <span class="task-id">${esc(t.id)}</span>
      ${proj ? `<span class="chip tagchip tag-project" data-tag="project:${esc(proj)}" title="проект">${esc(proj)}</span>` : ""}
      <span class="task-age" title="обновлено ${esc(t.updated_at || "")}">${esc(ageOf(t.updated_at))}</span>
    </div>
    <h3 class="task-title">${esc(t.title)}</h3>
    <div class="task-chips">${chips.join("")}</div>
    <div class="task-tagrow">${cardTags.map((tag) => tagChip(tag)).join("")}
      ${more > 0 ? `<span class="chip tagchip tag-other">+${more}</span>` : ""}
    </div>
    <div class="task-foot">
      <span class="task-agents">${miniAvatars(t.agents)}</span>
      <span class="chip chip-agent" title="агент-исполнитель" data-agent="${esc((t.agents || [])[0] || "")}">⚒ ${esc(t.agents.join(", ") || "—")}</span>
    </div>`;

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/task-id", t.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    taskContextMenu(e, t);
  });
  card.addEventListener("click", (e) => {
    // tag/agent cross-links are owned by the single delegated document
    // listener (see "cross-links" section) — don't open the task for them
    const link = e.target.closest(".tagchip[data-tag], [data-agent]");
    if (link && (link.dataset.tag || link.dataset.agent)) return;
    openTask(t.id);
  });
  return card;
}

function wireFilters() {
  $("#f-text").addEventListener("input", (e) => { filter.text = e.target.value.trim(); renderBoard(); });
  for (const [id, key] of [["#f-project","project"],["#f-agent","agent"],["#f-env","env"],["#f-tag","tag"]]) {
    $(id).addEventListener("change", (e) => {
      filter[key] = e.target.value;
      e.target.classList.toggle("active", !!e.target.value);
      renderBoard();
    });
  }
  $("#f-clear").addEventListener("click", () => {
    Object.assign(filter, { text: "", project: "", agent: "", env: "", tag: "" });
    $("#f-text").value = "";
    for (const id of ["#f-project","#f-agent","#f-env","#f-tag"]) { $(id).value = ""; $(id).classList.remove("active"); }
    renderBoard();
  });
}

function renderBoard() {
  const board = state.board;
  if (!board) return;
  const el = $("#board");
  el.innerHTML = "";
  let visibleTotal = 0;
  for (const col of board.columns) {
    const all = board.tasks.filter((t) => t.col === col);
    const tasks = all.filter(taskMatches);
    visibleTotal += tasks.length;
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.col = col;
    const filtered = visibleTotal >= 0 && (filter.text || filter.project || filter.agent || filter.env || filter.tag);
    colEl.innerHTML = `
      <div class="column-head">
        <span class="column-title">${esc(COLUMN_TITLES[col] || col)}</span>
        <span class="column-count">${filter && (filter.text || filter.project || filter.agent || filter.env || filter.tag) ? tasks.length + "/" + all.length : tasks.length}</span>
      </div>
      <div class="column-body"></div>`;
    const body = $(".column-body", colEl);
    if (!tasks.length) {
      body.innerHTML = `<div class="column-empty">${all.length ? "скрыто фильтром" : "пусто"}</div>`;
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
  const fc = $("#f-count"), fb = $("#f-clear");
  const any = filter.text || filter.project || filter.agent || filter.env || filter.tag;
  fc.textContent = any ? `${visibleTotal} из ${board.tasks.length}` : "";
  fb.hidden = !any;
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
    if (state.activeTask) openTask(state.activeTask.id);
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

  // AGENTS (harnesses) vs SPECIALISTS — two distinct groups, never mixed.
  const agents = new Map();
  const specialists = new Map();
  for (const t of board.tasks) {
    for (const a of t.agents || []) agents.set(a, (agents.get(a) || 0) + 1);
    for (const s of t.specialists || []) specialists.set(s, (specialists.get(s) || 0) + 1);
  }

  const agentsEl = $("#agents");
  agentsEl.innerHTML = "";
  for (const [name, n] of [...agents.entries()].sort((a, b) => b[1] - a[1])) {
    const done = board.tasks.filter((t) => (t.agents || []).includes(name) && (t.col === "done" || t.col === "resolved")).length;
    const wip = board.tasks.filter((t) => (t.agents || []).includes(name) && t.col === "in-progress").length;
    const row = document.createElement("div");
    row.className = "person-row";
    row.title = "клик — активность и статистика агента";
    row.innerHTML = `
      <span class="mini-avatar" style="cursor:pointer">⚒</span>
      <span class="person-info"><span class="person-name">${esc(name)}</span>
        <span class="person-stat">задач: ${n} · в работе: ${wip} · готово: ${done}</span></span>
      <span class="roster-count">${n}</span>`;
    row.addEventListener("click", () => openAgentActivity(name));
    agentsEl.appendChild(row);
  }

  const rosterEl = $("#roster");
  rosterEl.innerHTML = "";
  for (const [name, n] of [...specialists.entries()].sort((a, b) => b[1] - a[1])) {
    const initials = name.replace(/[^A-Za-zА-Яа-я ]/g, "").trim().split(/\s+/)
      .map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
    const row = document.createElement("div");
    row.className = "person-row";
    row.title = "клик — карточка специалиста (инструкции, скиллы, refine)";
    row.innerHTML = `
      <span class="avatar">${esc(initials)}</span>
      <span class="person-info"><span class="person-name">${esc(name)}</span>
        <span class="person-stat">задач: ${n}</span></span>
      <span class="roster-count">${n}</span>`;
    row.addEventListener("click", () => openSpecialistModal(name));
    rosterEl.appendChild(row);
  }

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

async function refreshPulse() {
  const el = $("#pulse");
  try {
    const scope = scopeParam();
    const qs = `limit=12${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`;
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
    const parts = stats.filter((s) => s.stats)
      .map((s) => `${esc(s.server)}: ${s.stats.memories_total} памятей (${Object.keys(s.stats.by_project || {}).join(", ") || "пусто"})`);
    el.innerHTML = `<div class="column-empty">${parts.length ? "нет свежих памятей проекта mnemos-eyes.<br/><br/>" + parts.join("<br/>") : "память молчит"}</div>`;
    return;
  }

  // group by project (from tags), keep recency inside groups
  const byProject = new Map();
  for (const it of items) {
    const proj = (it.tags || []).find((t) => t.startsWith("project:"))?.slice(8) || "без проекта";
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(it);
  }
  const multi = state.memScope === "all"
    || Object.keys(state.memServers?.groups || {}).includes(state.memScope);
  for (const [proj, list] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const box = document.createElement("div");
    box.className = "pulse-project";
    const head = document.createElement("div");
    head.className = "pulse-proj-head";
    head.innerHTML = `<span class="caret">▶</span>
      <span class="chip tagchip tag-project" style="cursor:default">${esc(proj)}</span>
      <span class="pulse-proj-count">${list.length}</span>`;
    head.title = "развернуть сессии проекта";
    const body = document.createElement("div");
    body.className = "pulse-proj-body";
    for (const item of list) {
      const div = document.createElement("div");
      div.className = "pulse-item";
      const tags = (item.tags || []).filter((t) => !t.startsWith("project:")).slice(0, 4)
        .map((t) => tagChip(t)).join("");
      const srv = multi && item.server
        ? `<span class="pulse-server">${esc(item.server)}</span>` : "";
      div.innerHTML = `
        <div class="pulse-title">${esc(item.title || "")}</div>
        <div class="pulse-tags">${srv}${tags}</div>`;
      div.title = item.id ? `${item.id} · ${item.server || ""} · ПКМ — действия` : "";
      div.addEventListener("click", () => openMemoryCard(item));
      div.addEventListener("contextmenu", (e) => memoryContextMenu(e, item));
      body.appendChild(div);
    }
    head.addEventListener("click", () => box.classList.toggle("open"));
    box.appendChild(head);
    box.appendChild(body);
    el.appendChild(box);
  }
  // no project expanded by default — collapsed groups, first 4 sessions
  // visible when expanded (body max-height + own scroll)
}

// ── session/memory card modal (pulse items) ─────────────────────
async function openMemoryCard(item) {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  ddRemember("знание", item.title || item.id, "память mnemos · " + (item.server || ""), () => openMemoryCard(item));
  $("#dd-kind").textContent = "знание";
  $("#dd-title").textContent = item.title || item.id;
  $("#dd-sub").textContent = "память mnemos · " + (item.server || "");
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка…</div>`;
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  try {
    const r = await api(`/api/memories/item/${encodeURIComponent(item.id)}`);
    const m = r.memory;
    if (!r.ok) { $("#dd-body").innerHTML = `<div class="column-empty">${esc(r.error)}</div>`; return; }
    $("#dd-body").innerHTML = `
      <div class="memory-card" style="margin-bottom:12px">
        <div class="memory-provenance">
          <span class="pulse-server">${esc(r.server)}</span>
          <span>${esc(m.status || "")}</span>
          <span>${esc(m.memory_type || "")}</span>
          <span>${esc((m.created_at || "").slice(0, 10))}</span>
        </div>
        <div class="memory-title">${esc(m.title || "(без заголовка)")}</div>
        <div class="memory-excerpt" style="white-space:pre-wrap; max-height:300px; overflow-y:auto">${esc(m.content || "")}</div>
        <div class="memory-tags">${(m.tags || []).map((t) => tagChip(t)).join("")}</div>
      </div>
      <div class="drawer-meta">
        <span class="chip tagchip tag-project" data-tag="project:${esc(m.project || "")}" style="${m.project ? "" : "display:none"}">◈ ${esc(m.project || "")}</span>
        <span class="chip tagchip tag-agent" data-agent="${esc(m.agent || "")}" style="${m.agent ? "" : "display:none"}">⚒ ${esc(m.agent || "")}</span>
        ${m.source ? `<span class="chip">источник: ${esc(m.source)}</span>` : ""}
        ${m.updated_at ? `<span class="chip">обновлено ${esc(m.updated_at.slice(0, 10))}</span>` : ""}
      </div>`;
  } catch (err) {
    $("#dd-body").innerHTML = `<div class="column-empty">${esc(err.message)}</div>`;
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
    row.title = `${s.url}${s.description ? " — " + s.description : ""} · ПКМ — быстрые действия`;
    row.addEventListener("click", () => openServerModal(s.name));
    row.addEventListener("contextmenu", (e) => storeContextMenu(e, { ...s }));
    el.appendChild(row);
  }
}

// ------------------------------------------------------------------ task modal
// (see openTask / closeTask)

let state_active = null;

async function openTask(taskId) {
  const t = (state.board?.tasks || []).find((x) => x.id === taskId);
  if (!t) return;
  state.activeTask = t;
  $("#modal-col").textContent = COLUMN_TITLES[t.col] || t.col;
  $("#modal-id").textContent = t.id;
  $("#modal-title").textContent = t.title;
  $("#modal-summary").textContent = t.summary || "";
  $("#modal-spec").textContent = t.spec || "";
  $("#modal-spec-section").hidden = !t.spec;

  const meta = $("#modal-meta");
  meta.innerHTML = `
    <div class="drawer-meta">
      ${(t.project ? `<span class="chip tagchip tag-project" data-tag="project:${esc(t.project)}" title="проект">◈ ${esc(t.project)}</span>` : "")}
      <span class="chip chip-agent" data-agent="${esc((t.agents || [])[0] || "")}" title="активность агента">⚒ ${esc(t.agents.join(", ") || "—")}</span>
      <span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env)}</span>
    </div>
    <div class="drawer-meta" style="margin-top:8px">
      ${(t.specialists || []).map((s) => `<span class="chip chip-spec">${esc(s)}</span>`).join("")}
    </div>
    <div class="task-tagrow" style="margin-top:8px">
      ${(t.mnemos_tags || []).map((tag) => tagChip(tag)).join("")}
    </div>`;

  // cross-navigation inside the modal is handled by the delegated
  // document click listener (tag/agent chips)

  const memEl = $("#modal-memories");
  memEl.innerHTML = `<div class="column-empty">загрузка памяти…</div>`;
  // reset tabs to Overview
  setTaskTab("overview");
  showTaskModal();
  try {
    const scope = scopeParam();
    const url = `/api/tasks/${encodeURIComponent(t.id)}/memories${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`;
    const resolved = (t.memory_ids || []).length ? await api(url) : { items: {}, unresolved: [], sources: {} };
    const searchHtml = await memorySearchWidget(t);
    if (state.activeTask !== t) return;
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
    // cross-navigation: linked memory cards → overlay with back-to-task
    for (const card of memEl.querySelectorAll(".memory-card")) {
      const title = card.querySelector(".memory-title");
      if (title) {
        title.style.cursor = "pointer";
        title.title = "открыть карточку памяти";
        card.addEventListener("click", (e) => {
          if (e.target.closest(".mem-search") || e.target.closest("button")) return;
          const id = (card.dataset.mid || "").trim();
          if (id) openMemoryFromTask(id, t);
        });
      }
    }
  } catch (err) {
    memEl.innerHTML = `<div class="column-empty">память недоступна: ${esc(err.message)}</div>`;
  }
  loadTaskHistory(t);
}

function openMemoryFromTask(memoryId, originTask) {
  rememberModal(() => openTask(originTask.id));
  openMemoryCard({ id: memoryId, title: "", server: "" });
}

function setTaskTab(name) {
  for (const t of document.querySelectorAll(".mtab")) {
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for (const sec of document.querySelectorAll(".tsec")) {
    sec.classList.toggle("active", sec.dataset.sec === name);
  }
}

async function loadTaskHistory(t) {
  const holder = $("#modal-history");
  holder.innerHTML = `<div class="column-empty">загрузка истории…</div>`;
  try {
    const h = await api(`/api/tasks/${encodeURIComponent(t.id)}/history`);
    if (state.activeTask !== t) return;
    const items = [
      ...h.events.map((e) => ({ ...e, kind: "board" })),
      ...h.memories.map((m) => ({ ...m, kind: "memory" })),
    ].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
    if (!h.events.length && !h.memories.length) {
      holder.innerHTML = `<div class="column-empty">событий и чекпоинтов пока нет — история появится по мере работы над задачей</div>`;
      return;
    }
    holder.innerHTML = `<div class="timeline">${items.map(tlItem).join("")}</div>`;
  } catch (err) {
    holder.innerHTML = `<div class="column-empty">история недоступна: ${esc(err.message)}</div>`;
  }
}

const KIND_LABEL = {
  "task.created": "создана",
  "task.moved": "перемещена",
  "task.updated": "обновлена",
  "task.deleted": "удалена",
  "server.added": "хранилище подключено",
};

function tlItem(x) {
  const cls = x.kind === "memory" ? "memory" : "board";
  const badge = x.kind === "memory"
    ? `<span class="tl-badge memory">${esc((x.source || "memory").split(" · ")[0])}</span>`
    : `<span class="tl-badge board">${esc(KIND_LABEL[x.title] || "борд")}</span>`;
  const title = x.kind === "memory" ? x.title : (KIND_LABEL[x.title] || x.title);
  return `
    <div class="tl-item ${cls}">
      <div class="tl-head">
        <span class="tl-ts">${esc((x.ts || "").replace("T", " ").slice(0, 16))}</span>
        <span class="tl-title">${esc(title)}</span>
        ${badge}
      </div>
      ${x.detail ? `<div class="tl-detail">${esc(x.detail)}</div>` : ""}
    </div>`;
}

// ── cross-links: one delegated document click listener ─────────────
// Cards and modal bodies are re-rendered constantly: per-element handlers
// die with their nodes, and re-wiring persistent roots (#modal-meta,
// #dd-body) stacked duplicate listeners. Tag/agent chips therefore go
// through a single document-level listener, scoped to the containers that
// render cross-link chips — pulse/roster rows keep their whole-row clicks.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#board, #modal-meta, #dd-body")) return;
  const tag = e.target.closest(".tagchip[data-tag]");
  if (tag && tag.dataset.tag) { openTagDrill(tag.dataset.tag); return; }
  const ag = e.target.closest("[data-agent]");
  if (ag && ag.dataset.agent) openAgentActivity(ag.dataset.agent);
});

function memoryCard(m) {
  const div = document.createElement("div");
  div.className = "memory-card";
  div.dataset.mid = m.id || "";
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
  div.dataset.mid = mid;
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

const modalHistory = []; // stack of {open} functions to restore previous modal

function showTaskModal() {
  const d = $("#task-modal"), b = $("#modal-backdrop");
  b.hidden = false;
  d.hidden = false;
  modalOpened("task-modal", closeTaskModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
}
function rememberModal(reopenFn) {
  modalHistory.push(reopenFn);
  const b = $("#modal-back");
  if (b) b.hidden = modalHistory.length === 0;
}
function closeTaskModal() {
  const d = $("#task-modal"), b = $("#modal-backdrop");
  b.classList.remove("open");
  d.classList.remove("open");
  modalClosed("task-modal");
  state.activeTask = null;
  modalHistory.length = 0;
  const bb = $("#modal-back"); if (bb) bb.hidden = true;
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
}
if (document.querySelector("#modal-back")) document.querySelector("#modal-back").addEventListener("click", () => {
  const reopen = modalHistory.pop();
  const b = $("#modal-back");
  if (b) b.hidden = modalHistory.length === 0;
  if (reopen) reopen();
});
$("#modal-close").addEventListener("click", closeTaskModal);
$("#modal-backdrop").addEventListener("click", closeTaskModal);

// ── modal stack: single Escape handler pops only the topmost modal ──
// Modals layer (task card → dd overlay → …). Every open/close funnels
// through modalOpened/modalClosed, so Esc closes the stack top only and
// never wipes all open modals at once.
const modalStack = []; // {id, close} — topmost last
function modalOpened(id, closeFn) {
  const i = modalStack.findIndex((m) => m.id === id);
  if (i !== -1) modalStack.splice(i, 1); // re-open lifts the modal to the top
  modalStack.push({ id, close: closeFn });
}
function modalClosed(id) {
  const i = modalStack.findIndex((m) => m.id === id);
  if (i !== -1) modalStack.splice(i, 1);
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const top = modalStack[modalStack.length - 1];
  if (top) top.close();
});

// --------------------------------------------------------- server management
let srvMode = "view"; // view | add
let srvName = "";

async function openServerModal(name) {
  srvMode = name ? "view" : "add";
  srvName = name || "";
  const d = $("#srv-modal"), b = $("#srv-backdrop");
  $("#srv-name").value = name;
  $("#srv-name").disabled = !!name;
  $("#srv-url").value = "";
  $("#srv-token").value = "";
  // Server API answers 422 for raw-token refs — only env:/file: are offered.
  $("#srv-token").placeholder = name ? "оставить пустым — без изменения" : "env:VAR / file:/path";
  $("#srv-desc-input").value = "";
  $("#srv-note").textContent = "";
  $("#srv-history").innerHTML = "";
  if (name) {
    const s = (state.memServers?.servers || []).find((x) => x.name === name);
    if (s) {
      $("#srv-url").value = s.url;
      $("#srv-desc-input").value = s.description || "";
    }
    $("#srv-title").textContent = `Хранилище «${name}»`;
    $("#srv-desc").textContent = s?.description || "";
    $("#srv-state").textContent = s?.state || "?";
    $("#srv-toggle").textContent = s?.enabled ? "Отключить" : "Включить";
    // live stats + history
    try {
      const st = await api(`/api/memories/servers/${encodeURIComponent(name)}/stats`);
      const row = (st.stores || [])[0]?.stats;
      $("#srv-stats").innerHTML = row ? `
        <span class="srv-stat-chip">памятей: <b>${row.memories_total ?? "—"}</b></span>
        <span class="srv-stat-chip">версия: <b>${esc(row.version || "—")}</b></span>
        <span class="srv-stat-chip">проекты: <b>${Object.keys(row.by_project || {}).length}</b></span>
        <span class="srv-stat-chip">latency: <b>${s?.latency_ms ?? "—"} ms</b></span>`
        : `<span class="srv-stat-chip">статистика недоступна</span>`;
    } catch {
      $("#srv-stats").innerHTML = `<span class="srv-stat-chip">статистика недоступна</span>`;
    }
    try {
      const h = await api(`/api/memories/servers/${encodeURIComponent(name)}/history`);
      $("#srv-history").innerHTML = (h.history || []).map((x) =>
        `<div class="srv-history-item"><ts>${esc((x.ts || "").slice(5, 16))}</ts><span>${esc(x.action)}</span><span>${esc(x.detail || "")}</span></div>`
      ).join("") || `<div class="column-empty">событий пока нет</div>`;
    } catch { /* ignore */ }
  } else {
    $("#srv-title").textContent = "Подключить хранилище";
    $("#srv-desc").textContent = "Новый сервер памяти mnemos (в борде; сам стор не создаётся).";
    $("#srv-state").textContent = "new";
    $("#srv-stats").innerHTML = "";
  }
  b.hidden = false;
  d.hidden = false;
  modalOpened("srv-modal", closeSrvModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
}

function closeSrvModal() {
  const d = $("#srv-modal"), b = $("#srv-backdrop");
  b.classList.remove("open");
  d.classList.remove("open");
  modalClosed("srv-modal");
  srvName = "";
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
}
$("#srv-close").addEventListener("click", closeSrvModal);
$("#srv-backdrop").addEventListener("click", closeSrvModal);

function srvAction(action) {
  return api(`/api/memories/servers/${encodeURIComponent(srvName)}/action`, {
    method: "POST", body: JSON.stringify({ action }),
  });
}

$("#srv-save").addEventListener("click", async () => {
  const body = {
    name: $("#srv-name").value.trim(),
    url: $("#srv-url").value.trim(),
    group_name: currentGroupName(),
    description: $("#srv-desc-input").value.trim(),
    token_ref: $("#srv-token").value.trim(),
  };
  try {
    if (srvMode === "add") {
      await api("/api/memories/servers", { method: "POST", body: JSON.stringify(body) });
    } else {
      const patch = { ...body, name: srvName };
      await api(`/api/memories/servers/${encodeURIComponent(srvName)}`, { method: "PATCH", body: JSON.stringify(patch) });
    }
    await loadMemServers();
    refreshStores();
    renderGroups();
    closeSrvModal(); // применено и закрыто — note не нужен
  } catch (err) {
    $("#srv-note").textContent = "Ошибка: " + err.message; // окно остаётся открытым для правки
  }
});

$("#srv-test").addEventListener("click", async () => {
  $("#srv-note").textContent = "проверка…";
  try {
    const r = await srvAction("test");
    $("#srv-note").textContent = r.ok
      ? `ok · ${r.probe.latency_ms} ms${r.probe.auth ? "" : " (без токена)"}`
      : `ошибка: ${r.probe.error || ("HTTP " + r.probe.http_status)}`;
  } catch (err) { $("#srv-note").textContent = "Ошибка: " + err.message; }
});

$("#srv-reload").addEventListener("click", async () => {
  $("#srv-note").textContent = "перезагрузка…";
  try {
    const r = await srvAction("reload");
    $("#srv-note").textContent = r.ok ? "Перезагружено, связь в порядке." : "Связь не восстановилась.";
    await loadMemServers(); refreshStores();
  } catch (err) { $("#srv-note").textContent = "Ошибка: " + err.message; }
});

$("#srv-sync").addEventListener("click", async () => {
  $("#srv-note").textContent = "синхронизация…";
  try {
    const r = await srvAction("sync");
    $("#srv-note").textContent = r.ok
      ? `Синк ok: ${r.stats?.memories_total ?? "?"} памятей.`
      : "Синк не прошёл — хранилище недоступно.";
    await loadMemServers(); refreshStores();
  } catch (err) { $("#srv-note").textContent = "Ошибка: " + err.message; }
});

$("#srv-toggle").addEventListener("click", async () => {
  const s = (state.memServers?.servers || []).find((x) => x.name === srvName);
  try {
    await srvAction(s?.enabled ? "disable" : "enable");
    await loadMemServers(); refreshStores();
    closeSrvModal();
  } catch (err) { $("#srv-note").textContent = "Ошибка: " + err.message; }
});

$("#srv-delete").addEventListener("click", async () => {
  // из борда, не физически — действие необратимо для конфигурации борда
  if (!confirm(`Удалить хранилище «${srvName}» из борда?`)) return;
  try {
    await api(`/api/memories/servers/${encodeURIComponent(srvName)}`, { method: "DELETE" });
    closeSrvModal();
    await loadMemServers(); refreshStores(); renderGroups();
  } catch (err) { $("#srv-note").textContent = "Ошибка: " + err.message; }
});

$("#srv-add").addEventListener("click", () => openServerModal(null));
$("#grp-add").addEventListener("click", async () => {
  const name = prompt("Имя кластера памяти (латиницей, цифры, -):");
  if (!name) return;
  const title = prompt("Название кластера (отображаемое):", name) || name;
  try {
    await api("/api/memories/groups", {
      method: "POST",
      body: JSON.stringify({ name: name.toLowerCase(), title }),
    });
    await loadMemServers(); renderGroups();
  } catch (err) { alert("Ошибка: " + err.message); }
});

function currentGroupName() {
  // new servers join the currently viewed group, else 'default'
  if (state.memScope !== "all") {
    const groups = state.memServers?.groups || {};
    if (groups[state.memScope]) return state.memScope;
  }
  return "default";
}

function renderGroups() {
  const el = $("#groups");
  if (!el) return;
  el.innerHTML = "";
  const raw = state.memServers?.groups || {};
  // groups may be an array of {name, servers} or a name->[members] map
  const entries = Array.isArray(raw)
    ? raw.map((g) => [g.name, g.servers || []])
    : Object.entries(raw);
  const servers = state.memServers?.servers || [];
  for (const [name, members] of entries) {
    if (!members.length && name === "default") continue;
    const row = document.createElement("div");
    row.className = "group-row" + (state.memScope === name ? " active" : "");
    row.innerHTML = `
      <span class="group-glyph">⬡</span>
      <span class="group-name">${esc(name)}</span>
      <span class="group-servers">${members.length} хранилищ: ${esc(members.join(", "))}</span>`;
    row.title = `кластер: ${members.join(", ")} · клик — карточка · ПКМ — управление`;
    row.addEventListener("click", () => openGroupModal(name));
    row.addEventListener("contextmenu", (e) => {
      const g = (state.memServers?.groups || []).find((x) => x.name === name) || { name, servers: members };
      groupContextMenu(e, g);
    });
    el.appendChild(row);
  }
}

// ------------------------------------------------------------------ toasts
function toast(kind, title, message, ms = 4000) {
  let holder = document.querySelector("#toasts");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "toasts";
    document.body.appendChild(holder);
  }
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = `<span class="t-kind">${esc(kind === "ok" ? "выполнено" : kind === "err" ? "сбой" : "инфо")}</span>
    <b>${esc(title)}</b>${message ? `<div style="font-size:12px;color:var(--color-text-secondary);margin-top:2px">${esc(message)}</div>` : ""}`;
  holder.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
}

// --------------------------------------------------------- notifications
const notifState = { cat: "all", open: false };

async function refreshBell() {
  try {
    const d = await api("/api/notifications?limit=1");
    const badge = $("#bell-badge");
    if (d.unread > 0) { badge.hidden = false; badge.textContent = d.unread > 99 ? "99+" : d.unread; }
    else badge.hidden = true;
  } catch { /* board offline — bell stays as-is */ }
}

function renderNotifList(items) {
  const list = $("#notif-list");
  list.innerHTML = "";
  const filtered = notifState.cat === "all"
    ? items : items.filter((n) => n.category === notifState.cat);
  if (!filtered.length) {
    list.innerHTML = `<div class="column-empty">уведомлений нет</div>`;
    return;
  }
  for (const n of filtered) {
    const el = document.createElement("div");
    el.className = "notif-item " + n.category + (n.read ? "" : " unread");
    el.dataset.id = n.id;
    el.innerHTML = `
      <div style="min-width:0">
        <span class="n-cat">${esc(n.category === "work" ? "рабочее" : "система")}</span>
        <span class="n-title">${esc(n.title)}</span>
        ${n.message ? `<div class="n-msg">${esc(n.message)}</div>` : ""}
      </div>
      <span class="n-ts">${esc((n.ts || "").slice(5, 16).replace("T", " "))}</span>`;
    el.addEventListener("click", async () => {
      if (!n.read) {
        await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ id: n.id }) });
        el.classList.remove("unread");
        refreshBell();
      }
      if (n.task_id) {
        closeNotifPanel();
        const t = (state.board?.tasks || []).find((x) => x.id === n.task_id);
        if (t) openTask(t.id);
      }
    });
    list.appendChild(el);
  }
}

async function openNotifPanel() {
  notifState.open = true;
  $("#notif-panel").hidden = false;
  try {
    const d = await api("/api/notifications?limit=50");
    renderNotifList(d.items);
  } catch {
    $("#notif-list").innerHTML = `<div class="column-empty">не удалось загрузить</div>`;
  }
}
function closeNotifPanel() {
  notifState.open = false;
  $("#notif-panel").hidden = true;
}
$("#bell").addEventListener("click", () => notifState.open ? closeNotifPanel() : openNotifPanel());
document.addEventListener("click", (e) => {
  if (notifState.open && !e.target.closest("#notif-panel") && !e.target.closest("#bell")) closeNotifPanel();
});
for (const b of document.querySelectorAll(".ntab")) {
  b.addEventListener("click", async () => {
    for (const x of document.querySelectorAll(".ntab")) x.classList.toggle("active", x === b);
    notifState.cat = b.dataset.ncat;
    const d = await api("/api/notifications?limit=50");
    renderNotifList(d.items);
  });
}
$("#notif-read-all").addEventListener("click", async () => {
  await api("/api/notifications/read", { method: "POST", body: JSON.stringify({}) });
  refreshBell();
  openNotifPanel();
});

// ------------------------------------------------------------- archive
async function refreshArchiveTeaser() {
  try {
    const d = await api("/api/archive");
    $("#archive-count").textContent = d.count ? d.count + " в архиве" : "";
    const el = $("#archive-teaser");
    el.innerHTML = "";
    if (!d.count) { el.innerHTML = `<div class="column-empty" style="padding:8px">пусто</div>`; return; }
    const projects = Object.entries(d.projects).slice(0, 4);
    for (const [proj, tasks] of projects) {
      const link = document.createElement("div");
      link.className = "archive-link";
      link.innerHTML = `<b>${esc(proj)}</b><span>${tasks.length}</span>`;
      link.addEventListener("click", () => openArchiveModal());
      el.appendChild(link);
    }
    if (Object.keys(d.projects).length > 4) {
      const more = document.createElement("div");
      more.className = "archive-link";
      more.innerHTML = `<b>ещё ${Object.keys(d.projects).length - 4}…</b>`;
      more.addEventListener("click", () => openArchiveModal());
      el.appendChild(more);
    }
  } catch { /* ignore */ }
}

async function openArchiveModal() {
  let d;
  try { d = await api("/api/archive"); }
  catch (err) { toast("err", "Архив недоступен", err.message); return; }
  const modal = $("#dd-modal"), back = $("#dd-backdrop");
  $("#dd-kind").textContent = "архив";
  $("#dd-title").textContent = `Архив задач (${d.count})`;
  $("#dd-sub").textContent = "сгруппировано по проектам · клик по задаче — вернуть на доску";
  back.hidden = false; modal.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { back.classList.add("open"); modal.classList.add("open"); });

  const body = $("#dd-body");
  body.innerHTML = "";
  if (!Object.keys(d.projects).length) {
    body.innerHTML = `<div class="column-empty">архив пуст</div>`;
    return;
  }
  for (const [proj, tasks] of Object.entries(d.projects)) {
    const box = document.createElement("div");
    box.className = "pulse-project open";
    box.innerHTML = `
      <div class="pulse-proj-head">
        <span class="caret">▶</span>
        <span class="chip tagchip tag-project" style="cursor:default">${esc(proj)}</span>
        <span class="pulse-proj-count">${tasks.length}</span>
      </div>
      <div class="pulse-proj-body"></div>`;
    const inner = box.querySelector(".pulse-proj-body");
    for (const t of tasks) {
      const month = (t.updated_at || "").slice(0, 7);
      const item = document.createElement("div");
      item.className = "dd-item";
      item.dataset.id = t.id;
      item.innerHTML = `
        <div class="dd-item-title">${esc(t.id)} · ${esc(t.title)}</div>
        <div class="dd-item-meta">
          <span class="chip">${esc(COLUMN_TITLES[t.col] || t.col)}</span>
          <span class="chip">${esc(month || "")}</span>
          <span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env || "")}</span>
        </div>`;
      item.addEventListener("click", async () => {
        if (!confirm(`Вернуть ${t.id} на доску?`)) return;
        try {
          await api(`/api/tasks/${encodeURIComponent(t.id)}/unarchive`, { method: "POST" });
          toast("ok", `${t.id}: возвращена из архива`);
          closeDdModal();
          await refreshBoard(); refreshArchiveTeaser();
        } catch (err) { toast("err", "Не удалось вернуть", err.message); }
      });
      inner.appendChild(item);
    }
    box.querySelector(".pulse-proj-head").addEventListener("click", (e) => {
      if (e.target.closest(".dd-item")) return;
      box.classList.toggle("open");
    });
    body.appendChild(box);
  }
}

// memory items always open OVERLAY (never a new tab) — global style
function openMemoryOverlay(memoryId) {
  openMemoryCard({ id: memoryId, title: "", server: "" });
}

// ---------------------------------------------------- specialist card
// v1: профиль из памяти mnemos (role contract + skills) + refine-форма.
// refine → создаёт запись в памяти (agent:gcw-agent-architect) и таску
// «Refine: <специалист>» в колонке open — Архитектор Агентов подхватит.
// Кнопка «Коммит в GCW» активируется после генерации правок (v1: каркас
// git-интеграции; применённые патчи копируются в буфер + пишутся в память).

async function openSpecialistModal(name) {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  $("#dd-kind").textContent = "специалист";
  $("#dd-title").textContent = name;
  $("#dd-sub").textContent = "роль GCW · состав, статистика, refine-цикл";
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка профиля…</div>`;
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });

  // parallel: board stats, activity memories, composed profile (instructions/skills/…)
  const slug = name.replace("@GCW: ", "gcw-").replace(/\s+/g, "-").toLowerCase();
  const [actRes, profRes] = await Promise.allSettled([
    api(`/api/agents/${encodeURIComponent(slug)}/activity?limit=12`),
    api(`/api/specialists/profile?name=${encodeURIComponent(name)}`),
  ]);
  const memories = actRes.status === "fulfilled" ? (actRes.value.memories || []) : [];
  const profile = profRes.status === "fulfilled" ? profRes.value : null;

  const tasks = (state.board?.tasks || []).filter((t) => (t.specialists || []).includes(name));
  const done = tasks.filter((t) => t.col === "done" || t.col === "resolved").length;
  const wip = tasks.filter((t) => t.col === "in-progress").length;
  const blocked = tasks.filter((t) => t.col === "blocked").length;

  const sec = profile?.sections || {};
  const nInstr = (sec.instructions || []).length;
  const nSkills = (sec.skills || []).length;
  const nRules = (sec.rules || []).length;
  const nTrig = (sec.triggers || []).length;
  const nOther = (sec.other || []).length;
  const indexed = profile?.indexed;

  $("#dd-body").innerHTML = `
    <div class="dd-section">
      <h2 style="margin:0 0 8px">Состав специалиста<span class="dd-count">${indexed ? "индекс GCW в памяти" : "профиль не индексирован"}</span></h2>
      <div class="drawer-meta">
        <span class="srv-stat-chip">инструкции: <b>${nInstr}</b></span>
        <span class="srv-stat-chip">скиллы: <b>${nSkills}</b></span>
        <span class="srv-stat-chip">правила: <b>${nRules}</b></span>
        <span class="srv-stat-chip">триггеры: <b>${nTrig}</b></span>
        ${nOther ? `<span class="srv-stat-chip">прочее: <b>${nOther}</b></span>` : ""}
      </div>
    </div>

    <div class="spec-tabs">
      <button class="stab active" data-stab="overview">Обзор</button>
      <button class="stab" data-stab="instructions">Инструкции (${nInstr})</button>
      <button class="stab" data-stab="skills">Скиллы (${nSkills})</button>
      <button class="stab" data-stab="rules">Правила (${nRules + nTrig})</button>
      <button class="stab" data-stab="refine">Refine</button>
    </div>

    <div class="ssec active" data-ssec="overview">
      <div class="dd-section">
        <h2 style="margin:0 0 8px">Статистика по борду<span class="dd-count">${tasks.length} задач</span></h2>
        <div class="drawer-meta">
          <span class="srv-stat-chip">всего: <b>${tasks.length}</b></span>
          <span class="srv-stat-chip">в работе: <b>${wip}</b></span>
          <span class="srv-stat-chip">готово: <b>${done}</b></span>
          <span class="srv-stat-chip">блокировано: <b>${blocked}</b></span>
        </div>
      </div>
      <div class="dd-section">
        <h2 style="margin:0 0 8px">Активность в памяти<span class="dd-count">${memories.length}</span></h2>
        <div id="spec-mem"></div>
      </div>
    </div>

    <div class="ssec" data-ssec="instructions"><div id="spec-instructions"></div></div>
    <div class="ssec" data-ssec="skills"><div id="spec-skills"></div></div>
    <div class="ssec" data-ssec="rules"><div id="spec-rules"></div></div>

    <div class="ssec" data-ssec="refine">
      <p style="font-size:12px;color:var(--color-text-secondary);margin:0 0 8px">
        Опишите проблематику — @GCW: Agent Architect проанализирует инструкции/скиллы/правила
        специалиста и предложит изменения. Сначала изучите состав (вкладки выше)!</p>
      <div class="spec-refine">
        <input id="refine-input" type="text" placeholder="что улучшить? опишите проблему…" aria-label="формулировка для доработки" />
        <button id="refine-go">Анализ →</button>
      </div>
      <div class="spec-answer" id="refine-answer"></div>
      <div class="spec-commit-row" id="spec-commit-row">
        <button class="btn" id="spec-commit" disabled>⎇ Коммит в GCW</button>
        <span class="commit-note">активируется после подготовки изменений · тег <b>agent-refine</b></span>
      </div>
    </div>`;

  // tab wiring
  for (const btn of document.querySelectorAll(".stab")) {
    btn.addEventListener("click", () => {
      for (const x of document.querySelectorAll(".stab")) x.classList.toggle("active", x === btn);
      for (const s of document.querySelectorAll(".ssec")) s.classList.toggle("active", s.dataset.ssec === btn.dataset.stab);
    });
  }

  // composition sections: collapsible files
  const fileCard = (e) => {
    const div = document.createElement("div");
    div.className = "spec-file";
    div.innerHTML = `
      <div class="spec-file-head">
        <span class="spec-file-title">${esc(e.title)}</span>
        <span class="spec-file-src">${esc((e.source_url || "").replace("file://", ""))}</span>
      </div>
      <div class="spec-file-body">${esc(e.excerpt)}</div>`;
    div.querySelector(".spec-file-head").addEventListener("click", () => div.classList.toggle("open"));
    return div;
  };
  const fillSec = (elId, entries) => {
    const el = $(elId);
    el.innerHTML = "";
    if (!entries || !entries.length) {
      el.innerHTML = `<div class="column-empty">нет записей — запустите scripts/sync-gcw-profiles.py</div>`;
      return;
    }
    for (const e of entries) el.appendChild(fileCard(e));
  };
  fillSec("#spec-instructions", sec.instructions);
  fillSec("#spec-skills", sec.skills);
  fillSec("#spec-rules", [...(sec.rules || []), ...(sec.triggers || []), ...(sec.other || [])]);

  // memory accordion by project (compact, like the pulse rail)
  const memHolder = $("#spec-mem");
  if (!memories.length) {
    memHolder.innerHTML = `<div class="column-empty">записей о специалисте в памяти пока нет</div>`;
  } else {
    const byProj = new Map();
    for (const m of memories) {
      const p = (m.tags || []).find((t) => t.startsWith("project:"))?.slice(8) || "без проекта";
      if (!byProj.has(p)) byProj.set(p, []);
      byProj.get(p).push(m);
    }
    for (const [p, list] of byProj) {
      const box = document.createElement("div");
      box.className = "pulse-project";
      box.innerHTML = `
        <div class="pulse-proj-head">
          <span class="caret">▶</span>
          <span class="chip tagchip tag-project" style="cursor:default">${esc(p)}</span>
          <span class="pulse-proj-count">${list.length}</span>
        </div>
        <div class="pulse-proj-body"></div>`;
      const inner = box.querySelector(".pulse-proj-body");
      for (const m of list) {
        const item = document.createElement("div");
        item.className = "pulse-item";
        item.innerHTML = `
          <div class="pulse-title">${esc(m.title || m.id)}</div>
          <div class="pulse-tags"><span class="pulse-server">${esc(m.server || "")}</span>
            <span class="chip">${esc((m.created_at || "").slice(0, 10))}</span></div>`;
        item.addEventListener("click", () => openMemoryOverlay(m.id));
        inner.appendChild(item);
      }
      box.querySelector(".pulse-proj-head").addEventListener("click", () => box.classList.toggle("open"));
      memHolder.appendChild(box);
    }
  }

  // refine flow (v1) — same as before
  $("#refine-go").addEventListener("click", async () => {
    const input = $("#refine-input");
    const problem = input.value.trim();
    if (!problem) { input.focus(); return; }
    $("#refine-answer").style.display = "block";
    $("#refine-answer").textContent = "⌁ @GCW: Agent Architect анализирует профиль специалиста…";
    $("#spec-commit-row").style.display = "none";
    try {
      await api("/api/board-reflect", {
        method: "POST",
        body: JSON.stringify({ specialist: name, problem, kind: "agent-refine-request" }),
      });
      const task = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: `Refine ${name}: доработать инструкции по замечанию владельца`,
          summary: "Владелец отметил неэффективность работы специалиста. " +
                   "Архитектору Агентов: проанализировать инструкции/скиллы/правила, предложить изменения.",
          spec: "Проблема от владельца (из карточки специалиста в борде):\n\n" + problem
              + "\n\nAcceptance criteria:\n— [ ] анализ текущих инструкций/скиллов специалиста\n— [ ] конкретные правки в AGENTS/SKILL/инструкции\n— [ ] ответ владельцу в карточке специалиста",
          col: "open", env: "laptop",
          agents: ["zcode"],
          specialists: ["@GCW: Agent Architect"],
          project: "gcw",
          mnemos_tags: ["project:gcw", "agent:gcw-agent-architect", "mnemos:session", "agent-refine"],
        }),
      });
      $("#refine-answer").textContent =
        `Принято. Создана задача ${task.id} для @GCW: Agent Architect; проблематика записана в память (agent-refine).\n\n[Черновик анализа]\n` + refineDraft(name, problem, memories);
      $("#spec-commit-row").style.display = "flex";
      input.value = "";
      toast("ok", "Refine-запрос отправлен", `${name}: таска ${task.id} создана для Архитектора Агентов`);
      await refreshBoard();
      $("#spec-commit").disabled = false;
    } catch (err) {
      $("#refine-answer").textContent = "Сбой: " + err.message;
      toast("err", "Refine-запрос не прошёл", err.message);
    }
  });

  $("#spec-commit").addEventListener("click", async () => {
    try {
      const r = await api("/api/board-reflect", {
        method: "POST",
        body: JSON.stringify({
          specialist: name, kind: "agent-refine-commit",
          problem: "commit prepared from specialist card",
        }),
      });
      toast("ok", "Готово к коммиту", `правки помечены тегом agent-refine (${r.memory_id ? "id " + r.memory_id.slice(0, 8) : ""})`);
      $("#spec-commit").disabled = true;
    } catch (err) {
      toast("err", "Не удалось пометить правки", err.message);
    }
  });
}

function refineDraft(name, problem, memories) {
  return [
    "1. Проблема: " + problem,
    "2. Контекст специалиста: " + (memories.length ? memories.length + " связанных записей в памяти" : "записей нет"),
    "3. Рекомендация @GCW: Agent Architect (v1): проанализировать role-contract и skills специалиста,",
    "   локализовать узкое место в инструкциях, предложить правки в формате diff-патча,",
    "   применить локально, затем коммит в GCW с тегом agent-refine.",
  ].join("\n");
}

// maximize toggle for all modals
function wireMax(btnId, modalId) {
  const btn = document.querySelector(btnId);
  if (!btn) return;
  btn.addEventListener("click", () => {
    document.querySelector(modalId).classList.toggle("max");
    btn.textContent = document.querySelector(modalId).classList.contains("max") ? "⤡" : "⤢";
  });
}
wireMax("#modal-max", "#task-modal");
wireMax("#srv-max", "#srv-modal");
wireMax("#dd-max", "#dd-modal");

// Back-button stack for the drill modal (tag/agent → memory card → …)
const ddStack = [];
let ddCurrent = null;
function ddRemember(kind, title, sub, render) {
  if (ddCurrent) ddStack.push(ddCurrent);
  ddCurrent = { kind, title, sub, render };
  updateDdBack();
}
function updateDdBack() {
  const b = $("#dd-back");
  if (b) b.hidden = ddStack.length === 0;
}
if (document.querySelector("#dd-back")) document.querySelector("#dd-back").addEventListener("click", () => {
  const prev = ddStack.pop();
  if (prev) {
    ddCurrent = prev;
    prev.render();
    updateDdBack();
  }
});

// ------------------------------------------------------- context menu
const ctxTargets = { store: null, group: null, task: null, memory: null };

function ctxOpen(x, y, headTitle, headSub) {
  let menu = document.querySelector("#ctx-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.id = "ctx-menu";
    document.body.appendChild(menu);
  }
  menu.innerHTML = `<div class="ctx-head"><span>${esc(headTitle)}</span><span style="margin-left:auto;opacity:.6">${esc(headSub || "")}</span></div>`;
  menu.classList.add("open");
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - mw - 8) + "px";
  menu.style.top = Math.min(y, innerHeight - mh - 8) + "px";
  return menu;
}
function ctxAdd(label, ic, fn, cls) {
  const menu = document.querySelector("#ctx-menu");
  const btn = document.createElement("button");
  btn.className = "ctx-item " + (cls || "");
  btn.innerHTML = `<span class="ic">${ic}</span>${esc(label)}`;
  btn.addEventListener("click", () => { closeCtx(); fn(); });
  menu.appendChild(btn);
}
function ctxSep() { document.querySelector("#ctx-menu").insertAdjacentHTML("beforeend", "<div class=\"ctx-sep\"></div>"); }
function ctxSec(label) { document.querySelector("#ctx-menu").insertAdjacentHTML("beforeend", "<div class=\"ctx-sec\">" + esc(label) + "</div>"); }
function closeCtx() {
  const m = document.querySelector("#ctx-menu");
  if (m) m.classList.remove("open");
  ctxTargets.store = null; ctxTargets.group = null; ctxTargets.task = null; ctxTargets.memory = null;
}
document.addEventListener("click", (e) => { if (!e.target.closest("#ctx-menu")) closeCtx(); });
document.addEventListener("scroll", closeCtx, true);
window.addEventListener("resize", closeCtx);

function moveTaskTo(id, col) {
  const t = state.board && state.board.tasks ? state.board.tasks.find((x) => x.id === id) : null;
  if (!t) return;
  t.col = col; renderBoard();
  api("/api/tasks/" + encodeURIComponent(id) + "/move", { method: "POST", body: JSON.stringify({ col }) })
    .then(() => toast("ok", `${id}: перемещена`, "колонка «" + (COLUMN_TITLES[col] || col) + "»"))
    .catch((err) => { toast("err", `${id}: перемещение не удалось`, err.message); refreshBoard(); });
}

const ACTION_PAST = {
  enable: "хранилище подключено", disable: "хранилище отключено",
  test: "проверка связи", sync: "синхронизация выполнена", reload: "перезагружено",
  pause: "хранилище на паузе", resume: "пауза снята",
};
async function srvActionAndWait(name, action) {
  try {
    const r = await api("/api/memories/servers/" + encodeURIComponent(name) + "/action", {
      method: "POST", body: JSON.stringify({ action }),
    });
    const verb = ACTION_PAST[action] || action;
    if (action === "test") {
      toast(r.ok ? "ok" : "err", name + ": " + (r.ok ? "связь в порядке" : "связи нет"),
        r.ok ? (r.probe.latency_ms + " ms" + (r.probe.auth ? "" : " · без токена")) : (r.probe.error || "HTTP " + r.probe.http_status));
    } else if (action === "sync") {
      toast(r.ok ? "ok" : "err", name + ": синхронизация",
        r.ok ? "выполнена · " + (r.stats && r.stats.memories_total != null ? r.stats.memories_total + " памятей" : "ok") : "хранилище недоступно");
    } else {
      toast("ok", name + ": " + verb);
    }
  } catch (err) {
    toast("err", name + ": " + (ACTION_PAST[action] || action), err.message);
  }
  await loadMemServers(); refreshStores();
}

function storeContextMenu(e, s) {
  e.preventDefault();
  ctxTargets.store = s;
  ctxOpen(e.clientX, e.clientY, "◉ " + s.name, s.group_name);
  ctxSec("Хранилище");
  ctxAdd(s.enabled ? "Отключить" : "Подключить", "⏻", () => srvActionAndWait(s.name, s.enabled ? "disable" : "enable"));
  ctxAdd("Проверить связь", "⌁", () => srvActionAndWait(s.name, "test"));
  ctxAdd(s.state === "paused" ? "Снять с паузы" : "Пауза", "⏸", () => srvActionAndWait(s.name, s.state === "paused" ? "resume" : "pause"));
  ctxAdd("Синк", "⟳", () => srvActionAndWait(s.name, "sync"));
  ctxAdd("Перезагрузить", "↻", () => srvActionAndWait(s.name, "reload"));
  ctxSep();
  ctxAdd("Открыть карточку", "⤢", () => openServerModal(s.name));
  ctxAdd("Копировать URL", "⧉", () => navigator.clipboard && navigator.clipboard.writeText(s.url));
}

function groupContextMenu(e, g) {
  e.preventDefault();
  ctxTargets.group = g;
  ctxOpen(e.clientX, e.clientY, "⬡ " + g.name, "кластер памяти");
  ctxSec("Кластер");
  ctxAdd("Открыть карточку", "⤢", () => openGroupModal(g.name));
  ctxAdd("Объединённый пульс", "◉", () => {
    state.memScope = g.name; localStorage.setItem(SCOPE_KEY, g.name);
    const sel = document.querySelector("#mem-scope");
    if (sel) sel.value = g.name;
    updateScopeLabels(); refreshPulse();
  });
  ctxAdd("Синк всех участников", "⟳", async () => {
    const members = g.servers || g.members || [];
    for (const m of members) await srvActionAndWait(m, "sync");
  });
  ctxAdd("Переименовать", "✎", async () => {
    const title = prompt("Новое название:", g.name);
    if (!title) return;
    try {
      await api("/api/memories/groups", { method: "POST", body: JSON.stringify({ name: g.name, title }) });
      await loadMemServers(); renderGroups();
      toast("ok", "Кластер переименован", g.name + " → " + title);
    } catch (err) { toast("err", "Не удалось переименовать", err.message); }
  });
  ctxAdd("Удалить кластер", "🗑", async () => {
    if (!confirm("Удалить кластер «" + g.name + "»? Хранилища перейдут в default.")) return;
    try {
      await api("/api/memories/groups/" + encodeURIComponent(g.name), { method: "DELETE" });
      await loadMemServers(); refreshStores(); renderGroups();
      toast("ok", "Кластер «" + g.name + "» удалён", "хранилища переведены в default");
    } catch (err) { toast("err", "Не удалось удалить", err.message); }
  }, "danger");
}

// ── Cluster card modal: settings, members, meta, logs ──────────────
async function openGroupModal(name) {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  ddRemember("кластер", "⬡ " + name, "карточка кластера памяти", () => openGroupModal(name));
  $("#dd-kind").textContent = "кластер";
  $("#dd-title").textContent = "Кластер «" + name + "»";
  $("#dd-sub").textContent = "участники, состояние, мета, логи";
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка…</div>`;
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
  try {
    const info = await api(`/api/memories/groups/${encodeURIComponent(name)}/info`);
    const allServers = (state.memServers?.servers || [])
      .filter((s) => !info.members.some((m) => m.name === s.name));

    $("#dd-body").innerHTML = `
      <div class="dd-section">
        <h2 style="margin:0 0 8px">Участники<span class="dd-count">${info.members.length}</span></h2>
        <div id="grp-members" class="dd-list"></div>
        <div class="mem-search" style="margin-top:8px">
          <select id="grp-add-sel" class="f-sel" style="flex:1">
            <option value="">— добавить хранилище в кластер —</option>
            ${allServers.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join("")}
          </select>
          <button id="grp-add-btn">+</button>
        </div>
      </div>
      <div class="dd-section">
        <h2 style="margin:0 0 8px">Мета</h2>
        <div class="drawer-meta" id="grp-meta"></div>
      </div>
      <div class="dd-section">
        <h2 style="margin:0 0 8px">Логи кластера</h2>
        <div class="srv-history" id="grp-log"></div>
      </div>`;

    const membersEl = $("#grp-members");
    for (const m of info.members) {
      const row = document.createElement("div");
      row.className = "dd-item";
      row.innerHTML = `
        <div class="dd-item-title">
          <span class="dot ${m.ok ? "dot-on" : "dot-off"}" style="margin-right:6px"></span>
          ${esc(m.name)} <span class="dd-count">${m.memories_total ?? "?"} памятей · ${m.latency_ms ?? "?"} ms · v${esc(m.version || "?")}</span>
        </div>
        <div class="dd-item-meta">
          <span class="chip">${esc(m.state)}</span>
          <span class="chip">${Object.keys(m.by_project || {}).slice(0, 4).map(esc).join(", ") || "—"}</span>
          <span class="chip">${esc(m.url)}</span>
        </div>
        <button class="btn btn-danger" style="margin-top:6px">убрать из кластера</button>`;
      row.querySelector("button.btn-danger").addEventListener("click", async () => {
        try {
          await api(`/api/memories/groups/${encodeURIComponent(name)}/members`, {
            method: "POST", body: JSON.stringify({ server: m.name, op: "remove" }),
          });
          toast("ok", `${m.name}: выведен из кластера`, name);
          await loadMemServers(); refreshStores(); renderGroups();
          openGroupModal(name);
        } catch (err) { toast("err", "Не удалось вывести", err.message); }
      });
      membersEl.appendChild(row);
    }
    $("#grp-add-btn").addEventListener("click", async () => {
      const sel = $("#grp-add-sel");
      const srv = (sel && sel.value) || "";
      if (!srv) return;
      try {
        await api(`/api/memories/groups/${encodeURIComponent(name)}/members`, {
          method: "POST", body: JSON.stringify({ server: srv, op: "add" }),
        });
        toast("ok", `${srv}: добавлен в кластер`, name);
        await loadMemServers(); refreshStores(); renderGroups();
        openGroupModal(name);
      } catch (err) { toast("err", "Не удалось добавить", err.message); }
    });

    $("#grp-meta").innerHTML = `
      <span class="srv-stat-chip">хранилищ: <b>${info.members.length}</b></span>
      <span class="srv-stat-chip">онлайн: <b>${info.members.filter((m) => m.ok).length}</b></span>
      <span class="srv-stat-chip">памятей всего: <b>${info.members.reduce((a, m) => a + (m.memories_total || 0), 0)}</b></span>`;

    const logEl = $("#grp-log");
    logEl.innerHTML = info.history.length
      ? info.history.map((x) =>
          `<div class="srv-history-item"><ts>${esc((x.ts || "").slice(5, 16))}</ts><span>${esc(x.action)}</span><span>${esc(x.detail || "")}</span></div>`).join("")
      : `<div class="column-empty">событий пока нет</div>`;
  } catch (err) {
    $("#dd-body").innerHTML = `<div class="column-empty">${esc(err.message)}</div>`;
  }
}

function taskContextMenu(e, t) {
  e.preventDefault();
  ctxTargets.task = t;
  ctxOpen(e.clientX, e.clientY, t.id + " · " + t.title.slice(0, 30), COLUMN_TITLES[t.col] || t.col);
  ctxSec("Задача");
  ctxAdd("Открыть карточку", "⤢", () => openTask(t.id));
  if (t.col !== "done") ctxAdd("В «готово»", "✓", () => moveTaskTo(t.id, "done"));
  if (t.col !== "blocked") ctxAdd("В «блокировано»", "⊘", () => moveTaskTo(t.id, "blocked"));
  if (t.col !== "open") ctxAdd("В «открыто»", "↺", () => moveTaskTo(t.id, "open"));
  ctxSep();
  ctxAdd("В архив", "🗄", async () => {
    if (!confirm(`Архивировать ${t.id}?`)) return;
    try {
      await api(`/api/tasks/${encodeURIComponent(t.id)}/archive`, { method: "POST" });
      toast("ok", `${t.id}: в архиве`, "вернуть можно из архива в панели");
      await refreshBoard(); refreshArchiveTeaser();
    } catch (err) { toast("err", "Архивация не удалась", err.message); }
  });
  ctxAdd("Копировать id", "⧉", () => navigator.clipboard && navigator.clipboard.writeText(t.id));
}

function memoryContextMenu(e, item) {
  e.preventDefault();
  ctxTargets.memory = item;
  ctxOpen(e.clientX, e.clientY, (item.title || item.id).slice(0, 34), item.server || "");
  ctxSec("Знание");
  ctxAdd("Открыть карточку", "◉", () => openMemoryCard(item));
  ctxSep();
  ctxAdd("Копировать id", "⧉", () => navigator.clipboard && navigator.clipboard.writeText(item.id));
}

// --------------------------------------------------- cross-links: drilldown
function showDdModal(kindLabel, title, sub) {
  $("#dd-kind").textContent = kindLabel;
  $("#dd-title").textContent = title;
  $("#dd-sub").textContent = sub || "";
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка…</div>`;
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  b.hidden = false;
  d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
}
function closeDdModal() {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  b.classList.remove("open"); d.classList.remove("open");
  modalClosed("dd-modal");
  ddStack.length = 0; ddCurrent = null; updateDdBack();
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
  // if opened from another card (task/store), restore that modal instead of dead end
  if (modalHistory.length) {
    const reopen = modalHistory.pop();
    const bb = $("#modal-back"); if (bb) bb.hidden = modalHistory.length === 0;
    reopen();
  }
}
$("#dd-close").addEventListener("click", closeDdModal);
$("#dd-backdrop").addEventListener("click", closeDdModal);

function ddItem({ title, meta, excerpt, onClick }) {
  const div = document.createElement("div");
  div.className = "dd-item";
  div.innerHTML = `
    <div class="dd-item-title">${esc(title)}</div>
    <div class="dd-item-meta">${meta}</div>
    ${excerpt ? `<div class="dd-item-excerpt">${esc(excerpt)}</div>` : ""}`;
  div.addEventListener("click", (e) => {
    // tag/agent chips inside items are cross-links — the delegated
    // document listener owns them, don't also trigger the whole item
    if (e.target.closest(".tagchip[data-tag], [data-agent]")) return;
    onClick();
  });
  return div;
}

async function openTagDrill(tag) {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  ddRemember("тег", "#" + tag, "все задачи и знания, связанные с этим тегом (по всем серверам памяти)", () => openTagDrill(tag));
  $("#dd-kind").textContent = "тег";
  $("#dd-title").textContent = "#" + tag;
  $("#dd-sub").textContent = "все задачи и знания, связанные с этим тегом (по всем серверам памяти)";
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка…</div>`;
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
  try {
    const data = await api(`/api/tags/${encodeURIComponent(tag)}/drill?limit=12`);
    const body = $("#dd-body");
    body.innerHTML = "";
    const sec = (title, count) => `<h2 class="dd-section" style="margin:0 0 8px">${title}<span class="dd-count">${count}</span></h2>`;
    if (data.tasks.length) {
      body.insertAdjacentHTML("beforeend", sec("Задачи борда", data.tasks.length));
      const list = document.createElement("div");
      list.className = "dd-list";
      for (const t of data.tasks) {
        list.appendChild(ddItem({
          title: `${t.id} · ${t.title}`,
          meta: `<span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env)}</span>`,
          onClick: () => { closeDdModal(); openTask(t.id); },
        }));
      }
      body.appendChild(list);
    }
    if (data.memories.length) {
      body.insertAdjacentHTML("beforeend", sec("Знания mnemos", data.memories.length));
      const list = document.createElement("div");
      list.className = "dd-list";
      for (const m of data.memories) {
        list.appendChild(ddItem({
          title: m.title || m.id,
          meta: `<span class="pulse-server">${esc(m.server || "")}</span>
                 <span class="chip">${esc((m.created_at || "").slice(0, 10))}</span>
                 ${(m.tags || []).slice(0, 3).map((t) => tagChip(t)).join("")}`,
          excerpt: m.excerpt,
          onClick: () => openMemoryOverlay(m.id),
        }));
      }
      body.appendChild(list);
    }
    if (!data.tasks.length && !data.memories.length) {
      body.innerHTML = `<div class="column-empty">по тегу пока ничего не найдено${data.errors.length ? " · " + esc(data.errors.map((e) => e.server + ":" + e.status).join(", ")) : ""}</div>`;
    }
  } catch (err) {
    $("#dd-body").innerHTML = `<div class="column-empty">${esc(err.message)}</div>`;
  }
}

async function openAgentActivity(agent) {
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  ddRemember("агент", "⚒ " + agent, "задачи агента на борде + последние знания из памяти (по всем серверам)", () => openAgentActivity(agent));
  $("#dd-kind").textContent = "агент";
  $("#dd-title").textContent = "⚒ " + agent;
  $("#dd-sub").textContent = "задачи агента на борде + последние знания из памяти (по всем серверам)";
  $("#dd-body").innerHTML = `<div class="column-empty">загрузка…</div>`;
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agent)}/activity?limit=8`);
    const body = $("#dd-body");
    body.innerHTML = "";
    if (data.tasks.length) {
      body.insertAdjacentHTML("beforeend", `<h2 class="dd-section" style="margin:0 0 8px">Задачи борда<span class="dd-count">${data.tasks.length}</span></h2>`);
      const list = document.createElement("div");
      list.className = "dd-list";
      for (const t of data.tasks) {
        list.appendChild(ddItem({
          title: `${t.id} · ${t.title}`,
          meta: `<span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env)}</span>`,
          onClick: () => { closeDdModal(); openTask(t.id); },
        }));
      }
      body.appendChild(list);
    }
    if (data.memories.length) {
      body.insertAdjacentHTML("beforeend", `<h2 class="dd-section" style="margin:16px 0 8px">Последние знания</h2>`);
      const list = document.createElement("div");
      list.className = "dd-list";
      for (const m of data.memories) {
        list.appendChild(ddItem({
          title: m.title || m.id,
          meta: `<span class="pulse-server">${esc(m.server || "")}</span>
                 <span class="chip">${esc((m.created_at || "").slice(0, 10))}</span>`,
          excerpt: m.excerpt,
          onClick: () => openMemoryOverlay(m.id),
        }));
      }
      body.appendChild(list);
    }
    if (!data.tasks.length && !data.memories.length) {
      body.innerHTML = `<div class="column-empty">активность агента не найдена${data.errors.length ? " · " + esc(data.errors.map((e) => e.server + ":" + e.status).join(", ")) : ""}</div>`;
    }
  } catch (err) {
    $("#dd-body").innerHTML = `<div class="column-empty">${esc(err.message)}</div>`;
  }
}

// task modal tabs
for (const btn of document.querySelectorAll(".mtab")) {
  btn.addEventListener("click", () => setTaskTab(btn.dataset.tab));
}

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
  es.onerror = () => {
    // EventSource auto-reconnects; show honest amber while the socket is
    // not OPEN (CONNECTING=0 during retry backoff, CLOSED=2 after a drop).
    // es.onopen flips it back to green once the stream is live again.
    if (es.readyState !== 1) setConn("dot-wait", "переподключение");
  };
  es.onmessage = (msg) => {
    let ev;
    try { ev = JSON.parse(msg.data); } catch { return; }
    if (ev.kind === "hello") return;
    if (ev.kind === "task.moved" || ev.kind === "task.created"
        || ev.kind === "task.updated" || ev.kind === "task.deleted") {
      refreshBoard();
    }
    if (ev.kind === "server.changed") {
      loadMemServers().then(() => { refreshStores(); renderGroups(); }).catch(() => {});
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
  wireFilters();
  await loadMemServers().catch(() => {});
  refreshPulse();
  refreshStores();
  renderGroups();
  refreshBell();
  refreshArchiveTeaser();
  healthLoop();
  setInterval(healthLoop, 30000);
  setInterval(refreshPulse, 60000);
  setInterval(refreshBell, 20000);
})();