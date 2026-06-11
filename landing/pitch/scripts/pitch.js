(function () {
  var deck = document.getElementById("deck");
  if (!deck) return;

  var slides = Array.prototype.slice.call(deck.querySelectorAll(".slide"));
  var progress = document.getElementById("progress");
  var counter = document.getElementById("counter");

  function current() {
    return Math.max(0, Math.min(slides.length - 1, Math.round(deck.scrollTop / deck.clientHeight)));
  }

  function paint() {
    var i = current();
    if (counter) counter.textContent = i + 1 + " / " + slides.length;
    if (progress)
      progress.style.width = (slides.length > 1 ? (i / (slides.length - 1)) * 100 : 100) + "%";
  }

  function go(i) {
    slides[Math.max(0, Math.min(slides.length - 1, i))].scrollIntoView({ behavior: "smooth" });
  }

  function fit() {
    var s = Math.min(window.innerWidth / 1280, window.innerHeight / 720) * 0.995;
    document.documentElement.style.setProperty("--fit", String(s));
  }

  deck.addEventListener("scroll", paint, { passive: true });
  window.addEventListener("resize", fit, { passive: true });
  window.addEventListener("keydown", function (event) {
    if (["ArrowDown", "ArrowRight", "PageDown", " "].indexOf(event.key) > -1) {
      event.preventDefault();
      go(current() + 1);
    } else if (["ArrowUp", "ArrowLeft", "PageUp"].indexOf(event.key) > -1) {
      event.preventDefault();
      go(current() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(0);
    } else if (event.key === "End") {
      event.preventDefault();
      go(slides.length - 1);
    }
  });

  document.querySelectorAll(".slide-shell").forEach(function (shell) {
    ["cloud-far", "cloud-near"].forEach(function (kind) {
      var layer = document.createElement("div");
      layer.className = "cloud-layer " + kind;
      layer.setAttribute("aria-hidden", "true");
      shell.insertBefore(layer, shell.firstChild);
    });
  });

  fit();
  paint();
})();

(function () {
  var board = document.getElementById("tcBoard");
  if (!board) return;

  var TOTAL = 5;
  var teams = [
    { n: "team-honnoji", s: 8662, done: 3 },
    { n: "team-shogun", s: 8420, done: 3, me: true },
    { n: "team-sekigahara", s: 8215, done: 3 },
    { n: "team-osaka", s: 7640, done: 2 },
  ];

  var rowByName = {};
  teams.forEach(function (team) {
    var row = document.createElement("div");
    row.className = "rank-row" + (team.me ? " mine" : "");
    row.innerHTML =
      '<span class="rk"></span>' +
      '<span class="tm"></span>' +
      '<span class="sc"></span>' +
      '<span class="pg"></span>';
    board.appendChild(row);
    rowByName[team.n] = row;
  });

  var elScore = document.getElementById("csScore");
  var elRank = document.getElementById("csRank");
  var scoreTile = document.querySelector(".score-tile");

  function render(hit) {
    var sorted = teams.slice().sort(function (a, b) {
      return b.s - a.s;
    });
    sorted.forEach(function (team, index) {
      var row = rowByName[team.n];
      var rank = index + 1;
      row.querySelector(".rk").innerHTML =
        rank <= 3 ? '<span class="rank-medal">' + rank + "</span>" : String(rank);
      row.querySelector(".tm").textContent = team.n + (team.me ? " (You)" : "");
      row.querySelector(".sc").textContent = team.s.toLocaleString() + " pt";
      row.querySelector(".pg").textContent = team.done + "/" + TOTAL;
      board.appendChild(row);

      if (team.n === hit) {
        row.classList.remove("flash");
        void row.offsetWidth;
        row.classList.add("flash");
      }

      if (team.me) {
        if (elScore) elScore.textContent = team.s.toLocaleString();
        if (elRank) elRank.textContent = rank + "/" + teams.length;
        if (scoreTile && team.n === hit) {
          scoreTile.classList.remove("flash");
          void scoreTile.offsetWidth;
          scoreTile.classList.add("flash");
        }
      }
    });
  }

  render(null);

  var tick = 0;
  setInterval(function () {
    tick++;
    var index =
      tick % 3 === 0
        ? teams.findIndex(function (team) {
            return team.me;
          })
        : Math.floor(Math.random() * teams.length);
    teams[index].s += 40 + Math.floor(Math.random() * 220);
    if (Math.random() < 0.25 && teams[index].done < TOTAL) teams[index].done++;
    render(teams[index].n);
  }, 1500);

  var clock = document.getElementById("tcClock");
  var left = 11 * 60 + 58;
  if (clock) {
    setInterval(function () {
      if (left > 0) left--;
      var h = Math.floor(left / 3600);
      var m = Math.floor((left % 3600) / 60);
      var s = left % 60;
      clock.textContent =
        (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }, 1000);
  }

  var incidents = [
    "auth-setting-removed",
    "ai-wipes-database",
    "site-defaced",
    "supply-chain-backdoor",
    "vibe-app-stopped",
  ];
  var incident = document.getElementById("tcIncident");
  var incidentIndex = 0;

  function fireIncident() {
    var name = incidents[incidentIndex % incidents.length];
    incidentIndex++;
    if (!incident) return;

    incident.className = "incident-line show";
    incident.textContent = "⚡ " + name + " 発生";
    setTimeout(function () {
      incident.className = "incident-line show ok";
      incident.textContent = "復旧 " + name;
    }, 2600);
    setTimeout(function () {
      incident.classList.remove("show");
    }, 3900);
  }

  setTimeout(fireIncident, 1200);
  setInterval(fireIncident, 5000);

  var loopSteps = document.querySelectorAll(".battle-loop .bl-step");
  var loopArrs = document.querySelectorAll(".battle-loop .bl-arr");
  var loopIndex = 0;
  if (loopSteps.length) {
    setInterval(function () {
      loopSteps.forEach(function (el, index) {
        el.classList.toggle("active", index === loopIndex);
      });
      loopArrs.forEach(function (el, index) {
        el.classList.toggle("on", index === loopIndex);
      });
      loopIndex = (loopIndex + 1) % loopSteps.length;
    }, 1500);
  }
})();
