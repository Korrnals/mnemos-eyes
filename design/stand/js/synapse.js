/* synapse.js — «живость памяти»: canvas well for the Overview screen.
 * Rules of the canon (specs 01/04/06):
 *  - impulses run along edges ONLY on real feed events (recall=iris, write=gold, error=red),
 *    decay ≤240ms, ≤6 concurrent, ≤1 per edge;
 *  - node breathing: 5s period, amplitude ≤0.06 opacity; drift ≤4px/s — the only ambient;
 *  - pre-rendered radial glow sprites (offscreen) + globalCompositeOperation 'lighter';
 *  - DPR cap 2, pause on document.hidden, ≤300 nodes (~50 here);
 *  - <50fps → 150 nodes, glow off, console warning;
 *  - reduced motion (OS or [data-motion="reduced"]) → static composition + event edge
 *    tints for 1.5s, no animation.
 * No libraries. */
(function () {
  "use strict";

  var hero = document.querySelector(".well-hero");
  if (!hero) return;
  var canvas = hero.querySelector(".well-canvas");
  var ctx = canvas.getContext("2d");
  var D = window.STAND;
  if (!D) return;

  /* ── Theme colors from tokens (theme-aware, no raw hex) ─────────────── */
  function colorVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function parseColor(s) {
    s = s.trim();
    if (s[0] === "#") {
      var h = s.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(/[\s,/]+/).filter(Boolean);
      return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])];
    }
    return [122, 138, 158];
  }

  var COL = {};
  function refreshColors() {
    COL.iris = colorVar("--color-iris", "#1a8a96");
    COL.irisBright = colorVar("--color-iris-bright", "#4fc2ce");
    COL.idle = colorVar("--synapse-idle", "rgb(122 138 158 / 0.35)");
    COL.recall = colorVar("--synapse-recall", "#4fc2ce");
    COL.write = colorVar("--synapse-write", "#c9933a");
    COL.error = colorVar("--synapse-error", "#e0655c");
    COL.myelin = colorVar("--myelin-strong", "rgb(230 237 243 / 0.14)");
  }
  refreshColors();

  /* ── Deterministic layout (stable across visits) ────────────────────── */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var nodes = [];
  var edges = [];
  var byId = {};

  function buildGraph() {
    nodes = [];
    edges = [];
    byId = {};
    var rnd = mulberry32(20260925);
    var src = D.wellNodes || D.memories;
    var mems = src.slice(0, 70); // hard cap: well under the 300 limit
    var W = hero.clientWidth || 900;
    var H = hero.clientHeight || 280;

    // 4 project clusters in a row (jittered): reads as a tissue of colonies
    var k = 4;
    var centers = [];
    for (var c = 0; c < k; c++) {
      centers.push({
        x: W * ((c + 0.5) / k) + (rnd() - 0.5) * W * 0.05,
        y: H * 0.5 + (rnd() - 0.5) * H * 0.3,
      });
    }

    mems.forEach(function (m, i) {
      var ci = (m.cluster != null ? m.cluster : i) % centers.length;
      var cl = centers[ci];
      var ang = rnd() * Math.PI * 2;
      var rad = Math.pow(rnd(), 0.65); // плотнее к центру кластера
      var spread = Math.min(W * 0.09, H * 0.34);
      var age = m.age || 24;
      var r0 = Math.max(2, Math.min(4, 4 - (age / 288) * 2));
      var n = {
        id: m.id,
        m: m,
        cluster: ci,
        x: Math.max(24, Math.min(W - 24, cl.x + Math.cos(ang) * rad * spread)),
        y: Math.max(16, Math.min(H - 16, cl.y + Math.sin(ang) * rad * spread * 0.8)),
        r: r0,
        phase: i * 0.7,
        vx: (rnd() - 0.5) * 2, // px per second (≤4)
        vy: (rnd() - 0.5) * 2,
      };
      nodes.push(n);
      byId[m.id] = n;
    });

    // edges: short, mostly intra-cluster + a few nearest bridges (no long chords)
    var maxD = W * 0.28; // acceptance cap: ~28% canvas width
    var deg = nodes.map(function () { return 0; });
    var pairs = [];
    nodes.forEach(function (a, i) {
      for (var j = i + 1; j < nodes.length; j++) {
        var b = nodes[j];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < maxD) pairs.push({ i: i, j: j, d: d, same: a.cluster === b.cluster });
      }
    });
    pairs.sort(function (p, q) { return p.d - q.d; });
    var bridges = 0;
    var seen = {};
    pairs.forEach(function (p) {
      if (edges.length > 110 || deg[p.i] >= 4 || deg[p.j] >= 4) return;
      var key = p.i < p.j ? p.i + "|" + p.j : p.j + "|" + p.i;
      if (seen[key]) return;
      if (p.same || (p.d < W * 0.12 && bridges < 6)) {
        if (!p.same) bridges++;
        seen[key] = 1;
        edges.push([p.i, p.j]);
        deg[p.i]++;
        deg[p.j]++;
      }
    });
  }

  /* ── Glow sprites (pre-rendered, 'lighter') ─────────────────────────── */
  var sprites = {};
  function sprite(color) {
    if (sprites[color]) return sprites[color];
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var g = c.getContext("2d");
    var rgb = parseColor(color);
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(" + rgb.join(",") + ",0.5)");
    grad.addColorStop(0.4, "rgba(" + rgb.join(",") + ",0.18)");
    grad.addColorStop(1, "rgba(" + rgb.join(",") + ",0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites[color] = c;
    return c;
  }

  /* ── State ──────────────────────────────────────────────────────────── */
  var pulses = []; // {e:[i,j], t0, color}
  var tints = []; // reduced-motion static edge tints {e, t0, color}
  var hoverIdx = -1;
  var selIdx = -1;
  var fpsLow = false;
  var glowOn = true;
  var warned = false;

  var reduced = false;
  function calcReduced() {
    return (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.getAttribute("data-motion") === "reduced"
    );
  }
  reduced = calcReduced();
  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (mq.addEventListener) mq.addEventListener("change", onModeChange);
  new MutationObserver(onModeChange).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  function onModeChange() {
    var was = reduced;
    reduced = calcReduced();
    if (was !== reduced) {
      if (!reduced) startLoop();
      else render(0);
    }
  }

  /* ── Resize / DPR cap 2 ─────────────────────────────────────────────── */
  var dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = hero.clientWidth * dpr;
    canvas.height = hero.clientHeight * dpr;
    buildGraph();
    if (reduced) render(0);
  }
  window.addEventListener("resize", resize);

  /* ── Live region + tooltip (DOM, not canvas — spec 05 §2.7) ─────────── */
  var live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  hero.appendChild(live);
  var tip = document.createElement("div");
  tip.className = "node-tip";
  tip.hidden = true;
  tip.setAttribute("aria-hidden", "true");
  hero.appendChild(tip);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("aria-label", "Колодец памяти: узлы — воспоминания, линии — синапсы. Стрелки — выбор узла, Enter — открыть запись в ленте.");

  function nodeMeta(n) {
    return n.m.id + " · " + n.m.title + " · " + n.m.prov.replace(/·[^·]*$/, "").trim() + " · уверенность " + n.m.conf.toFixed(2);
  }
  function showTip(n, mx, my) {
    tip.innerHTML = "";
    var b = document.createElement("strong");
    b.textContent = n.m.id + " · " + n.m.title;
    var s = document.createElement("span");
    s.className = "tip-meta";
    s.textContent = n.m.age + " ч · уверенность " + n.m.conf.toFixed(2);
    tip.appendChild(b);
    tip.appendChild(s);
    tip.hidden = false;
    var tw = tip.offsetWidth;
    var x = Math.min(Math.max(mx + 14, 8), hero.clientWidth - tw - 8);
    var y = Math.max(my - 52, 8);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip() {
    tip.hidden = true;
  }

  /* ── Selection ↔ feed sync (ARIA-linked) ────────────────────────────── */
  function selectNode(i, announce) {
    selIdx = i;
    var n = nodes[i];
    if (!n) return;
    var row = document.querySelector('.feed-row[data-mem="' + n.m.id + '"]');
    document.querySelectorAll(".feed-row.flash").forEach(function (r) {
      r.classList.remove("flash");
    });
    if (row) {
      row.classList.add("flash");
      row.scrollIntoView({ block: "nearest" });
      canvas.setAttribute("aria-describedby", row.id || "");
    } else {
      canvas.removeAttribute("aria-describedby");
    }
    if (announce) {
      live.textContent = row
        ? "Выбрано: " + n.m.id + " «" + n.m.title + "» — запись подсвечена в ленте"
        : "Выбрано: " + n.m.id + " «" + n.m.title + "»; в ленте за последний час этой записи нет";
    }
    if (reduced) render(0);
  }

  function hitTest(mx, my) {
    var best = -1;
    var bd = 100;
    nodes.forEach(function (n, i) {
      var d = (n.x - mx) * (n.x - mx) + (n.y - my) * (n.y - my);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
  canvas.addEventListener("mousemove", function (e) {
    var r = canvas.getBoundingClientRect();
    var mx = e.clientX - r.left;
    var my = e.clientY - r.top;
    var i = hitTest(mx, my);
    if (i !== hoverIdx) {
      hoverIdx = i;
      canvas.style.cursor = i >= 0 ? "pointer" : "default";
      if (reduced) render(0);
    }
    if (i >= 0) showTip(nodes[i], mx, my);
    else hideTip();
  });
  canvas.addEventListener("mouseleave", function () {
    hoverIdx = -1;
    hideTip();
    if (reduced) render(0);
  });
  canvas.addEventListener("click", function (e) {
    var r = canvas.getBoundingClientRect();
    var i = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (i >= 0) selectNode(i, true);
  });
  canvas.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      selectNode(selIdx + 1 < nodes.length ? selIdx + 1 : 0, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      selectNode(selIdx - 1 >= 0 ? selIdx - 1 : nodes.length - 1, true);
    } else if (e.key === "Escape") {
      selIdx = -1;
      live.textContent = "Выбор узла снят";
      if (reduced) render(0);
    }
  });
  canvas.addEventListener("focus", function () {
    if (reduced) render(0);
  });

  /* ── Impulses: only on real feed events (06 §5) ─────────────────────── */
  window.addEventListener("stand:pulse", function (e) {
    var kind = e.detail.kind; // recall | write | error
    var color = kind === "write" ? COL.write : kind === "error" ? COL.error : COL.recall;
    var memId = e.detail.mem;
    // pick an edge touching that memory (fallback: any edge)
    var cand = [];
    edges.forEach(function (ed, i) {
      var a = nodes[ed[0]];
      var b = nodes[ed[1]];
      if ((a && a.id === memId) || (b && b.id === memId)) cand.push(i);
    });
    var ei = cand.length ? cand[Math.floor(Math.random() * cand.length)] : Math.floor(Math.random() * edges.length);
    if (ei == null || !edges[ei]) return;
    if (pulses.some(function (p) { return p.ei === ei; })) return; // ≤1 per edge
    if (pulses.length >= 6) return; // global cap
    if (reduced) {
      tints.push({ ei: ei, t0: performance.now(), color: color });
      render(0);
      return;
    }
    pulses.push({ ei: ei, t0: performance.now(), color: color });
  });

  /* ── Render ─────────────────────────────────────────────────────────── */
  function render(now) {
    var W = canvas.width / dpr;
    var H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var focusIdx = hoverIdx >= 0 ? hoverIdx : selIdx;
    var focusNode = focusIdx >= 0 ? nodes[focusIdx] : null;
    var adj = {};
    if (focusNode) {
      edges.forEach(function (ed) {
        if (nodes[ed[0]] === focusNode) adj[ed[1]] = 1;
        if (nodes[ed[1]] === focusNode) adj[ed[0]] = 1;
      });
    }

    // edges (myelin hairlines); spotlight: unrelated edges dim to 40%
    ctx.lineWidth = 0.5;
    edges.forEach(function (ed) {
      var a = nodes[ed[0]];
      var b = nodes[ed[1]];
      if (!a || !b) return;
      var strong = focusNode && (a === focusNode || b === focusNode);
      if (strong) {
        ctx.strokeStyle = COL.myelin;
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = COL.idle;
        ctx.globalAlpha = focusNode ? 0.4 : 1;
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // reduced-motion: static event tints (1.5s), no moving dots
    if (reduced) {
      tints = tints.filter(function (t) {
        return performance.now() - t.t0 < 1500;
      });
      tints.forEach(function (t) {
        var a = nodes[edges[t.ei][0]];
        var b = nodes[edges[t.ei][1]];
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.5;
    }

    // nodes: light pre-rendered halo per node + iris cores; breath 5s ±0.06
    var breathT = now || 0;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    var halo = sprite(COL.iris);
    nodes.forEach(function (n, i) {
      var dimmed = focusNode && n !== focusNode && !adj[i];
      var alpha = dimmed ? 0.4 : 1;
      var breath = reduced ? 1 : 1 + 0.06 * Math.sin((breathT / 5000) * Math.PI * 2 + n.phase);
      var hs = n.r * 10;
      ctx.globalAlpha = (dimmed ? 0.05 : 0.12) * breath;
      ctx.drawImage(halo, n.x - hs / 2, n.y - hs / 2, hs, hs);
      if (n === focusNode && glowOn) {
        ctx.globalAlpha = 0.8 * breath;
        var sp = sprite(COL.irisBright);
        ctx.drawImage(sp, n.x - n.r * 6, n.y - n.r * 6, n.r * 12, n.r * 12);
      }
    });
    ctx.restore();
    nodes.forEach(function (n, i) {
      var dimmed = focusNode && n !== focusNode && !adj[i];
      var alpha = dimmed ? 0.4 : 1;
      var breath = reduced ? 1 : 1 + 0.06 * Math.sin((breathT / 5000) * Math.PI * 2 + n.phase);
      ctx.globalAlpha = Math.min(1, alpha * breath);
      ctx.fillStyle = n === focusNode ? COL.irisBright : COL.iris;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n === focusNode) {
        // focus ring / selection ring drawn around the node (2px)
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = COL.irisBright;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    // pulses: running dots along edges, ≤240ms (not in reduced mode)
    if (!reduced) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      pulses = pulses.filter(function (p) {
        var dt = now - p.t0;
        if (dt > 240) return false;
        var a = nodes[edges[p.ei][0]];
        var b = nodes[edges[p.ei][1]];
        var k = dt / 240;
        var x = a.x + (b.x - a.x) * k;
        var y = a.y + (b.y - a.y) * k;
        var fade = 1 - k;
        ctx.globalAlpha = 0.9 * fade;
        var sp = sprite(p.color);
        var s = 22;
        ctx.drawImage(sp, x - s / 2, y - s / 2, s, s);
        return true;
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* ── rAF loop: drift, breath, fps monitor ───────────────────────────── */
  var raf = null;
  var last = 0;
  var frameAcc = 0;
  var frameN = 0;
  function loop(now) {
    if (reduced) {
      raf = null;
      return;
    }
    if (document.hidden) {
      raf = null;
      return; // pause; visibilitychange restarts
    }
    var dt = last ? Math.min(64, now - last) : 16;
    last = now;
    // fps monitor (spec 06 §8): <50fps → 150 nodes, glow off
    frameAcc += dt;
    frameN++;
    if (frameN >= 30) {
      var fps = 1000 / (frameAcc / frameN);
      frameAcc = 0;
      frameN = 0;
      if (fps < 50 && !fpsLow) {
        fpsLow = true;
        glowOn = false;
        nodes = nodes.slice(0, 150);
        edges = edges.filter(function (ed) {
          return ed[0] < 150 && ed[1] < 150;
        });
        if (!warned) {
          warned = true;
          console.warn("[stand] колодец: <50fps — узлы сокращены до 150, glow-спрайты отключены");
        }
      }
    }
    // drift ≤4px/s with soft bounce
    var k = dt / 1000;
    var W = canvas.width / dpr;
    var H = canvas.height / dpr;
    nodes.forEach(function (n) {
      n.x += n.vx * k;
      n.y += n.vy * k;
      if (n.x < 20 || n.x > W - 20) n.vx *= -1;
      if (n.y < 16 || n.y > H - 16) n.vy *= -1;
    });
    render(now);
    raf = requestAnimationFrame(loop);
  }
  function startLoop() {
    if (raf == null && !reduced) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) startLoop();
  });

  /* first paint before rAF starts (spec 04 §1: rAF after first paint) */
  resize();
  requestAnimationFrame(function () {
    if (reduced) render(0);
    else startLoop();
  });

  /* ── Demo feed: events drive pulses AND the live feed (honest demo) ── */
  var feedEl = document.querySelector(".feed");
  var pool = D.feedPool || [];
  var pi = 0;
  function fmtNow() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function pushEvent(ev) {
    if (!feedEl) return;
    var row = document.createElement("div");
    row.className = "feed-row fresh";
    row.dataset.ev = ev.ev;
    row.dataset.mem = ev.mem;
    row.id = "feed-" + ev.mem + "-" + Date.now();
    var dot = document.createElement("span");
    dot.className = "ev-dot";
    dot.setAttribute("aria-hidden", "true");
    var txt = document.createElement("span");
    txt.textContent = ev.text;
    var tm = document.createElement("span");
    tm.className = "ev-time";
    tm.textContent = fmtNow();
    row.appendChild(dot);
    row.appendChild(txt);
    row.appendChild(tm);
    feedEl.prepend(row);
    while (feedEl.children.length > 8) feedEl.lastElementChild.remove();
    window.dispatchEvent(new CustomEvent("stand:pulse", { detail: { kind: ev.ev, mem: ev.mem } }));
    var c = document.getElementById("pulses-hour");
    if (c) c.textContent = String(parseInt(c.textContent.replace(/\s/g, ""), 10) + 1).replace(/(\d)(?=(\d{3})+$)/g, "$1 ");
  }
  function nextEvent() {
    pushEvent(pool[pi % pool.length]);
    pi++;
  }
  if (feedEl && pool.length) {
    setTimeout(nextEvent, 2500);
    (function schedule() {
      setTimeout(function () {
        if (!document.hidden) nextEvent();
        schedule();
      }, 5000 + Math.random() * 4000);
    })();
  }
})();
