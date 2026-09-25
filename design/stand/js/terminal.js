/* terminal.js — desktop.html mock terminal («дно колодца на столе», spec 04 §6).
 * Honest behavior: real echo typing (8–16ms/char), line-by-line output,
 * working demo commands (help, ls, cat <file>, clear, status), everything else
 * answers truthfully — either `bash: …: команда не найдена` or
 * «команда недоступна в стенде». No fake system output.
 * a11y: role="log" aria-live="polite", real input, ↑/↓ history. */
(function () {
  "use strict";

  var term = document.querySelector(".terminal");
  if (!term) return;
  var out = term.querySelector(".term-out");
  var input = term.querySelector(".term-input");
  var D = window.STAND;
  var FILES = (D && D.termFiles) || {};

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.getAttribute("data-motion") === "reduced";

  var PROMPT = "mnemos@well:~$";
  var history = [];
  var hIdx = -1;
  var busy = false;

  function line(text, cls) {
    var div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text === undefined ? "" : text;
    out.appendChild(div);
    term.scrollTop = term.scrollHeight;
    return div;
  }
  function cmdLine(text) {
    var div = document.createElement("div");
    div.className = "term-cmd";
    var p = document.createElement("span");
    p.className = "prompt";
    p.textContent = PROMPT + " ";
    div.appendChild(p);
    div.appendChild(document.createTextNode(text));
    out.appendChild(div);
    term.scrollTop = term.scrollHeight;
    return div;
  }

  /* honest typing: echo per char 8–16ms; output lines appear line by line */
  function typeEcho(text, done) {
    if (reduced || !text) {
      cmdLine(text);
      done();
      return;
    }
    var div = cmdLine("");
    var span = document.createElement("span");
    div.appendChild(span);
    var i = 0;
    (function step() {
      i++;
      span.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 8 + Math.random() * 8);
      else done();
    })();
  }
  function printLines(lines, done) {
    if (reduced) {
      lines.forEach(function (l) {
        line(l.text, l.cls);
      });
      done();
      return;
    }
    var i = 0;
    (function step() {
      if (i >= lines.length) {
        done();
        return;
      }
      line(lines[i].text, lines[i].cls);
      i++;
      setTimeout(step, 40);
    })();
  }

  function resolveDir(arg) {
    if (!arg) return FILES;
    var path = arg.replace(/\/?$/, "/");
    return Object.prototype.hasOwnProperty.call(FILES, path) && Array.isArray(FILES[path]) ? FILES[path] : null;
  }

  function run(raw) {
    var args = raw.trim().split(/\s+/).filter(Boolean);
    var cmd = args[0] || "";
    if (!cmd) {
      busy = false;
      return;
    }
    function finish() {
      busy = false;
      input.focus();
    }

    if (cmd === "clear") {
      out.textContent = "";
      finish();
      return;
    }
    if (cmd === "help") {
      printLines(
        [
          { text: "Команды стенда:" },
          { text: "  help            — эта таблица" },
          { text: "  ls [путь]       — список файлов демо-дерева" },
          { text: "  cat <файл>      — показать файл (README.md, notes.md, projects/…)" },
          { text: "  status          — демо-статус хранилищ (данные стенда)" },
          { text: "  clear           — очистить экран" },
          { text: "Остальное — честно недоступно: это стенд дизайна, не система." },
        ],
        finish
      );
      return;
    }
    if (cmd === "ls") {
      var dir = resolveDir(args[1]);
      if (!dir) {
        printLines([{ text: "ls: " + (args[1] || "") + ": каталог не найден (дерево стенда — projects/, README.md, notes.md)", cls: "term-err" }], finish);
        return;
      }
      printLines(
        [
          { text: Array.isArray(dir) ? dir.join("  ") : Object.keys(dir).join("  ") },
        ],
        finish
      );
      return;
    }
    if (cmd === "cat") {
      if (!args[1]) {
        printLines([{ text: "cat: укажите файл: cat README.md", cls: "term-err" }], finish);
        return;
      }
      var key = args[1].replace(/^\.\//, "");
      var content = Object.prototype.hasOwnProperty.call(FILES, key) && typeof FILES[key] === "string" ? FILES[key] : null;
      if (!content) {
        printLines([{ text: "cat: " + args[1] + ": файл не найден (см. ls)", cls: "term-err" }], finish);
        return;
      }
      printLines(
        content.split("\n").map(function (l) {
          return { text: l };
        }),
        finish
      );
      return;
    }
    if (cmd === "status") {
      var servers = (D && D.servers) || [];
      printLines(
        [
          { text: "стенд: демо-данные, живой ленты нет", cls: "term-err" },
        ].concat(
          servers.map(function (s) {
            return {
              text: "  " + s.name.padEnd(12) + (s.status === "ok" ? "ok" : "деградация"),
              cls: s.status === "ok" ? "" : "term-err",
            };
          })
        ),
        finish
      );
      return;
    }
    /* known product commands that would pretend to work — honest refusal */
    var stubs = ["cd", "pwd", "git", "curl", "python", "pip", "make", "docker", "ssh", "mnemos", "sync"];
    if (stubs.indexOf(cmd) >= 0) {
      printLines([{ text: cmd + ": команда недоступна в стенде (это мок терминала, не система)", cls: "term-err" }], finish);
      return;
    }
    printLines([{ text: "bash: " + cmd + ": команда не найдена; введите help", cls: "term-err" }], finish);
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      input.value = "";
      return; /* Esc in a window never closes it (spec 04 §6) */
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length) {
        hIdx = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
        input.value = history[hIdx];
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hIdx >= 0 && hIdx < history.length - 1) {
        hIdx++;
        input.value = history[hIdx];
      } else {
        hIdx = -1;
        input.value = "";
      }
      return;
    }
    if (e.key !== "Enter" || busy) return;
    var raw = input.value;
    input.value = "";
    hIdx = -1;
    if (raw.trim()) history.push(raw.trim());
    busy = true;
    typeEcho(raw, function () {
      run(raw);
    });
  });

  term.addEventListener("click", function () {
    input.focus();
  });

  /* welcome line (spec 04 §6 microcopy) */
  line("Колодец открыт. Введите help — покажу, что умею", "term-cmd");
})();
