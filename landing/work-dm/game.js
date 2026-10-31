import { COPY } from "./copy.js?v=82ce93a3e3";
import {
  CONNECTIONS,
  choose,
  elapse,
  ROUND_MS,
  SOURCES,
  score,
  start,
} from "./model.js?v=82ce93a3e3";

let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ja";
let state = start();
let last = performance.now();
const $ = (id) => document.getElementById(id);
function node(tag, text = "", cls = "") {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function button(id, text, action, cls = "") {
  const b = node("button", text, cls);
  b.id = id;
  b.type = "button";
  b.addEventListener("click", () => {
    if (b.isConnected) dispatch(action);
  });
  return b;
}
function heading(text, id) {
  const h = node("h2", text);
  h.id = id;
  h.tabIndex = -1;
  return h;
}
function focusAfter(action) {
  if (state.outcome) return $("result-title")?.focus();
  const ids = {
    collect: `fact-${action.id}`,
    select: `card-${action.id}`,
    connect:
      state.notice === "linked" ? `arm-${state.connected.at(-1)}` : `card-${state.collected[0]}`,
    arm: "request-target",
    present: "opponent-reply",
    open: "view-title",
    board: state.board ? "board-title" : "view-title",
    retry: "view-title",
  };
  $(ids[action.type])?.focus({ preventScroll: ["collect", "select"].includes(action.type) });
}
function dispatch(action) {
  clock(performance.now());
  state = action.type === "retry" ? start() : choose(state, action);
  last = performance.now();
  render();
  focusAfter(action);
}
function clock(now) {
  const delta = Math.max(0, now - last);
  last = now;
  if (document.hidden) return;
  const wasOver = state.outcome;
  state = elapse(state, delta);
  if (!wasOver && state.outcome) {
    render();
    $("result-title")?.focus();
  }
}
function fact(id, t) {
  const b = button(`fact-${id}`, "", { type: "collect", id }, "fact");
  const saved = state.collected.includes(id);
  b.setAttribute("aria-label", `${saved ? t.savedPin : t.pin}: ${t.facts[id]}`);
  b.append(node("span", t.facts[id]), node("span", saved ? "✓" : "+", "pin"));
  b.querySelector(".pin").setAttribute("aria-hidden", "true");
  b.dataset.fact = id;
  return b;
}
function pageNav(t) {
  const n = node("nav", "", "page-nav");
  n.setAttribute("aria-label", t.sources);
  for (const [view, label] of Object.entries(t.views)) {
    const b = button(`open-${view}`, label, { type: "open", view });
    b.setAttribute("aria-current", String(view === state.view));
    n.append(b);
  }
  return n;
}
function dm(t) {
  const d = node("div", "", "dm");
  const profile = button("profile-open", "", { type: "open", view: "profile" }, "profile-link");
  profile.setAttribute("aria-label", t.profileOpen);
  profile.append(
    node("span", "HO", "avatar"),
    node("strong", t.sender),
    node("small", t.senderRole),
  );
  const request = state.armed
    ? button("request-target", "", { type: "present" }, "bubble request target")
    : node("div", "", "bubble request");
  request.append(node("p", t.request));
  if (state.armed) request.append(node("strong", `${t.target} ↓`, "target-label"));
  d.append(profile, node("p", t.greeting, "bubble"), request);
  const link = button("assessment-link", "", { type: "open", view: "assessment" }, "link-preview");
  link.append(
    node("span", "↗", "site-icon"),
    node("strong", t.openSite),
    node("small", t.facts.domain),
  );
  d.append(link);
  if (state.presented.length) {
    for (const id of state.presented)
      d.append(node("p", `${t.presented}: ${t.links[id]}`, "bubble self"));
    const reply = node("p", t.reply, "bubble");
    reply.id = "opponent-reply";
    reply.tabIndex = -1;
    d.append(reply);
  }
  return d;
}
function sourcePage(t) {
  const s = node("section", "", "browser");
  s.append(pageNav(t));
  const screen = node("div", "", "screen");
  screen.append(heading(t.sourceNames[state.view], "view-title"));
  const pages = {
    dm: () => screen.append(dm(t)),
    profile: () => screen.append(node("p", t.profileBio), fact("role", t)),
    assessment: () =>
      screen.append(
        fact("domain", t),
        node("div", "↓", "app-symbol"),
        node("h3", t.assessmentTitle),
        node("p", t.assessmentLead),
        node("small", t.fileLabel),
        fact("application", t),
        fact("deadline", t),
      ),
    official: () => {
      screen.append(node("h3", t.officialTitle), node("p", t.officialLead, "muted"));
      for (const id of [
        "officialDomain",
        "officialApplication",
        "officialDeadline",
        "officialRole",
      ])
        screen.append(fact(id, t));
    },
  };
  pages[state.view]();
  screen.append(node("p", t.evidenceHint, "caption"));
  s.append(screen);
  return s;
}
function slots(t) {
  const row = node("div", "", "slots");
  for (let i = 0; i < 2; i++) {
    const id = state.selected[i];
    const slot = id
      ? button(`slot-${i}`, t.facts[id], { type: "select", id }, "slot filled")
      : node("div", `${t.slot} ${i + 1}\n${t.slotEmpty}`, "slot");
    if (id) slot.setAttribute("aria-label", `${t.clearSlot}: ${t.facts[id]}`);
    row.append(slot);
  }
  row.append(node("span", "↔", "connector"));
  return row;
}
function connection(id, t) {
  const c = node("article", "", "connection");
  c.dataset.connection = id;
  c.append(node("h3", t.links[id]));
  const pair = node("div", "", "pair-lines");
  for (const factId of CONNECTIONS[id]) pair.append(node("p", t.facts[factId]));
  c.append(pair);
  if (state.presented.includes(id)) c.append(node("strong", `✓ ${t.presented}`, "presented"));
  else c.append(button(`arm-${id}`, t.useConnection, { type: "arm", id }, "primary"));
  return c;
}
function notebook(t) {
  const n = node("section", "", "notebook");
  n.append(heading(t.notebook, "board-title"), node("p", t.selection, "caption"), slots(t));
  const join = button("connect", `${t.connect} ↔`, { type: "connect" }, "primary");
  join.disabled = state.selected.length !== 2;
  n.append(join, node("p", t.notices[state.notice] || "", "board-feedback"));
  const list = node("div", "", "evidence-cards");
  for (const id of state.collected) {
    const b = button(`card-${id}`, "", { type: "select", id }, "evidence-card");
    b.append(node("small", t.views[SOURCES[id]]), node("span", t.facts[id]));
    b.setAttribute("aria-pressed", String(state.selected.includes(id)));
    list.append(b);
  }
  if (!state.collected.length) list.append(node("p", t.empty, "empty"));
  n.append(list);
  for (const id of state.connected) n.append(connection(id, t));
  return n;
}
function result(t) {
  const r = node("section", "", "result-panel");
  r.dataset.outcome = state.outcome;
  r.append(
    heading(t[state.outcome], "result-title"),
    node("p", `${t.score}: ${score(state)} / 100`, "result-score"),
    node("p", `${t.progress}: ${state.presented.length} / 2`),
    node("p", t.resultSummary, "caption"),
    button("retry", t.retry, { type: "retry" }, "primary"),
    node("h3", t.review),
  );
  for (const [id, pair] of Object.entries(CONNECTIONS)) {
    const e = node("section", "", "result-evidence");
    e.append(node("h3", t.links[id]));
    for (const factId of pair) {
      const line = node("blockquote");
      line.append(node("small", t.views[SOURCES[factId]]), node("mark", t.facts[factId]));
      e.append(line);
    }
    e.append(node("p", t.explanations[id]));
    r.append(e);
  }
  const details = node("details");
  details.append(node("summary", t.details), node("p", t.nuance));
  r.append(details);
  return r;
}
function deadline(t) {
  const d = node("div", "", "request-window");
  d.id = "request-window";
  const label = node("span");
  label.id = "window-label";
  d.append(label, node("span", t.windowEnd));
  return d;
}
function workspace(t) {
  const w = node("div", "", state.board ? "workspace board-open" : "workspace");
  w.append(sourcePage(t), notebook(t));
  return w;
}
function render() {
  const t = COPY[lang];
  document.documentElement.lang = lang;
  document.title = `${t.title} | TenkaCloud`;
  for (const id of ["title", "instruction", "format", "safety", "games"]) $(id).textContent = t[id];
  $("games").href = `../portal-demo/?demo=1&goto=${encodeURIComponent(`/problems?lang=${lang}`)}`;
  for (const l of ["ja", "en"]) $(l).setAttribute("aria-pressed", String(lang === l));
  $("feedback").textContent = t.notices[state.notice] || "";
  const app = $("app");
  app.replaceChildren();
  if (state.outcome) app.append(result(t));
  else {
    app.append(
      node("p", `${t.goal} · ${state.presented.length}/2 · ${score(state)}/100`, "case-status"),
      node(
        "p",
        `${t.chances}: ${"●".repeat(3 - state.mistakes)}${"○".repeat(state.mistakes)}`,
        "chances",
      ),
      deadline(t),
      workspace(t),
    );
    const modes = node("nav", "", "mobile-modes");
    modes.setAttribute("aria-label", t.sources);
    modes.append(
      button("show-sources", t.sources, { type: "board", open: false }),
      button("show-board", `${t.notebook} (${state.collected.length})`, {
        type: "board",
        open: true,
      }),
    );
    app.append(modes);
  }
  paint();
}
function paint() {
  const d = $("request-window");
  if (!d) return;
  d.style.setProperty("--used", `${100 * (1 - state.remaining / ROUND_MS)}%`);
  $("window-label").textContent =
    state.remaining < 20_000 ? COPY[lang].windowClosing : COPY[lang].windowOpen;
}
for (const l of ["ja", "en"])
  $(l).addEventListener("click", () => {
    clock(performance.now());
    lang = l;
    const u = new URL(location.href);
    u.searchParams.set("lang", l);
    history.replaceState(null, "", u);
    render();
    $(l).focus();
  });
document.addEventListener("visibilitychange", () => {
  last = performance.now();
});
render();
function frame(now) {
  clock(now);
  paint();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
