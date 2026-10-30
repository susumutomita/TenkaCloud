import { COPY } from "./copy.js?v=7b6c3e3ddd";
import { choose, elapse, ROUND_MS, start } from "./model.js?v=7b6c3e3ddd";

let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ja",
  state = start(),
  last = performance.now();
const $ = (id) => document.getElementById(id),
  app = $("app");
function node(tag, text = "", cls = "") {
  const n = document.createElement(tag);
  n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function focusView() {
  const e = $("panel-title") || $("screen-title") || $("result-title");
  e?.focus({ preventScroll: true });
}
function dispatch(action) {
  clock(performance.now());
  state = action === "retry" ? start() : choose(state, action);
  render();
  focusView();
}
function button(id, text, action, cls = "choice") {
  const b = node("button", text, cls);
  b.id = id;
  b.type = "button";
  b.addEventListener("click", () => {
    if (b.isConnected) dispatch(action);
  });
  return b;
}
function heading(text, id = "screen-title") {
  const h = node("h2", text);
  h.id = id;
  h.tabIndex = -1;
  return h;
}
function clock(now) {
  const delta = Math.max(0, now - last);
  last = now;
  if (document.hidden) return;
  const ended = state.outcome;
  state = elapse(state, delta);
  if (!ended && state.outcome) {
    render();
    focusView();
  }
}
function paint() {
  const p = $("request-window");
  if (!p) return;
  p.style.setProperty("--used", `${100 * (1 - state.remaining / ROUND_MS)}%`);
  $("window-label").textContent = state.panel
    ? COPY[lang].paused
    : state.remaining < 8000
      ? COPY[lang].nearing
      : COPY[lang].accepting;
}
function panel(t) {
  const s = node("section", "", "sheet");
  s.setAttribute("aria-labelledby", "panel-title");
  if (state.panel === "tools") {
    s.append(heading(t.toolsHeading, "panel-title"), button("company", t.company, "company"));
    if (state.stage === "setup") s.append(button("verify", t.verify, "verify"));
  } else if (state.panel === "company") {
    s.append(
      heading(t.companyTitle, "panel-title"),
      node("p", t.companyBody),
      node("p", t.companyNext, "muted"),
    );
  } else {
    s.append(
      heading(t.verificationTitle, "panel-title"),
      node("blockquote", state.variant === "install" ? t.installVerified : t.browserVerified),
    );
  }
  s.append(button("close-panel", t.close, "close", "primary"));
  return s;
}
function result(t) {
  const r = node("section", "", "result-panel");
  r.dataset.outcome = state.outcome;
  r.append(
    heading(t[state.outcome], "result-title"),
    node("p", `${t.score}: ${state.points} / 20 ${t.unit}`, "result-score"),
    node("p", t[`${state.outcome}Short`]),
    button("retry", t.retry, "retry", "primary"),
  );
  const d = node("details");
  const reason =
    state.outcome === "resolved"
      ? state.variant === "install"
        ? t.resolvedInstall
        : t.resolvedBrowser
      : t[`${state.outcome}Reason`];
  d.append(node("summary", t.deeper), node("p", reason), node("p", t.nuance));
  r.append(d);
  return r;
}
function header(t) {
  document.documentElement.lang = lang;
  document.title = `${t.title} | TenkaCloud`;
  for (const id of ["title", "instruction", "safety", "games"]) $(id).textContent = t[id];
  $("exit").hidden = true;
  $("games").href = `../portal-demo/?demo=1&goto=${encodeURIComponent(`/problems?lang=${lang}`)}`;
  for (const l of ["ja", "en"]) $(l).setAttribute("aria-pressed", String(lang === l));
}
function dmScreen(content, t) {
  const profile = node("div", "", "profile");
  profile.append(node("span", "KO", "avatar"), node("strong", t.person), node("small", t.role));
  const title =
    state.stage === "dm" ? { ja: "新しいDM", en: "New DM" } : { ja: "メッセージ", en: "Messages" };
  content.append(profile, heading(title[lang]), node("p", t.incoming, "bubble"));
  if (state.stage === "dm") content.append(button("discuss", t.discuss, "discuss", "reply"));
  else
    content.append(
      node("p", t.reply, "bubble self"),
      node("p", t.invitation, "bubble"),
      button("visit", `${t.visit} ↗`, "visit", "site-link"),
    );
}
function siteScreen(content, t) {
  content.append(
    node(
      "div",
      state.variant === "install"
        ? "assessment.komorebi-skills.example"
        : "careers.komorebi.example",
      "address",
    ),
  );
  if (state.stage === "site") {
    content.append(
      node("div", "</>", "site-icon"),
      heading(t.siteIntro),
      button("begin", t.begin, "begin", "primary"),
    );
    return;
  }
  const installing = state.variant === "install";
  content.append(
    node("div", installing ? "↓" : "</>", "site-icon"),
    heading(installing ? t.installHeading : t.browserHeading),
    node("p", installing ? t.installBody : t.browserBody),
    button("proceed", installing ? t.install : t.proceed, "proceed", "primary"),
  );
  if (state.checked && installing) content.append(button("report", t.report, "report", "choice"));
}
function dock(t) {
  const d = node("div", "", "dock"),
    window = node("div", "", "request-window"),
    label = node("span");
  window.id = "request-window";
  label.id = "window-label";
  window.append(label, node("span", lang === "ja" ? "→ 保留" : "→ Hold"));
  const controls = node("div", "", "controls");
  controls.append(button("tools", t.tools, "tools"), button("hold", t.exit, "hold"));
  d.append(window, controls);
  return d;
}
function device(t) {
  const d = node("section", "", "device");
  d.dataset.stage = state.stage;
  const top = node("div", "", "app-bar"),
    chat = state.stage === "dm" || state.stage === "invite";
  top.append(
    node("span", chat ? t.network : t.page),
    node("small", lang === "ja" ? "模擬" : "Simulated"),
  );
  const content = node("div", "", "screen");
  if (chat) dmScreen(content, t);
  else siteScreen(content, t);
  const controls = dock(t);
  d.append(top, content, controls);
  if (state.panel) {
    const overlay = node("div", "", "sheet-backdrop");
    content.inert = true;
    controls.inert = true;
    overlay.append(panel(t));
    d.append(overlay);
  }
  return d;
}
function render() {
  const t = COPY[lang];
  header(t);
  app.replaceChildren();
  app.append(state.outcome ? result(t) : device(t));
  paint();
}

for (const l of ["ja", "en"])
  $(l).addEventListener("click", () => {
    clock(performance.now());
    lang = l;
    const u = new URL(location.href);
    u.searchParams.set("lang", l);
    history.replaceState(null, "", u);
    render();
  });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.panel) {
    e.preventDefault();
    dispatch("close");
  }
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
