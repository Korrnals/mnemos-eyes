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
// SEC-3 fail-closed write guard: mutating requests must carry the board
// token. It lives in localStorage per browser; a 401 on a mutation asks
// once and retries (token value ships in k8s secret vesmaro-eyes-board-token).
const BOARD_TOKEN_KEY = "vesmaro.boardToken";

function boardToken() {
  return localStorage.getItem(BOARD_TOKEN_KEY) || "";
}

function askBoardToken() {
  const t = prompt(
    "Мутации борда защищены токеном (fail-closed).\n" +
    "Возьмите значение секрета vesmaro-eyes-board-token и вставьте сюда —\n" +
    "браузер запомнит его:\n" +
    "kubectl -n kube-agents get secret vesmaro-eyes-board-token \\\n" +
    "  -o jsonpath='{.data.VESMARO_BOARD_TOKEN}' | base64 -d",
  );
  if (t && t.trim()) localStorage.setItem(BOARD_TOKEN_KEY, t.trim());
  return boardToken();
}

async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const token = boardToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && method !== "GET") {
    if (askBoardToken()) return api(path, opts);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    const err = new Error(`${res.status}: ${detail}`);
    err.status = res.status; // UI-15: callers branch on 423 (Locked, >24h)
    throw err;
  }
  return res.json();
}

