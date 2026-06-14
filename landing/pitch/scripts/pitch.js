(() => {
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
    if (counter) counter.textContent = `${i + 1} / ${slides.length}`;
    if (progress)
      progress.style.width = `${slides.length > 1 ? (i / (slides.length - 1)) * 100 : 100}%`;
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
  window.addEventListener("keydown", (event) => {
    var target = event.target;
    var tagName = target?.tagName;
    var isInteractive =
      target &&
      (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].indexOf(tagName) > -1);
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isInteractive)
      return;

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

  document.querySelectorAll(".slide-shell").forEach((shell) => {
    ["cloud-far", "cloud-near"].forEach((kind) => {
      var layer = document.createElement("div");
      layer.className = `cloud-layer ${kind}`;
      layer.setAttribute("aria-hidden", "true");
      shell.insertBefore(layer, shell.firstChild);
    });
  });

  fit();
  paint();
})();

(() => {
  var board = document.getElementById("tcBoard");
  if (!board) return;

  var TOTAL = 5;
  var teams = [
    { n: "team-honnoji", s: 4120, done: 5 },
    { n: "team-shogun", s: 3980, done: 5, me: true },
    { n: "team-osaka", s: 3860, done: 5 },
    { n: "team-sekigahara", s: 3720, done: 5 },
  ];

  var rowByName = {};
  teams.forEach((team) => {
    var row = document.createElement("div");
    row.className = `cs-row${team.me ? " mine" : ""}`;
    row.innerHTML =
      '<span class="cs-rk' +
      (team.me ? " me" : "") +
      '"></span>' +
      '<span class="cs-tm' +
      (team.me ? " me" : "") +
      '"></span>' +
      '<span class="cs-sc"></span>' +
      '<span class="cs-pg"></span>';
    board.appendChild(row);
    rowByName[team.n] = row;
  });

  var elScore = document.getElementById("csScore");
  var elRank = document.getElementById("csRank");
  var scoreBadge = document.querySelector(".cs-util");
  var notif = document.getElementById("tcNotif");

  function flashElement(element) {
    if (!element) return;
    element.classList.remove("flash");
    void element.offsetWidth;
    element.classList.add("flash");
  }

  function updateOwnStats(team, rank, hit) {
    if (!team.me) return;
    if (elScore) elScore.textContent = team.s.toLocaleString();
    if (elRank) elRank.textContent = `${rank}/${teams.length}`;
    if (team.n === hit) flashElement(scoreBadge);
  }

  function renderTeamRow(team, index, hit) {
    var row = rowByName[team.n];
    var rank = index + 1;
    row.querySelector(".cs-rk").textContent = `#${rank}`;
    row.querySelector(".cs-tm").innerHTML =
      `${team.n}${team.me ? ' <span class="cs-you">(You)</span>' : ""}`;
    row.querySelector(".cs-sc").textContent = `${team.s.toLocaleString()} pt`;
    row.querySelector(".cs-pg").textContent = `${team.done} / ${TOTAL}`;
    board.appendChild(row);

    if (team.n === hit) flashElement(row);
    updateOwnStats(team, rank, hit);
  }

  function render(hit) {
    var sorted = teams.slice().sort((a, b) => b.s - a.s);
    sorted.forEach((team, index) => {
      renderTeamRow(team, index, hit);
    });
  }

  render(null);

  var tick = 0;
  setInterval(() => {
    tick++;
    var index =
      tick % 3 === 0
        ? teams.findIndex((team) => team.me)
        : Math.floor(Math.random() * teams.length);
    teams[index].s += 20 + Math.floor(Math.random() * 90);
    if (Math.random() < 0.12 && teams[index].done < TOTAL) teams[index].done++;
    render(teams[index].n);
    if (notif && tick % 4 === 0) {
      notif.textContent = String(Number(notif.textContent || "10") + 1);
      notif.classList.remove("flash");
      void notif.offsetWidth;
      notif.classList.add("flash");
    }
  }, 1500);

  var clock = document.getElementById("tcClock");
  var left = 11 * 60 + 58;
  if (clock) {
    setInterval(() => {
      if (left > 0) left--;
      var h = Math.floor(left / 3600);
      var m = Math.floor((left % 3600) / 60);
      var s = left % 60;
      clock.textContent = `${(h < 10 ? "0" : "") + h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
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

    incident.className = "cs-incident show fire";
    incident.textContent = `${name} 発生`;
    setTimeout(() => {
      incident.className = "cs-incident show ok";
      incident.textContent = `復旧 ${name}`;
    }, 2600);
    setTimeout(() => {
      incident.classList.remove("show");
    }, 3900);
  }

  setTimeout(fireIncident, 1200);
  setInterval(fireIncident, 5000);

  var loopSteps = document.querySelectorAll(".battle-loop .bl-step");
  var loopArrs = document.querySelectorAll(".battle-loop .bl-arr");
  var loopIndex = 0;
  if (loopSteps.length) {
    setInterval(() => {
      loopSteps.forEach((el, index) => {
        el.classList.toggle("active", index === loopIndex);
      });
      loopArrs.forEach((el, index) => {
        el.classList.toggle("on", index === loopIndex);
      });
      loopIndex = (loopIndex + 1) % loopSteps.length;
    }, 1500);
  }
})();
