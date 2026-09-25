/* shell.js — «Живая кора» stand: sidebar, topbar, command palette, hotkeys, toasts.
 * Vanilla JS, no dependencies. All navigation between stand pages = real <a href>.
 * Guard rule (spec 03 §7): hotkeys except Esc/Ctrl+K are ignored inside inputs. */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var store = {
    get: function (k, d) {
      try {
        return localStorage.getItem("stand-" + k) || d;
      } catch (e) {
        return d;
      }
    },
    set: function (k, v) {
      try {
        localStorage.setItem("stand-" + k, v);
      } catch (e) {
        /* file:// without storage — stand still works */
      }
    },
  };

  function inInput(e) {
    var t = e.target;
    return t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
  }

  /* ── Toast: single action→feedback channel (spec 05 §3) ─────────────── */
  var toastRegion = null;
  var toastTimer = null;
  function toast(text, type) {
    if (!toastRegion) {
      toastRegion = doc.createElement("div");
      toastRegion.className = "toast-region";
      toastRegion.setAttribute("role", "status");
      toastRegion.setAttribute("aria-live", "polite");
      doc.body.appendChild(toastRegion);
    }
    toastRegion.textContent = "";
    var el = doc.createElement("div");
    el.className = "toast";
    el.dataset.type = type || "info";
    el.textContent = text;
    toastRegion.appendChild(el);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add("leaving");
      setTimeout(function () {
        el.remove();
      }, 120);
    }, 4000);
    el.addEventListener("mouseenter", function () {
      if (toastTimer) clearTimeout(toastTimer);
    });
    el.addEventListener("mouseleave", function () {
      toastTimer = setTimeout(function () {
        el.classList.add("leaving");
        setTimeout(function () {
          el.remove();
        }, 120);
      }, 2000);
    });
  }
  window.standToast = toast;

  /* ── Focus transfer to H1 after palette/hotkey navigation (03 §8) ───── */
  if (store.get("focus-h1", "") === "1") {
    store.set("focus-h1", "");
    var h1 = doc.querySelector("h1[tabindex='-1']");
    if (h1) {
      h1.focus({ preventScroll: false });
    }
  }
  function go(url) {
    store.set("focus-h1", "1");
    window.location.href = url;
  }
  window.standGo = go;

  /* ── Theme + density + motion ───────────────────────────────────────── */
  function applyTheme(t) {
    if (t === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    doc.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    });
  }
  applyTheme(store.get("theme", "dark"));
  doc.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    store.set("theme", next);
    applyTheme(next);
    toast(next === "light" ? "Тема: береста (светлая)" : "Тема: колодец (тёмная)", "info");
  });
  function applyMotion(m) {
    if (m === "reduced") root.setAttribute("data-motion", "reduced");
    else root.removeAttribute("data-motion");
  }
  applyMotion(store.get("motion", "auto"));
  doc.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-motion-toggle]");
    if (!btn) return;
    var next = root.getAttribute("data-motion") === "reduced" ? "auto" : "reduced";
    store.set("motion", next);
    applyMotion(next);
    toast(next === "reduced" ? "Движение сокращено (состояния без анимации)" : "Движение: канон «Живой коры»", "info");
  });
  doc.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-density-toggle]");
    if (!btn) return;
    var next = root.getAttribute("data-density") === "compact" ? "comfortable" : "compact";
    store.set("density", next);
    root.setAttribute("data-density", next);
    toast(next === "compact" ? "Плотность: операционная (32px строки)" : "Плотность: созерцательная (56px строки)", "info");
  });
  root.setAttribute("data-density", store.get("density", "comfortable"));

  /* ── Sidebar: collapse, one domain open (03 §3) ─────────────────────── */
  var app = doc.querySelector(".app");
  if (store.get("sidebar", "open") === "collapsed") app.classList.add("sidebar-collapsed");
  function toggleSidebar() {
    var collapsed = app.classList.toggle("sidebar-collapsed");
    store.set("sidebar", collapsed ? "collapsed" : "open");
    doc.querySelectorAll("[data-sidebar-toggle]").forEach(function (b) {
      b.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  }
  doc.addEventListener("click", function (e) {
    if (e.target.closest("[data-sidebar-toggle]")) toggleSidebar();
  });
  doc.querySelectorAll(".side-group > .side-domain").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var group = btn.parentElement;
      var open = group.hasAttribute("data-open");
      doc.querySelectorAll(".side-group[data-open]").forEach(function (g) {
        g.querySelector(".side-domain").setAttribute("aria-expanded", "false");
        g.removeAttribute("data-open");
      });
      if (!open) {
        group.setAttribute("data-open", "");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ── Topbar: search, lang, bell ─────────────────────────────────────── */
  var topInput = doc.querySelector(".topsearch input");
  if (topInput) {
    topInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (topInput.value) topInput.value = "";
        else topInput.blur();
      }
      if (e.key === "Enter") {
        go("search.html?q=" + encodeURIComponent(topInput.value.trim()));
      }
    });
    doc.querySelectorAll("[data-search-expand]").forEach(function (b) {
      b.addEventListener("click", function () {
        var wrap = doc.querySelector(".topsearch");
        wrap.classList.toggle("open");
        if (wrap.classList.contains("open")) topInput.focus();
      });
    });
  }
  doc.querySelectorAll("[data-lang-demo]").forEach(function (b) {
    b.addEventListener("click", function () {
      toast("Переключение RU|EN — в стенде не переведено; рабочий на «Документах» (РУС|ORIG)", "info");
    });
  });
  doc.querySelectorAll("[data-bell]").forEach(function (b) {
    b.addEventListener("click", function () {
      toast("Уведомления: в стенде лента не подключена — демо-данные", "info");
    });
  });
  doc.querySelectorAll("[data-share]").forEach(function (b) {
    b.addEventListener("click", function () {
      toast("Поделиться обзором — действие продуктовой версии, в стенде заглушка", "info");
    });
  });

  /* Honest stubs: any [data-demo-action] explains itself (feedback canon) */
  doc.addEventListener("click", function (e) {
    var el = e.target.closest("[data-demo-action]");
    if (!el) return;
    toast(el.getAttribute("data-demo-action"), "info");
  });

  /* ── Overlays: palette, modals — one stack, Esc pops the top (03 §7) ── */
  function openOverlay(el, opener) {
    el.hidden = false;
    el.dataset.opener = opener ? Array.prototype.indexOf.call(doc.querySelectorAll("body *"), opener) : "";
    var focusable = el.querySelector(".palette-input") || el.querySelector("button, [href], input");
    if (focusable) focusable.focus();
  }
  function closeOverlay(el) {
    el.hidden = true;
    if (el.dataset.opener) {
      var n = parseInt(el.dataset.opener, 10);
      var orig = doc.querySelectorAll("body *")[n];
      if (orig) orig.focus();
    }
  }

  /* ── Command palette (Ctrl+K, 03 §6) ────────────────────────────────── */
  var palette = doc.getElementById("palette");
  var pInput = palette && palette.querySelector(".palette-input");
  var pResults = palette && palette.querySelector(".palette-results");
  var pItems = [];
  var pActive = 0;

  function paletteCommands() {
    var D = window.STAND || { memories: [] };
    var nav = [
      { title: "Обзор", href: "index.html", keys: "обзор главная home" },
      { title: "Записи", href: "memories.html", keys: "записи память memory" },
      { title: "Поиск по памяти", href: "search.html", keys: "поиск поиск search" },
      { title: "Документы", href: "docs.html", keys: "документы docs хабы" },
      { title: "Агенты · Исполнение", href: "agents.html", keys: "агенты исполнение agents" },
      { title: "Рабочий стол · Терминал", href: "desktop.html", keys: "терминал стол desk" },
      { title: "Проводник проектов", href: "explorer.html", keys: "проводник файлы explorer" },
      { title: "Галерея дизайн-системы", href: "gallery.html", keys: "галерея дизайн токены" },
    ].map(function (c) {
      return { group: "Переход", title: c.title, keys: c.keys, href: c.href };
    });
    var actions = [
      { group: "Действия", title: "Новая задача", keys: "создать задача новая", act: "task" },
      { group: "Действия", title: "Сменить тему", keys: "тема тёмная светлая береста", act: "theme" },
      { group: "Действия", title: "Плотность: операционная / созерцательная", keys: "плотность компакт", act: "density" },
      { group: "Действия", title: "Сменить язык RU|EN", keys: "язык язык en ru", act: "lang" },
    ];
    var ents = (D.memories || []).slice(0, 6).map(function (m) {
      return {
        group: "Сущности",
        title: m.id + " · " + m.title,
        keys: (m.tags || []).join(" "),
        href: "memories.html?id=" + m.id,
      };
    });
    ents.push(
      { group: "Сущности", title: "агент agb", keys: "агент агент writer", href: "agents.html" },
      { group: "Сущности", title: "агент core", keys: "агент ядро", href: "agents.html" },
      { group: "Сущности", title: "документы mnemos-eyes", keys: "хаб доки", href: "docs.html#mnemos-eyes" }
    );
    return nav.concat(actions, ents);
  }

  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function markMatch(title, q) {
    if (!q) return esc(title);
    var i = title.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(title);
    return (
      esc(title.slice(0, i)) + "<mark>" + esc(title.slice(i, i + q.length)) + "</mark>" + esc(title.slice(i + q.length))
    );
  }

  function renderPalette(q) {
    var cmds = paletteCommands().map(function (c, i) {
      c._i = i;
      return c;
    });
    var ql = q.trim().toLowerCase();
    var found = cmds.filter(function (c) {
      return !ql || (c.title + " " + c.keys).toLowerCase().indexOf(ql) >= 0;
    });
    found.sort(function (a, b) {
      var pa = !ql || a.title.toLowerCase().startsWith(ql) ? 0 : 1;
      var pb = !ql || b.title.toLowerCase().startsWith(ql) ? 0 : 1;
      return pa - pb || a._i - b._i;
    });
    pItems = found;
    pActive = 0;
    if (!found.length) {
      pResults.innerHTML =
        '<div class="palette-empty"><span>Ничего не нашлось по «' +
        esc(q) +
        "».</span>" +
        '<a class="btn secondary sm" href="search.html?q=' +
        encodeURIComponent(q.trim()) +
        '">Запустить поиск по памяти →</a></div>';
      return;
    }
    var html = "";
    var lastGroup = null;
    found.forEach(function (c, idx) {
      if (c.group !== lastGroup) {
        html += '<div class="palette-group">' + c.group + "</div>";
        lastGroup = c.group;
      }
      html +=
        '<button type="button" class="palette-item" role="option" id="pal-opt-' +
        idx +
        '" data-idx="' +
        idx +
        '" data-active="' +
        (idx === 0) +
        '">' +
        markMatch(c.title, ql) +
        (c.href ? '<span class="palette-id">' + esc(c.href.replace(".html", "").replace(/^/, "/")) + "</span>" : "") +
        "</button>";
    });
    pResults.innerHTML = html;
    pResults.querySelectorAll(".palette-item").forEach(function (it) {
      it.addEventListener("click", function () {
        runPaletteItem(parseInt(it.dataset.idx, 10));
      });
      it.addEventListener("mousemove", function () {
        setActive(parseInt(it.dataset.idx, 10));
      });
    });
  }

  function setActive(idx) {
    if (!pItems.length) return;
    pActive = (idx + pItems.length) % pItems.length;
    pResults.querySelectorAll(".palette-item").forEach(function (it) {
      it.dataset.active = parseInt(it.dataset.idx, 10) === pActive ? "true" : "false";
    });
    if (pInput) pInput.setAttribute("aria-activedescendant", "pal-opt-" + pActive);
    var cur = pResults.querySelector('.palette-item[data-idx="' + pActive + '"]');
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function runPaletteItem(idx) {
    var c = pItems[idx];
    if (!c) return;
    closeOverlay(palette);
    if (c.act === "theme") {
      doc.querySelector("[data-theme-toggle]") && doc.querySelector("[data-theme-toggle]").click();
      return;
    }
    if (c.act === "density") {
      doc.querySelector("[data-density-toggle]") && doc.querySelector("[data-density-toggle]").click();
      return;
    }
    if (c.act === "lang") {
      toast("Переключение RU|EN — в стенде не переведено", "info");
      return;
    }
    if (c.act === "task") {
      toast("Новая задача — действие продуктовой версии; в стенде задач нет", "info");
      return;
    }
    if (c.href) {
      toast("Перешли: " + c.title.split(" · ")[0].replace(/^агент |^документы /, ""), "success");
      go(c.href);
    }
  }

  function openPalette() {
    if (!palette) return;
    openOverlay(palette);
    renderPalette("");
  }
  window.standOpenPalette = openPalette;

  if (palette) {
    doc.addEventListener("click", function (e) {
      if (e.target.closest("[data-palette-open]")) {
        openPalette();
        return;
      }
      if (e.target === palette) closeOverlay(palette);
    });
    pInput.addEventListener("input", function () {
      renderPalette(pInput.value);
    });
    pInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(pActive + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(pActive - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        runPaletteItem(pActive);
      }
    });
    palette.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeOverlay(palette);
      }
    });
  }

  /* ── Hotkeys cheat-sheet modal (03 §7) ──────────────────────────────── */
  var cheatsheet = doc.getElementById("cheatsheet");
  if (cheatsheet) {
    doc.addEventListener("click", function (e) {
      if (e.target.closest("[data-cheatsheet-open]")) openOverlay(cheatsheet);
      if (e.target === cheatsheet) closeOverlay(cheatsheet);
      if (e.target.closest("[data-modal-close]")) closeOverlay(e.target.closest(".overlay"));
    });
  }
  function anyOpenOverlay() {
    return doc.querySelector(".overlay:not([hidden])");
  }

  /* ── Global hotkeys ─────────────────────────────────────────────────── */
  var gArmed = null;
  var gIndicator = doc.querySelector(".gprefix");
  var gTimer = null;
  function armG() {
    gArmed = true;
    if (gIndicator) gIndicator.classList.add("on");
    if (gTimer) clearTimeout(gTimer);
    gTimer = setTimeout(disarmG, 1500);
  }
  function disarmG() {
    gArmed = null;
    if (gIndicator) gIndicator.classList.remove("on");
  }
  var gMap = {
    o: "index.html",
    m: "memories.html",
    t: "memories.html", // tasks domain has no stand page → Записи is honest closest? No: честнее тост
    a: "agents.html",
    d: "docs.html",
    w: "desktop.html",
    s: "explorer.html",
    p: "memories.html",
    b: "memories.html",
    e: "agents.html",
  };
  /* честность: t/b ведут на разделы без стенда — тост, а не подмена */
  var gStub = { t: "Задачи", b: "Канбан" };

  doc.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (palette && !palette.hidden) closeOverlay(palette);
      else openPalette();
      return;
    }
    if (e.key === "Escape") {
      var ov = anyOpenOverlay();
      if (ov) {
        e.preventDefault();
        closeOverlay(ov);
      } else if (app.classList.contains("side-open")) {
        app.classList.remove("side-open");
      }
      return;
    }
    /* focus trap for the topmost overlay (palette, modals) — Tab never escapes */
    var topOverlay = anyOpenOverlay();
    if (e.key === "Tab" && topOverlay) {
      var f = topOverlay.querySelectorAll("button, input, a[href], select, textarea");
      if (f.length) {
        var firstF = f[0];
        var lastF = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === firstF) {
          e.preventDefault();
          lastF.focus();
        } else if (!e.shiftKey && doc.activeElement === lastF) {
          e.preventDefault();
          firstF.focus();
        }
      }
      return;
    }
    if (inInput(e)) return;
    if (e.key === "/") {
      e.preventDefault();
      if (topInput) topInput.focus();
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      if (cheatsheet) openOverlay(cheatsheet);
      return;
    }
    if (e.key === "[") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (e.key === "g") {
      armG();
      return;
    }
    if (gArmed && gMap[e.key.toLowerCase()]) {
      var k = e.key.toLowerCase();
      disarmG();
      if (gStub[k]) {
        toast("«" + gStub[k] + "» — раздел вне стенда; в сайдбаре помечен как недоступный", "info");
        return;
      }
      toast("Перешли: " + k, "success");
      go(gMap[k]);
    }
  });

  /* ── Mobile drawer close on nav click ───────────────────────────────── */
  doc.querySelectorAll(".sidebar a").forEach(function (a) {
    a.addEventListener("click", function () {
      app.classList.remove("side-open");
    });
  });
})();