// UI-16: unknown env renders as a bare "—" badge (title still explains it).
const ENV_LABELS = {
  cluster: "ai-agent cluster",
  laptop: "laptop",
  local: "local",
  cloud: "cloud",
  unknown: "—",
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

// UI-7: canonical status dictionary = mnemos workflow statuses.
// v1 derives the status from the board column; the archived flag overrides.
const STATUS_LABELS = {
  "open": "открыта",
  "in-progress": "в работе",
  "blocked": "заблокирована",
  "resolved": "решена",
  "done": "готова",
  "withdrawn": "снята",
};

function taskStatus(t) {
  if (t.archived) return "archived";
  // BE-10: the server now carries the workflow status as a field (synced
  // with the column on move; PATCH status is independent and may hold
  // `withdrawn`). Older backends send no field — derive from the column.
  if (t.status && STATUS_LABELS[t.status]) return t.status;
  return STATUS_LABELS[t.col] ? t.col : "open";
}

// Single badge renderer — used by the small card and the task modal alike.
// role="img" + aria-label: a plain span ignores aria-label, the img role
// makes the badge a named object for AT (visible text stays as fallback).
function statusBadge(t) {
  const s = taskStatus(t);
  const label = s === "archived" ? "в архиве" : (STATUS_LABELS[s] || s);
  return `<span class="status-badge status-${s}" role="img" aria-label="статус: ${esc(label)}">${esc(label)}</span>`;
}

// ── UI-13: task priority (BE contract: critical|high|normal|low, default
// normal). Degrade: old backends send no field → no badge, no sort change.
// "normal" is intentionally not rendered — it is the default, a badge for
// it would be noise on every card.
const PRIORITY_LABELS = {
  critical: "критический",
  high: "высокий",
  normal: "обычный",
  low: "низкий",
};
const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

function priorityBadge(t) {
  const p = t && t.priority;
  if (!p || p === "normal") return "";
  const label = PRIORITY_LABELS[p] || p;
  return `<span class="priority-badge priority-${esc(p)}" role="img" aria-label="приоритет: ${esc(label)}">${esc(label)}</span>`;
}

// Creation date, «создана DD.MM» — from created_at, empty when absent.
function createdShort(t) {
  if (!t || !t.created_at) return "";
  const d = new Date(t.created_at);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Project of a task: explicit field wins, else the project:* mnemos tag.
function taskProject(t) {
  return t.project || (t.mnemos_tags || []).find((x) => x.startsWith("project:"))?.slice(8) || "";
}

// UI-13/14: order inside project groups — priority (critical→low), then
// board position, then the server order (sort is stable).
function priorityComparator(a, b) {
  const ra = PRIORITY_RANK[a.priority] ?? PRIORITY_RANK.normal;
  const rb = PRIORITY_RANK[b.priority] ?? PRIORITY_RANK.normal;
  if (ra !== rb) return ra - rb;
  const pa = a.position ?? 0;
  const pb = b.position ?? 0;
  return pa - pb;
}

// ------------------------------------------------------------- filters
// UI-13: priority is a client-side filter; on old backends every task is
// implicitly "normal" (server default), so the select still behaves.
const filter = { text: "", project: "", agent: "", env: "", tag: "", status: "", priority: "" };

async function refreshBoard() {
  // BE-10: the status filter runs server-side (?status=). Old backends
  // ignore the unknown query param, and taskMatches() below keeps the
  // client-side check as the fallback.
  const qs = filter.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  state.board = await api("/api/board" + qs);
  renderBoard();
  renderRail();
  refreshFilterOptions();
}

function taskMatches(t) {
  if (filter.status && taskStatus(t) !== filter.status) return false;
  if (filter.priority && (t.priority || "normal") !== filter.priority) return false;
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

  const proj = taskProject(t);

  // UI-7: compact groups, same order as the modal sections
  // (Теги → Сервер → Агент → Специалисты), separated by hairlines.
  const memCount = (t.memory_ids || []).length;
  const specialists = t.specialists || [];
  const allTags = t.mnemos_tags || [];
  const cardTags = allTags.slice(0, 4);
  const more = allTags.length - cardTags.length;
  const group = (ariaLabel, html) =>
    `<div class="task-group" role="group" aria-label="${esc(ariaLabel)}">${html}</div>`;
  const empty = `<span class="task-sec-empty">—</span>`;
  const created = createdShort(t);

  card.innerHTML = `
    <div class="task-top">
      <span class="task-id">${esc(t.id)}</span>
      ${proj ? `<span class="chip tagchip tag-project" data-tag="project:${esc(proj)}" title="проект">${esc(proj)}</span>` : ""}
      <span class="chip chip-env" title="среда исполнения">${esc(ENV_LABELS[t.env] || t.env)}</span>
      ${priorityBadge(t)}
      ${statusBadge(t)}
      ${created ? `<span class="task-created" title="создана ${esc((t.created_at || "").slice(0, 10))}">создана ${esc(created)}</span>` : ""}
      <span class="task-age" title="обновлено ${esc(t.updated_at || "")}">${esc(ageOf(t.updated_at))}</span>
    </div>
    <h3 class="task-title">${esc(t.title)}</h3>
    ${group("Теги", `<div class="task-tagrow">${cardTags.map((tag) => tagChip(tag)).join("")}
      ${more > 0 ? `<span class="chip tagchip tag-other">+${more}</span>` : ""}
      ${cardTags.length ? "" : empty}</div>`)}
    ${memCount ? group("Сервер", `<span class="chip chip-mem" title="связанные памяти mnemos">◉ ${memCount}</span>`) : ""}
    ${group("Агент", `${(t.agents || []).length ? `<span class="chip chip-agent" title="агент-исполнитель" data-agent="${esc(t.agents[0] || "")}">⚒ ${esc(t.agents.join(", "))}</span>${miniAvatars(t.agents)}` : empty}`)}
    ${specialists.length ? group("Специалисты", specialists.map((s) => `<span class="chip tagchip chip-spec" data-tag="${esc(s)}" title="специалист — связанные задачи и знания">${esc(s)}</span>`).join("")) : ""}`;

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
  // UI-13: client-side priority filter (critical/high/normal/low).
  $("#f-priority").addEventListener("change", (e) => {
    filter.priority = e.target.value;
    e.target.classList.toggle("active", !!e.target.value);
    renderBoard();
  });
  // UI-14: project-grouping toggle — persisted, default on.
  const gbtn = $("#f-group");
  const syncGroupBtn = () => gbtn.setAttribute("aria-pressed", groupingEnabled() ? "true" : "false");
  syncGroupBtn();
  gbtn.addEventListener("click", () => {
    localStorage.setItem(GROUPING_KEY, groupingEnabled() ? "off" : "on");
    syncGroupBtn();
    renderBoard();
  });
  // UI-8/BE-10: status is a server-side filter — refetch the board with
  // ?status= (client-side taskMatches stays as fallback for old backends).
  $("#f-status").addEventListener("change", async (e) => {
    filter.status = e.target.value;
    e.target.classList.toggle("active", !!filter.status);
    await refreshBoard();
  });
  $("#f-clear").addEventListener("click", async () => {
    Object.assign(filter, { text: "", project: "", agent: "", env: "", tag: "", status: "", priority: "" });
    $("#f-text").value = "";
    for (const id of ["#f-project","#f-agent","#f-env","#f-tag","#f-status","#f-priority"]) {
      $(id).value = ""; $(id).classList.remove("active");
    }
    await refreshBoard();
  });
}

// ── UI-14: project-group accordion state (persisted) ────────────────
// vesmaro.groups = JSON array of collapsed project names, shared by all
// columns; vesmaro.grouping = "off" disables grouping (default on).
const GROUPS_KEY = "vesmaro.groups";
const GROUPING_KEY = "vesmaro.grouping";

function groupingEnabled() {
  return localStorage.getItem(GROUPING_KEY) !== "off";
}
function collapsedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveCollapsed(set) {
  localStorage.setItem(GROUPS_KEY, JSON.stringify([...set]));
}

// UI-16: honest column subtitles for the two acceptance columns.
const COLUMN_SUBTITLES = {
  resolved: "ждёт приёмки",
  done: "принято",
};

function renderBoard() {
  const board = state.board;
  if (!board) return;
  const el = $("#board");
  el.innerHTML = "";
  let visibleTotal = 0;
  const anyFilter = filter.text || filter.project || filter.agent || filter.env || filter.tag || filter.status || filter.priority;
  const doGroup = groupingEnabled();
  for (const col of board.columns) {
    const all = board.tasks.filter((t) => t.col === col);
    const tasks = all.filter(taskMatches);
    visibleTotal += tasks.length;
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.col = col;
    const sub = COLUMN_SUBTITLES[col];
    colEl.innerHTML = `
      <div class="column-head" ${sub ? `title="${esc((COLUMN_TITLES[col] || col) + " — " + sub)}"` : ""}>
        <div class="column-head-text">
          <span class="column-title">${esc(COLUMN_TITLES[col] || col)}</span>
          ${sub ? `<span class="column-sub">${esc(sub)}</span>` : ""}
        </div>
        <span class="column-count">${anyFilter ? tasks.length + "/" + all.length : tasks.length}</span>
      </div>
      <div class="column-body"></div>`;
    const body = $(".column-body", colEl);
    if (!tasks.length) {
      body.innerHTML = `<div class="column-empty">${all.length ? "скрыто фильтром" : "пусто"}</div>`;
    } else if (doGroup) {
      // UI-14: groups by project («—» when a task has none), sorted by
      // priority then position inside each group. Group heads are real
      // buttons (a11y: aria-expanded); drop-on-column still works because
      // drag events from the groups bubble to the column handlers below.
      const byProject = new Map();
      for (const t of tasks) {
        const p = taskProject(t) || "—";
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p).push(t);
      }
      const collapsed = collapsedSet();
      let gi = 0;
      for (const [proj, list] of byProject) {
        list.sort(priorityComparator);
        const open = !collapsed.has(proj);
        const bodyId = `colgrp-${col}-${gi++}`;
        const groupEl = document.createElement("div");
        groupEl.className = "col-group" + (open ? " open" : "");
        groupEl.innerHTML = `
          <button class="col-group-head" type="button" aria-expanded="${open}" aria-controls="${bodyId}"
                  title="свернуть/развернуть группу «${esc(proj)}»">
            <span class="caret" aria-hidden="true">▶</span>
            <span class="col-group-name">${proj === "—" ? "—" : esc(proj)}</span>
            <span class="col-group-count">${list.length}</span>
          </button>
          <div class="col-group-body" id="${bodyId}"></div>`;
        const groupBody = $(".col-group-body", groupEl);
        for (const t of list) groupBody.appendChild(taskCard(t));
        $(".col-group-head", groupEl).addEventListener("click", () => {
          const nowOpen = !groupEl.classList.contains("open");
          groupEl.classList.toggle("open", nowOpen);
          $(".col-group-head", groupEl).setAttribute("aria-expanded", String(nowOpen));
          const set = collapsedSet();
          if (nowOpen) set.delete(proj); else set.add(proj);
          saveCollapsed(set);
        });
        body.appendChild(groupEl);
      }
    } else {
      for (const t of tasks) body.appendChild(taskCard(t));
    }
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
  // BE-10: with ?status= the server already filtered tasks[], so the
  // denominator comes from counts (always the whole board).
  const totalAll = Object.values(board.counts || {}).reduce((a, b) => a + b, 0) || board.tasks.length;
  fc.textContent = anyFilter ? `${visibleTotal} из ${totalAll}` : "";
  fb.hidden = !anyFilter;
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
  // UI-13: priority badge sits next to the status in the modal header
  $("#modal-status").innerHTML = statusBadge(t) + priorityBadge(t);
  $("#modal-env").textContent = ENV_LABELS[t.env] || t.env;
  $("#modal-title").textContent = t.title;
  $("#modal-summary").textContent = t.summary || "";
  $("#modal-spec").textContent = t.spec || "";
  $("#modal-spec-section").hidden = !t.spec;

  // UI-7: explicit labeled sections (Теги → Сервер → Агент → Специалисты).
  // role=group + aria-labelledby ties each section to its heading.
  const meta = $("#modal-meta");
  const empty = `<span class="task-sec-empty">—</span>`;
  const sec = (id, title, body) => `
    <section class="task-sec" role="group" aria-labelledby="${id}-h">
      <h3 class="task-sec-label" id="${id}-h">${esc(title)}</h3>
      <div class="drawer-meta" id="${id}">${body || empty}</div>
    </section>`;
  const proj = taskProject(t);
  meta.innerHTML = `
    ${sec("tsec-tags", "Теги",
      `${(proj ? `<span class="chip tagchip tag-project" data-tag="project:${esc(proj)}" title="проект">◈ ${esc(proj)}</span>` : "")
      + (t.mnemos_tags || []).map((tag) => tagChip(tag)).join("")}`)}
    ${sec("tsec-srv", "Сервер",
      `<span class="chip chip-mem" title="связанные памяти mnemos">◉ ${(t.memory_ids || []).length}</span>`)}
    ${sec("tsec-agent", "Агент",
      (t.agents || []).map((a) => `<span class="chip chip-agent" data-agent="${esc(a)}" title="активность агента">⚒ ${esc(a)}</span>`).join(""))}
    ${sec("tsec-spec", "Специалисты",
      (t.specialists || []).map((s) => `<span class="chip chip-spec" title="специалист">${esc(s)}</span>`).join(""))}`;

  // cross-navigation inside the modal is handled by the delegated
  // document click listener (tag/agent chips)

  const memEl = $("#modal-memories");
  memEl.innerHTML = `<div class="column-empty">загрузка памяти…</div>`;
  // reset tabs to Overview
  setTaskTab("overview");
  showTaskModal();
  loadTaskReports(t);   // UI-8: lazy — one GET when the modal opens
  try {
    const scope = scopeParam();
    const url = `/api/tasks/${encodeURIComponent(t.id)}/memories${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`;
    const resolved = (t.memory_ids || []).length ? await api(url) : { items: {}, unresolved: [], sources: {} };
    const searchHtml = await memorySearchWidget(t);
    if (state.activeTask !== t) return;
    // UI-7: fill the Сервер section — count, active scope, source servers
    // (provenance) of the resolved memories.
    const srcServers = [...new Set(Object.values(resolved.sources || {}).filter(Boolean))];
    const srvEl = $("#tsec-srv");
    if (srvEl) {
      const scopeLabel = state.memScope === "all" ? "все серверы" : state.memScope;
      srvEl.innerHTML = `
        <span class="chip chip-mem" title="связанные памяти mnemos">◉ ${(t.memory_ids || []).length}</span>
        <span class="chip" title="активный скоуп памяти">скоуп: ${esc(scopeLabel)}</span>
        ${srcServers.map((s) => `<span class="pulse-server" title="сервер-источник памяти">${esc(s)}</span>`).join("")}
        ${(t.memory_ids || []).length ? "" : `<span class="task-sec-empty">памятей нет</span>`}`;
    }
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
    const srvEl = $("#tsec-srv");
    if (srvEl) {
      srvEl.innerHTML = `
        <span class="chip chip-mem" title="связанные памяти mnemos">◉ ${(t.memory_ids || []).length}</span>
        <span class="task-sec-empty">провенанс недоступен: ${esc(err.message)}</span>`;
    }
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

// UI-12: timeline items expand inline. Board events carry their detail;
// memories show the excerpt/content already present in the history
// payload — no second fetch. Items with nothing to show stay static.
function tlItem(x) {
  const cls = x.kind === "memory" ? "memory" : "board";
  const badge = x.kind === "memory"
    ? `<span class="tl-badge memory">${esc((x.source || "memory").split(" · ")[0])}</span>`
    : `<span class="tl-badge board">${esc(KIND_LABEL[x.title] || "борд")}</span>`;
  const title = x.kind === "memory" ? x.title : (KIND_LABEL[x.title] || x.title);
  const body = x.kind === "memory"
    ? (x.excerpt || x.content || x.detail || "")
    : (x.detail || "");
  const expandable = !!body;
  const headTag = expandable ? "button" : "div";
  return `
    <div class="tl-item ${cls}${expandable ? " expandable" : ""}">
      <${headTag} class="tl-head"${expandable ? ' type="button" aria-expanded="false"' : ""}>
        <span class="tl-ts">${esc((x.ts || "").replace("T", " ").slice(0, 16))}</span>
        <span class="tl-title">${esc(title)}</span>
        ${badge}
        ${expandable ? `<span class="tl-caret" aria-hidden="true">▶</span>` : ""}
      </${headTag}>
      ${expandable ? `<div class="tl-detail" hidden>${esc(body)}</div>` : ""}
    </div>`;
}

// One delegated listener — the timeline re-renders on every task open.
document.querySelector("#modal-history").addEventListener("click", (e) => {
  const head = e.target.closest("button.tl-head");
  if (!head) return;
  const item = head.closest(".tl-item");
  const detail = item && item.querySelector(".tl-detail");
  if (!detail) return;
  const open = detail.hidden;
  detail.hidden = !open;
  head.setAttribute("aria-expanded", String(open));
  item.classList.toggle("open", open);
});

// ── UI-8: agent reports tab ────────────────────────────────────────
// GET /api/tasks/{id}/reports (BE-11a): chronological history, each item
// {id, kind: intermediate|final, agent, body, superseded, created_at}.
// Loaded lazily when the modal opens; 404 (old backend / task gone)
// degrades to the empty state.
const reportsTabBtn = () => document.querySelector('.mtab[data-tab="reports"]');

async function loadTaskReports(t) {
  const holder = $("#modal-reports");
  const tab = reportsTabBtn();
  if (tab) tab.textContent = "Отчёты";
  if (!holder) return;
  holder.innerHTML = `<div class="column-empty">загрузка отчётов…</div>`;
  try {
    const d = await api(`/api/tasks/${encodeURIComponent(t.id)}/reports`);
    if (state.activeTask !== t) return;
    renderTaskReports(holder, tab, t, d.items || []);
  } catch (err) {
    if (state.activeTask !== t) return;
    if (/^404/.test(err.message || "")) {
      renderTaskReports(holder, tab, t, []);
    } else {
      holder.innerHTML = `<div class="column-empty">отчёты недоступны: ${esc(err.message)}</div>`;
    }
  }
}

function renderTaskReports(holder, tab, t, items) {
  if (tab) tab.textContent = items.length ? `Отчёты · ${items.length}` : "Отчёты";
  if (!items.length) {
    holder.innerHTML = `<div class="column-empty">отчётов пока нет — они появятся, когда агенты отчитаются о работе над задачей</div>`;
    return;
  }
  holder.innerHTML = "";
  // UI-11: compact card list; server returns oldest-first — keep the order
  const list = document.createElement("div");
  list.className = "report-list";
  for (const r of items) list.appendChild(reportCard(t, r));
  holder.appendChild(list);
}

// UI-11: first non-empty line of the report body acts as the card heading.
function reportFirstLine(body) {
  const line = (body || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

function reportCard(t, r) {
  const div = document.createElement("div");
  div.className = "report-card" + (r.superseded ? " superseded" : "");
  div.tabIndex = 0;
  div.setAttribute("role", "button");
  div.setAttribute("aria-label", `отчёт: ${reportFirstLine(r.body) || "пустой отчёт"} — открыть подробно`);
  const kindLabel = r.kind === "final" ? "финальный" : "промежуточный";
  const head = reportFirstLine(r.body) || "(пустой отчёт)";
  div.innerHTML = `
    <div class="report-card-top">
      <span class="tl-badge report-kind report-${esc(r.kind)}">${esc(kindLabel)}</span>
      ${r.kind === "final" && !r.superseded ? `<span class="tl-badge report-final-mark">итоговый</span>` : ""}
      ${r.agent ? `<span class="chip chip-agent" data-agent="${esc(r.agent)}" title="агент-автор отчёта">⚒ ${esc(r.agent)}</span>` : ""}
      <span class="tl-ts">${esc((r.created_at || "").replace("T", " ").slice(0, 16))}</span>
    </div>
    <div class="report-card-title">${esc(head)}</div>
    ${r.superseded ? `<div class="report-sup-note">заменён более поздним финальным</div>` : ""}`;
  const open = () => openReportDetail(t, r);
  // agent chips are cross-links owned by the delegated document listener
  div.addEventListener("click", (e) => {
    if (e.target.closest("[data-agent]")) return;
    open();
  });
  div.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  return div;
}

// UI-11: report detail rides the shared dd-modal (modalOpened/Closed stack).
function openReportDetail(t, r) {
  const kindLabel = r.kind === "final" ? "финальный" : "промежуточный";
  const isLiveFinal = r.kind === "final" && !r.superseded;
  const head = reportFirstLine(r.body) || "(пустой отчёт)";
  ddRemember("отчёт", head, `${t.id} · отчёт агента`, () => openReportDetail(t, r));
  $("#dd-kind").textContent = "отчёт";
  $("#dd-title").textContent = head;
  $("#dd-sub").textContent = `${t.id} · отчёт агента · ${(r.created_at || "").replace("T", " ").slice(0, 16)}`;
  $("#dd-body").innerHTML = `
    <div class="dd-section">
      <div class="drawer-meta">
        <span class="tl-badge report-kind report-${esc(r.kind)}">${esc(kindLabel)}</span>
        ${isLiveFinal ? `<span class="tl-badge report-final-mark">итоговый</span>` : ""}
        ${r.superseded ? `<span class="tl-badge report-superseded-mark">заменён более поздним финальным</span>` : ""}
        ${r.agent ? `<span class="chip chip-agent" data-agent="${esc(r.agent)}" title="агент-автор отчёта">⚒ ${esc(r.agent)}</span>` : ""}
        <span class="chip">${esc(t.id)}</span>
        <span class="chip">${esc((r.created_at || "").replace("T", " ").slice(0, 16))}</span>
      </div>
    </div>
    <pre class="report-body report-body-full">${esc(r.body || "")}</pre>
    <div class="dd-section" id="report-detail-actions"></div>`;
  if (isLiveFinal) $("#report-detail-actions").appendChild(reportResumeButton(t));
  const d = $("#dd-modal"), b = $("#dd-backdrop");
  b.hidden = false; d.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
}

// Shared «Вернуть в работу» action (UI-8 inline + UI-11 detail modal).
// BE-10: status is a field — PATCH status=in-progress, never a move: the
// task stays in its column while the workflow status flips.
function reportResumeButton(t) {
  const btn = document.createElement("button");
  btn.className = "btn report-resume";
  btn.type = "button";
  btn.textContent = "Вернуть в работу";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "in-progress" }),
      });
      const live = (state.board?.tasks || []).find((x) => x.id === t.id);
      if (live) live.status = "in-progress";
      const badge = $("#modal-status");
      const at = state.activeTask;
      if (badge && at && at.id === t.id) badge.innerHTML = statusBadge(at) + priorityBadge(at);
      renderBoard();
      toast("ok", `${t.id}: возвращена в работу`, "статус in-progress · колонка не менялась");
    } catch (err) {
      toast("err", "Не удалось вернуть в работу", err.message);
      btn.disabled = false;
    }
  });
  return btn;
}

