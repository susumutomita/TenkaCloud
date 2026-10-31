import { COPY, shareHref } from "./copy.js?v=e6c7188599";
import { choose, elapse, hits, ROUND_MS, score, start, TASKS } from "./model.js?v=e6c7188599";

let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ja";
let state = start();
let last = performance.now();
const $ = (id) => document.getElementById(id);
function node(tag, text = "", cls = "") {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(id, text, action, cls = "") {
  const b = node("button", text, cls);
  b.type = "button";
  b.id = id;
  b.addEventListener("click", () => {
    if (b.isConnected) dispatch(action);
  });
  return b;
}
function heading(text, id) {
  const e = node("h2", text);
  e.id = id;
  e.tabIndex = -1;
  return e;
}
function clock(now) {
  const delta = Math.max(0, now - last);
  last = now;
  if (document.hidden) return;
  const ended = state.outcome;
  state = elapse(state, delta);
  if (!ended && state.outcome) {
    render();
    $("result-title")?.focus();
  }
}
function shotLine(id) {
  const target = $(`tile-${id}`)?.getBoundingClientRect();
  const cannon = $("fire")?.getBoundingClientRect();
  if (!target || !cannon) return null;
  return {
    x: cannon.x + cannon.width / 2,
    y: cannon.y,
    tx: target.x + target.width / 2,
    ty: target.y + target.height / 2,
  };
}
function beam(line) {
  if (!line) return;
  $("beam")?.remove();
  const e = node("div", "", "beam");
  e.id = "beam";
  e.setAttribute("aria-hidden", "true");
  const dx = line.tx - line.x,
    dy = line.ty - line.y;
  e.style.left = `${line.x}px`;
  e.style.top = `${line.y}px`;
  e.style.width = `${Math.hypot(dx, dy)}px`;
  e.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  document.body.append(e);
  setTimeout(() => e.remove(), 260);
}
function nextTarget() {
  const id = state.order.find((item) => !state.shots.includes(item));
  if (!id) return "finish";
  return state.revealed.includes(id) ? `aim-${id}` : `peel-${id}`;
}
function focusAfter(action) {
  if (state.outcome) return $("result-title")?.focus();
  if (state.paused) return $("resume")?.focus();
  const targets = {
    reveal: `aim-${action.id}`,
    aim: "fire",
    fire: `tile-${state.flash}`,
    retry: nextTarget(),
    resume: "pause",
  };
  $(targets[action.type])?.focus({ preventScroll: ["aim", "fire"].includes(action.type) });
  if (action.type === "reveal") $(`tile-${action.id}`)?.scrollIntoView({ block: "center" });
}
function dispatch(action) {
  clock(performance.now());
  const line = action.type === "fire" ? shotLine(state.aim) : null;
  const previous = state;
  state = action.type === "retry" ? start() : choose(state, action);
  if (state === previous) return;
  last = performance.now();
  render();
  focusAfter(action);
  if (action.type === "fire" && state.shots.length > previous.shots.length) beam(line);
}
function cover(id, t) {
  const b = button(`peel-${id}`, "", { type: "reveal", id }, "cover");
  b.setAttribute("aria-label", `${t.peel}: ${t.covers[id]}`);
  b.append(node("span", "↔", "rub-icon"), node("strong", t.covers[id]), node("small", t.peelHint));
  let x = null,
    progress = 0;
  b.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    x = event.clientX;
    progress = 0;
    b.setPointerCapture(event.pointerId);
  });
  b.addEventListener("pointermove", (event) => {
    if (x === null) return;
    progress = Math.min(1, Math.abs(event.clientX - x) / (b.offsetWidth * 0.65));
    b.style.setProperty("--peel", String(progress));
  });
  b.addEventListener("pointerup", () => {
    if (progress >= 0.35 && b.isConnected) dispatch({ type: "reveal", id });
    else b.style.setProperty("--peel", "0");
    x = null;
  });
  b.addEventListener("pointercancel", () => {
    x = null;
    progress = 0;
    b.style.setProperty("--peel", "0");
  });
  return b;
}
function payload(id, t) {
  const task = TASKS[id];
  const p = node("div", "", "payload");
  p.append(
    node("span", task.kind === "APP" ? "⚙" : "▣", "payload-icon"),
    node("strong", task.kind, "payload-kind"),
    node("span", t.actions[task.kind], "payload-action"),
    node("strong", task.site, "site-name"),
    node("small", ".example", "site-suffix"),
  );
  return p;
}
function revealedTile(e, id, t, spent, correct) {
  const target = button(`aim-${id}`, "", { type: "aim", id }, "target");
  target.setAttribute(
    "aria-label",
    `${t.aim}: ${t.covers[id]}, ${t.actions[TASKS[id].kind]}, ${TASKS[id].site}.example`,
  );
  target.setAttribute("aria-pressed", String(state.aim === id));
  target.disabled = spent;
  target.append(payload(id, t));
  e.append(target);
  if (spent)
    e.append(node("span", correct ? `＋50 · ${t.blocked}` : `−25 · ${t.matched}`, "shot-label"));
  if (state.notice === "revealed" && state.flash === id) {
    const peel = cover(id, t);
    peel.tabIndex = -1;
    peel.disabled = true;
    peel.setAttribute("aria-hidden", "true");
    e.append(peel);
  }
}
function tile(id, t) {
  const revealed = state.revealed.includes(id),
    spent = state.shots.includes(id);
  const correct = spent && Boolean(TASKS[id].mismatch);
  const e = node("article", "", "tile");
  e.id = `tile-${id}`;
  e.tabIndex = -1;
  if (revealed) e.classList.add("revealed");
  if (state.aim === id) e.classList.add("aimed");
  if (spent) e.classList.add(correct ? "hit" : "miss");
  if (state.flash === id) e.classList.add(`flash-${state.notice}`);
  if (revealed) revealedTile(e, id, t, spent, correct);
  else e.append(cover(id, t));
  return e;
}
function reference(t) {
  const r = node("section", "", "reference");
  r.setAttribute("aria-label", t.reference);
  r.append(node("small", `✓ ${t.reference}`));
  const rules = node("div", "", "rules");
  rules.append(node("strong", `▣ ${t.webOnly}`));
  const domain = node("span");
  domain.append(node("small", t.destination), node("strong", `${t.policyDomain}.example`));
  rules.append(domain);
  r.append(rules);
  return r;
}
function controls(t) {
  const c = node("div", "", "controls");
  const fire = button("fire", `⌖ ${t.fire}`, { type: "fire" }, "fire");
  fire.disabled = !state.aim;
  const finish = button("finish", t.finish, { type: "finish" }, "finish");
  finish.disabled = state.revealed.length !== 4;
  c.append(fire, finish);
  return c;
}
function pauseDialog(t) {
  const d = node("dialog", "", "pause-panel");
  d.setAttribute("aria-labelledby", "pause-title");
  d.append(
    heading(t.paused, "pause-title"),
    button("resume", t.resume, { type: "resume" }, "primary"),
    button("hold", t.hold, { type: "hold" }),
  );
  d.addEventListener("cancel", (event) => {
    event.preventDefault();
    dispatch({ type: "resume" });
  });
  return d;
}
function play(t) {
  const p = node("div", "", "play");
  const sender = node("div", "", "sender");
  sender.append(node("span", "AO", "avatar"), node("strong", t.sender), node("span", t.message));
  const status = node("div", "", "status");
  status.append(
    node("span", `${t.progress} ${hits(state)}/2`),
    node("strong", `${score(state)}/100`),
    button("pause", "Ⅱ", { type: "pause" }, "pause"),
  );
  status.querySelector("button").setAttribute("aria-label", t.pause);
  const deadline = node("div", "", "request-window");
  deadline.id = "request-window";
  const label = node("span");
  label.id = "window-label";
  deadline.append(label, node("span", t.deadlineEnd));
  const arena = node("section", "", "arena");
  arena.setAttribute("aria-label", t.message);
  for (const id of state.order) arena.append(tile(id, t));
  p.append(
    sender,
    reference(t),
    status,
    deadline,
    arena,
    node("p", t.finishHint, "caption"),
    controls(t),
  );
  return p;
}
function result(t) {
  const r = node("section", "", "result-panel");
  r.dataset.outcome = state.outcome;
  const title = state.outcome === "complete" && score(state) === 100 ? t.cleared : t[state.outcome];
  r.append(heading(title, "result-title"));
  if (state.outcome === "held") r.append(node("p", t.heldNote));
  else r.append(node("p", `${t.score}: ${score(state)} / 100 ${t.unit}`, "result-score"));
  r.append(button("retry", t.retry, { type: "retry" }, "primary"));
  const share = node("a", t.share, "share");
  share.href = shareHref(state, lang, location.href, score(state), hits(state));
  share.target = "_blank";
  share.rel = "noopener noreferrer";
  r.append(share, node("h3", t.review));
  for (const id of ["application", "upload", "calendar", "task"]) {
    const e = node("div", "", "result-evidence");
    e.append(
      node("strong", t.covers[id]),
      node("p", `${TASKS[id].kind} · ${TASKS[id].site}.example`),
      node("p", t.explanations[TASKS[id].mismatch || "normal"]),
    );
    r.append(e);
  }
  const details = node("details");
  details.append(node("summary", t.more), node("p", t.safeNext));
  r.append(details);
  return r;
}
function render() {
  const t = COPY[lang];
  document.documentElement.lang = lang;
  document.title = `${t.title} | TenkaCloud`;
  for (const id of ["title", "instruction", "format", "safety", "games"]) $(id).textContent = t[id];
  $("games").href = `../portal-demo/?demo=1&goto=${encodeURIComponent(`/problems?lang=${lang}`)}`;
  for (const l of ["ja", "en"]) $(l).setAttribute("aria-pressed", String(lang === l));
  $("feedback").textContent = t.notices[state.notice] || "";
  $("app").replaceChildren(state.outcome ? result(t) : play(t));
  if (state.paused) {
    const d = pauseDialog(t);
    $("app").append(d);
    d.showModal();
  }
  paint();
}
function paint() {
  const e = $("request-window");
  if (!e) return;
  e.style.setProperty("--used", `${100 * (1 - state.remaining / ROUND_MS)}%`);
  $("window-label").textContent =
    state.remaining < 20000 ? COPY[lang].closing : COPY[lang].deadline;
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