// Full inline report (archive detail keeps the expanded form — UI-9).
function reportItem(t, r, allowResume) {
  const div = document.createElement("div");
  div.className = "report-item" + (r.superseded ? " superseded" : "");
  const kindLabel = r.kind === "final" ? "финальный" : "промежуточный";
  const isLiveFinal = r.kind === "final" && !r.superseded;
  div.innerHTML = `
    <div class="report-head">
      <span class="tl-badge report-kind report-${esc(r.kind)}">${esc(kindLabel)}</span>
      ${isLiveFinal ? `<span class="tl-badge report-final-mark">итоговый</span>` : ""}
      ${r.superseded ? `<span class="tl-badge report-superseded-mark">заменён более поздним финальным</span>` : ""}
      ${r.agent ? `<span class="chip chip-agent" data-agent="${esc(r.agent)}" title="агент-автор отчёта">⚒ ${esc(r.agent)}</span>` : ""}
      <span class="tl-ts">${esc((r.created_at || "").replace("T", " ").slice(0, 16))}</span>
    </div>
    <pre class="report-body">${esc(r.body || "")}</pre>`;
  if (isLiveFinal && allowResume) div.querySelector(".report-head").appendChild(reportResumeButton(t));
  return div;
}

// ── cross-links: one delegated document click listener ─────────────
// Cards and modal bodies are re-rendered constantly: per-element handlers
// die with their nodes, and re-wiring persistent roots (#modal-meta,
// #dd-body) stacked duplicate listeners. Tag/agent chips therefore go
// through a single document-level listener, scoped to the containers that
// render cross-link chips — pulse/roster rows keep their whole-row clicks.
document.addEventListener("click", (e) => {
  if (!e.target.closest("#board, #modal-meta, #modal-reports, #arch-body, #dd-body")) return;
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
// UI-15: edit the open task from the modal header
$("#modal-edit").addEventListener("click", () => {
  if (state.activeTask) openEditModal(state.activeTask);
});

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

// ------------------------------------------------- new task draft (UI-6)
// Owner's raw thought → /api/task-drafts (draft note in mnemos, tags pinned
// server-side) → "Оформить черновик задачи" chore on the board for
// @GCW: Task Manager. Freeze exception per ADR 0006. The modal rides the
// shared modalOpened/modalClosed stack, so Escape pops only the topmost
// overlay and toasts reuse the existing system.
function openDraftModal() {
  const d = $("#draft-modal"), b = $("#draft-backdrop");
  b.hidden = false; d.hidden = false;
  modalOpened("draft-modal", closeDraftModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
  $("#draft-text").focus();
}

function closeDraftModal() {
  const d = $("#draft-modal"), b = $("#draft-backdrop");
  b.classList.remove("open"); d.classList.remove("open");
  modalClosed("draft-modal");
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
}

$("#new-task-btn").addEventListener("click", openDraftModal);
$("#draft-close").addEventListener("click", closeDraftModal);
$("#draft-backdrop").addEventListener("click", closeDraftModal);

$("#draft-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#draft-submit");
  const text = $("#draft-text").value.trim();
  if (!text) {
    toast("err", "Пустой черновик", "опишите задачу — текст обязателен");
    $("#draft-text").focus();
    return;
  }
  const project = $("#draft-project").value.trim();
  const tags = $("#draft-tags").value.trim();
  btn.disabled = true;
  btn.textContent = "Отправка…";
  try {
    // Draft memory first. The backend pins memory tags to the exact
    // allowed set; project/tags from the form travel inside content only.
    const draft = await api("/api/task-drafts", {
      method: "POST",
      body: JSON.stringify({ text, project, tags }),
    });
    const memoryId = draft.memory_id || "";
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: `Оформить черновик задачи (memory ${memoryId})`,
          summary: text.slice(0, 140),
          spec: `Черновик владельца в памяти ${draft.server}:${memoryId}. `
              + "@GCW: Task Manager — оформить в канон (название/summary/spec/AC/исполнители), вернуть на доску в validating-статус.",
          col: "open",
          agents: ["zcode"],
          specialists: ["@GCW: Task Manager"],
          env: "unknown",
          project,
          mnemos_tags: ["task-draft"],
          memory_ids: memoryId ? [memoryId] : [],
        }),
      });
      toast("ok", "Черновик отправлен", `память ${draft.server}:${memoryId} · задача-поручение создана`);
      $("#draft-text").value = "";
      $("#draft-project").value = "";
      $("#draft-tags").value = "";
      btn.disabled = false;
      btn.textContent = "Отправить черновик";
      closeDraftModal();
      await refreshBoard();
    } catch (err) {
      // The draft memory already exists — never re-submit the form
      // (a second POST /api/task-drafts would duplicate the memory).
      btn.textContent = "Черновик сохранён — задача не создана";
      toast("err", "Задача-поручение не создана",
        `черновик уже в памяти ${draft.server}:${memoryId} — форму повторно не отправляйте: ${err.message}`, 8000);
    }
  } catch (err) {
    toast("err", "Черновик не сохранён", err.message);
    btn.disabled = false;
    btn.textContent = "Отправить черновик";
  }
});

// ------------------------------------------------ edit task (UI-15)
// Content fields only (title/summary/spec/project/env/priority/tags/
// specialists/memory_ids). col/status/position/archived are intentionally
// absent. PATCH older than 24h → 423 Locked → the lock state offers
// force=true (confirm-gated). Old backends without the priority field:
// the select is disabled and the field is not sent.
let editTask = null;
let editDraft = { memory_ids: [] };

function openEditModal(t) {
  editTask = t;
  editDraft = { memory_ids: [...(t.memory_ids || [])] };
  $("#edit-id").textContent = t.id;
  $("#edit-title").value = t.title || "";
  $("#edit-summary").value = t.summary || "";
  $("#edit-spec").value = t.spec || "";
  $("#edit-project").value = taskProject(t);
  // project suggestions from the current board
  $("#edit-project-list").innerHTML = [...new Set((state.board?.tasks || []).map(taskProject).filter(Boolean))]
    .sort().map((p) => `<option value="${esc(p)}"></option>`).join("");
  const envSel = $("#edit-env");
  if (t.env && !envSel.querySelector(`option[value="${CSS.escape(t.env)}"]`)) {
    envSel.insertAdjacentHTML("beforeend", `<option value="${esc(t.env)}">${esc(t.env)}</option>`);
  }
  envSel.value = t.env || "unknown";
  const prioSel = $("#edit-priority");
  prioSel.value = t.priority || "normal";
  prioSel.disabled = t.priority === undefined; // old backend: field unknown
  prioSel.title = t.priority === undefined
    ? "бэкенд не отдаёт priority — значение не отправляется" : "";
  $("#edit-tags").value = (t.mnemos_tags || []).join(", ");
  $("#edit-specs").value = (t.specialists || []).join(", ");
  renderEditMemIds();
  $("#edit-lock").hidden = true;
  $("#edit-note").textContent = "";
  $("#edit-submit").disabled = false;
  const d = $("#edit-modal"), b = $("#edit-backdrop");
  b.hidden = false; d.hidden = false;
  modalOpened("edit-modal", closeEditModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
  $("#edit-title").focus();
}

function closeEditModal() {
  const d = $("#edit-modal"), b = $("#edit-backdrop");
  b.classList.remove("open"); d.classList.remove("open");
  modalClosed("edit-modal");
  editTask = null;
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
}

function renderEditMemIds() {
  const el = $("#edit-mem-ids");
  el.innerHTML = "";
  if (!(editDraft.memory_ids || []).length) {
    el.innerHTML = `<span class="task-sec-empty">памятей нет</span>`;
    return;
  }
  for (const id of editDraft.memory_ids) {
    const chip = document.createElement("span");
    chip.className = "chip chip-mem edit-mem-chip";
    chip.title = id;
    chip.innerHTML = `◉ ${esc(id)} <button type="button" class="edit-mem-rm" aria-label="убрать память ${esc(id)}">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      editDraft.memory_ids = editDraft.memory_ids.filter((x) => x !== id);
      renderEditMemIds();
    });
    el.appendChild(chip);
  }
}

async function saveEdit(force) {
  if (!editTask) return;
  const t = editTask;
  const title = $("#edit-title").value.trim();
  if (!title) {
    toast("err", "Название обязательно", "пустую задачу сохранить нельзя — как в черновике");
    $("#edit-title").focus();
    return;
  }
  const splitList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const memAdd = $("#edit-mem-add").value.trim();
  if (memAdd) {
    for (const id of splitList(memAdd)) {
      if (!editDraft.memory_ids.includes(id)) editDraft.memory_ids.push(id);
    }
    renderEditMemIds();
    $("#edit-mem-add").value = "";
  }
  const patch = {
    title,
    summary: $("#edit-summary").value.trim(),
    spec: $("#edit-spec").value.trim(),
    project: $("#edit-project").value.trim(),
    env: $("#edit-env").value || "unknown",
    mnemos_tags: splitList($("#edit-tags").value),
    specialists: splitList($("#edit-specs").value),
    memory_ids: [...editDraft.memory_ids],
  };
  if (t.priority !== undefined) patch.priority = $("#edit-priority").value || "normal";
  if (force) patch.force = true;
  const btn = $("#edit-submit");
  btn.disabled = true;
  btn.textContent = "Сохранение…";
  try {
    await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    toast("ok", `${t.id}: сохранено`, force ? "изменено принудительно (force)" : "содержание задачи обновлено");
    closeEditModal();
    await refreshBoard();
    if (state.activeTask && state.activeTask.id === t.id) openTask(t.id);
  } catch (err) {
    if (err.status === 423) {
      $("#edit-lock").hidden = false;
      $("#edit-note").textContent = "Сервер: правка задач старше 24 часов — только принудительно.";
    } else {
      $("#edit-note").textContent = "Ошибка: " + err.message;
    }
    btn.disabled = false;
    btn.textContent = "Сохранить";
  }
}

$("#edit-close").addEventListener("click", closeEditModal);
$("#edit-backdrop").addEventListener("click", closeEditModal);
$("#edit-form").addEventListener("submit", (e) => { e.preventDefault(); saveEdit(false); });
$("#edit-force").addEventListener("click", () => {
  if (!confirm("Задача старше 24 часов. Изменить принудительно (force=true)?")) return;
  saveEdit(true);
});
wireMax("#edit-max", "#edit-modal");

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

// UI-9: archive browser v2 (BE-11b) — server-side q/status/col/agent/
// project filters, limit/offset pagination over `items`, `total` for the
// pager. Click a row → read-only detail card; the row button unarchives.
const ARCH_LIMIT = 20;
const archiveBrowser = { q: "", status: "", col: "", agent: "", project: "", offset: 0, total: 0 };

function archQuery() {
  const p = new URLSearchParams();
  for (const k of ["q", "status", "col", "agent", "project"]) {
    if (archiveBrowser[k]) p.set(k, archiveBrowser[k]);
  }
  p.set("limit", String(ARCH_LIMIT));
  p.set("offset", String(archiveBrowser.offset));
  return p.toString();
}

async function openArchiveModal() {
  const modal = $("#dd-modal"), back = $("#dd-backdrop");
  $("#dd-kind").textContent = "архив";
  $("#dd-title").textContent = "Архив задач";
  $("#dd-sub").textContent = "поиск и фильтры · клик по записи — карточка · кнопка — вернуть на доску";
  back.hidden = false; modal.hidden = false;
  modalOpened("dd-modal", closeDdModal);
  requestAnimationFrame(() => { back.classList.add("open"); modal.classList.add("open"); });

  const body = $("#dd-body");
  body.innerHTML = `
    <div class="arch-controls" role="group" aria-label="фильтры архива">
      <input type="search" id="arch-q" class="f-text" placeholder="поиск по названию и summary…" aria-label="поиск в архиве" />
      <select id="arch-status" class="f-sel" aria-label="статус в архиве">
        <option value="">статус: все</option>
        ${Object.entries(STATUS_LABELS).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
      </select>
      <select id="arch-col" class="f-sel" aria-label="колонка архивной задачи">
        <option value="">колонка: все</option>
        ${Object.entries(COLUMN_TITLES).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
      </select>
      <select id="arch-agent" class="f-sel" aria-label="агент в архиве"><option value="">агент: все</option></select>
      <select id="arch-project" class="f-sel" aria-label="проект в архиве"><option value="">проект: все</option></select>
      <button class="f-clear" id="arch-reset" title="сбросить фильтры архива" aria-label="сбросить фильтры архива" hidden>×</button>
    </div>
    <div id="arch-list" class="dd-list"></div>
    <div class="arch-pager" id="arch-pager"></div>`;

  // q with debounce; selects refetch immediately; both reset the page
  let deb = null;
  $("#arch-q").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      archiveBrowser.q = e.target.value.trim();
      archiveBrowser.offset = 0;
      loadArchive();
    }, 300);
  });
  for (const [id, key] of [["#arch-status","status"],["#arch-col","col"],["#arch-agent","agent"],["#arch-project","project"]]) {
    $(id).addEventListener("change", (e) => {
      archiveBrowser[key] = e.target.value;
      e.target.classList.toggle("active", !!e.target.value);
      archiveBrowser.offset = 0;
      loadArchive();
    });
  }
  $("#arch-reset").addEventListener("click", () => {
    Object.assign(archiveBrowser, { q: "", status: "", col: "", agent: "", project: "", offset: 0 });
    for (const id of ["#arch-q","#arch-status","#arch-col","#arch-agent","#arch-project"]) {
      const el = $(id);
      el.value = "";
      el.classList.remove("active");
    }
    loadArchive();
  });
  await loadArchive();
}

async function loadArchive() {
  const list = $("#arch-list"), pager = $("#arch-pager"), reset = $("#arch-reset");
  if (!list) return;
  list.innerHTML = `<div class="column-empty">загрузка…</div>`;
  if (pager) pager.innerHTML = "";
  if (reset) reset.hidden = !(archiveBrowser.q || archiveBrowser.status || archiveBrowser.col || archiveBrowser.agent || archiveBrowser.project);
  let d;
  try { d = await api("/api/archive?" + archQuery()); }
  catch (err) {
    list.innerHTML = `<div class="column-empty">архив недоступен: ${esc(err.message)}</div>`;
    return;
  }
  archiveBrowser.total = d.total ?? d.count ?? 0;
  // clamp the page after the matching set shrank (e.g. after unarchive)
  if (archiveBrowser.offset > 0 && archiveBrowser.offset >= archiveBrowser.total) {
    archiveBrowser.offset = Math.max(0, archiveBrowser.total - ARCH_LIMIT);
    return loadArchive();
  }

  // agent/project select options come from the FULL matching set — the
  // projects grouping is computed server-side before pagination
  const fill = (selId, values, label) => {
    const sel = $(selId);
    if (!sel) return;
    const cur = sel.value;
    const uniq = [...new Set(values.filter(Boolean))].sort();
    sel.innerHTML = `<option value="">${label}: все</option>`
      + uniq.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (uniq.includes(cur)) sel.value = cur;
    sel.classList.toggle("active", !!sel.value);
  };
  const projEntries = Object.entries(d.projects || {});
  const allRows = projEntries.flatMap(([, ts]) => ts);
  fill("#arch-agent", allRows.flatMap((t) => t.agents || []), "агент");
  fill("#arch-project", projEntries.map(([p]) => p).filter((p) => p !== "без проекта"), "проект");

  const items = d.items || [];
  if (!items.length) {
    list.innerHTML = `<div class="column-empty">${archiveBrowser.total ? "на этой странице пусто" : "в архиве ничего не найдено"}</div>`;
  } else {
    list.innerHTML = "";
    for (const t of items) list.appendChild(archiveRow(t));
  }

  if (pager) {
    const total = archiveBrowser.total;
    const from = archiveBrowser.offset + 1;
    const to = archiveBrowser.offset + items.length;
    pager.innerHTML = `
      <button class="mbtn" id="arch-prev" type="button" ${archiveBrowser.offset > 0 ? "" : "disabled"}>← назад</button>
      <span class="arch-page-info">${total ? `${from}–${to} из ${total}` : "0"}</span>
      <button class="mbtn" id="arch-next" type="button" ${to < total ? "" : "disabled"}>вперёд →</button>`;
    $("#arch-prev")?.addEventListener("click", () => {
      archiveBrowser.offset = Math.max(0, archiveBrowser.offset - ARCH_LIMIT);
      loadArchive();
    });
    $("#arch-next")?.addEventListener("click", () => {
      archiveBrowser.offset += ARCH_LIMIT;
      loadArchive();
    });
  }
}

function archiveRow(t) {
  const item = document.createElement("div");
  item.className = "dd-item arch-item";
  item.dataset.id = t.id;
  item.innerHTML = `
    <div class="dd-item-title">${esc(t.id)} · ${esc(t.title)}</div>
    <div class="dd-item-meta">
      ${statusBadge(t)}
      <span class="chip">${esc(COLUMN_TITLES[t.col] || t.col)}</span>
      <span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env || "")}</span>
      ${t.project ? `<span class="chip tagchip tag-project" style="cursor:default">◈ ${esc(t.project)}</span>` : ""}
      ${(t.agents || []).slice(0, 3).map((a) => `<span class="chip chip-agent" title="агент-исполнитель">⚒ ${esc(a)}</span>`).join("")}
      ${t.updated_at ? `<span class="chip">${esc(t.updated_at.slice(0, 10))}</span>` : ""}
    </div>
    <div class="arch-item-actions">
      <button class="btn arch-unarchive" type="button">Вернуть из архива</button>
    </div>`;
  item.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openArchDetail(t);
  });
  item.querySelector(".arch-unarchive").addEventListener("click", () => unarchiveTask(t.id));
  return item;
}

async function unarchiveTask(id) {
  try {
    // BE-11b: the server restores the task to its pre-archive column.
    await api(`/api/tasks/${encodeURIComponent(id)}/unarchive`, { method: "POST" });
    toast("ok", `${id}: возвращена из архива`, "задача снова на доске");
    await refreshBoard();
    refreshArchiveTeaser();
    if ($("#arch-list")) loadArchive(); // keep the browser open for batch restores
  } catch (err) {
    toast("err", "Не удалось вернуть из архива", err.message);
  }
}

// read-only detail card of one archived entry (UI-9): meta, spec, reports
let archDetail = null;

function openArchDetail(t) {
  archDetail = t;
  $("#arch-kind").textContent = "архив";
  $("#arch-status").innerHTML = statusBadge(t);
  $("#arch-title").textContent = t.title || t.id;
  $("#arch-summary").textContent = t.summary || "";
  const tags = (t.mnemos_tags || []).map((tag) => tagChip(tag)).join("");
  $("#arch-body").innerHTML = `
    <div class="dd-section">
      <h2 style="margin:0 0 8px">Метаданные</h2>
      <div class="drawer-meta">
        <span class="chip">${esc(t.id)}</span>
        <span class="chip">колонка: ${esc(COLUMN_TITLES[t.col] || t.col)}</span>
        ${t.archived_from ? `<span class="chip">вернётся в: ${esc(COLUMN_TITLES[t.archived_from] || t.archived_from)}</span>` : ""}
        <span class="chip chip-env">${esc(ENV_LABELS[t.env] || t.env || "")}</span>
        ${t.project ? `<span class="chip tagchip tag-project" style="cursor:default">◈ ${esc(t.project)}</span>` : ""}
        ${(t.agents || []).map((a) => `<span class="chip chip-agent" data-agent="${esc(a)}" title="активность агента">⚒ ${esc(a)}</span>`).join("")}
        ${(t.specialists || []).map((s) => `<span class="chip chip-spec">${esc(s)}</span>`).join("")}
        ${t.updated_at ? `<span class="chip">обновлено ${esc(t.updated_at.slice(0, 10))}</span>` : ""}
      </div>
      ${tags ? `<div class="task-tagrow">${tags}</div>` : ""}
    </div>
    ${t.spec ? `<div class="dd-section"><h2 style="margin:0 0 8px">Спецификация</h2><pre class="drawer-spec">${esc(t.spec)}</pre></div>` : ""}
    <div class="dd-section">
      <h2 style="margin:0 0 8px">Отчёты агентов</h2>
      <div id="arch-reports"><div class="column-empty">загрузка отчётов…</div></div>
    </div>`;
  const d = $("#arch-modal"), b = $("#arch-backdrop");
  b.hidden = false; d.hidden = false;
  modalOpened("arch-modal", closeArchModal);
  requestAnimationFrame(() => { b.classList.add("open"); d.classList.add("open"); });
  // BE-11a: archived tasks keep their report history
  api(`/api/tasks/${encodeURIComponent(t.id)}/reports`)
    .then((r) => {
      const holder = $("#arch-reports");
      if (!holder) return;
      const items = r.items || [];
      if (!items.length) {
        holder.innerHTML = `<div class="column-empty">отчётов нет</div>`;
        return;
      }
      holder.innerHTML = "";
      for (const rep of items) holder.appendChild(reportItem(t, rep, false));
    })
    .catch(() => {
      const holder = $("#arch-reports");
      if (holder) holder.innerHTML = `<div class="column-empty">отчётов нет</div>`;
    });
}

function closeArchModal() {
  const d = $("#arch-modal"), b = $("#arch-backdrop");
  b.classList.remove("open"); d.classList.remove("open");
  modalClosed("arch-modal");
  archDetail = null;
  setTimeout(() => { b.hidden = true; d.hidden = true; }, 220);
}
$("#arch-close").addEventListener("click", closeArchModal);
$("#arch-backdrop").addEventListener("click", closeArchModal);
$("#arch-restore").addEventListener("click", async () => {
  if (!archDetail) return;
  const id = archDetail.id;
  await unarchiveTask(id);
  closeArchModal();
});
wireMax("#arch-max", "#arch-modal");

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
  // BE-9: plugin-level material shared by every agent of the plugin lives
  // in profile.shared (summary like "+2 plugin skills, +3 plugin rules").
  const shared = profile?.shared || {};
  const sharedChip = shared.summary
    ? `<span class="chip chip-shared" title="общий материал плагина ${esc(shared.plugin || "")} — доступен каждому агенту плагина">${esc(shared.summary)}</span>`
    : "";

  $("#dd-body").innerHTML = `
    <div class="dd-section">
      <h2 style="margin:0 0 8px">Состав специалиста<span class="dd-count">${indexed ? "индекс GCW в памяти" : "профиль не индексирован"}</span></h2>
      <div class="drawer-meta">
        <span class="srv-stat-chip">инструкции: <b>${nInstr}</b></span>
        <span class="srv-stat-chip">скиллы: <b>${nSkills}</b></span>
        <span class="srv-stat-chip">правила: <b>${nRules}</b></span>
        <span class="srv-stat-chip">триггеры: <b>${nTrig}</b></span>
        ${nOther ? `<span class="srv-stat-chip">прочее: <b>${nOther}</b></span>` : ""}
        ${sharedChip}
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
wireMax("#draft-max", "#draft-modal");

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
  ctxAdd("Редактировать", "✎", () => openEditModal(t));
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