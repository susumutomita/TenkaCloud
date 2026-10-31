import { COPY, shareHref } from "./copy.js?v=b753193fc7";
import { choose, elapse, hits, ROUND_MS, score, start, TASKS } from "./model.js?v=b753193fc7";

let lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "ja";
let state = start();
let last = performance.now();
const shotReadyAt = new Map();
const $ = (id) => document.getElementById(id);
function node(tag, text = "", cls = "") {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function canActivate(action, event, moved) {
  if (["reveal", "fire"].includes(action.type) && event.detail > 0 && moved) return false;
  if (action.type === "begin" && event.detail > 1) return false;
  if (action.type !== "fire") return true;
  if (event.detail > 1 || performance.now() < (shotReadyAt.get(action.id) || 0)) {
    $("feedback").textContent = COPY[lang].releaseHint;
    return false;
  }
  return true;
}
function button(id, text, action, cls = "") {
  const b = node("button", text, cls);
  b.type = "button";
  b.id = id;
  let origin = null,
    moved = false;
  if (["reveal", "fire"].includes(action.type)) {
    b.addEventListener("pointerdown", (e) => {
      origin = { x: e.clientX, y: e.clientY };
      moved = false;
    });
    b.addEventListener("pointermove", (e) => {
      if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 8) moved = true;
    });
    b.addEventListener("pointercancel", () => {
      moved = true;
      origin = null;
    });
  }
  b.addEventListener("click", (event) => {
    if (b.isConnected && canActivate(action, event, moved)) dispatch(action);
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
function impact(id) {
  const target = $(`tile-${id}`)?.getBoundingClientRect();
  if (!target) return;
  $("impact")?.remove();
  const e = node("div", "⌖", "impact");
  e.id = "impact";
  e.setAttribute("aria-hidden", "true");
  e.style.left = `${target.x + target.width / 2}px`;
  e.style.top = `${target.y + target.height / 2}px`;
  document.body.append(e);
  setTimeout(() => e.remove(), 260);
}
function nextTarget() {
  const id = state.order.find((item) => !state.shots.includes(item));
  if (!id) return "finish";
  return state.revealed.includes(id) ? `shoot-${id}` : `peel-${id}`;
}
function focusAfter(action) {
  if (state.outcome) return $("result-title")?.focus();
  if (state.paused) return $("resume")?.focus();
  const targets = {
    reveal: `shoot-${action.id}`,
    fire: state.phase === "practice" ? "begin" : `tile-${state.flash}`,
    retry: state.phase === "practice" ? "peel-practice" : nextTarget(),
    begin: nextTarget(),
    resume: "pause",
  };
  $(targets[action.type])?.focus({
    preventScroll: action.type === "fire" && state.phase === "play",
  });
  if (action.type === "reveal") $(`tile-${action.id}`)?.scrollIntoView({ block: "center" });
}
function dispatch(action) {
  clock(performance.now());
  const previous = state;
  state =
    action.type === "retry"
      ? start(Math.random, state.phase === "practice")
      : choose(state, action);
  if (state === previous) return;
  if (["retry", "begin"].includes(action.type) || state.outcome) shotReadyAt.clear();
  if (action.type === "reveal") shotReadyAt.set(action.id, performance.now() + 500);
  last = performance.now();
  render();
  focusAfter(action);
  if (
    action.type === "fire" &&
    (state.shots.length > previous.shots.length || state.practiceShot !== previous.practiceShot)
  )
    impact(action.id);
}
function cover(id, t, key = id) {
  const b = button(`peel-${key}`, "", { type: "reveal", id: key }, "cover");
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
    if (progress >= 0.35 && b.isConnected) dispatch({ type: "reveal", id: key });
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
function revealedTile(e, id, key, t, spent, correct, training) {
  const target = button(`shoot-${key}`, "", { type: "fire", id: key }, "target");
  target.setAttribute(
    "aria-label",
    `${t.fire}: ${t.covers[id]}, ${t.actions[TASKS[id].kind]}, ${TASKS[id].site}.example`,
  );
  target.disabled = spent;
  const waiting = performance.now() < (shotReadyAt.get(key) || 0);
  target.setAttribute("aria-disabled", String(spent || waiting));
  target.append(payload(id, t), node("small", waiting ? t.releaseHint : t.directFire, "shot-hint"));
  e.append(target);
  if (spent)
    e.append(
      node(
        "span",
        training ? t.practiceBlocked : correct ? `＋50 · ${t.blocked}` : `−25 · ${t.matched}`,
        "shot-label",
      ),
    );
  if (state.notice === "revealed" && state.flash === key) {
    const peel = cover(id, t, key);
    peel.tabIndex = -1;
    peel.disabled = true;
    peel.setAttribute("aria-hidden", "true");
    e.append(peel);
  }
}
function tile(id, t, training = false) {
  const key = training ? "practice" : id;
  const revealed = training ? state.practiceRevealed : state.revealed.includes(id);
  const spent = training ? state.practiceShot : state.shots.includes(id);
  const correct = spent && (training || Boolean(TASKS[id].mismatch));
  const e = node("article", "", "tile");
  e.id = `tile-${key}`;
  e.tabIndex = -1;
  if (revealed) e.classList.add("revealed");
  if (spent) e.classList.add(correct ? "hit" : "miss");
  if (state.flash === key)
    e.classList.add(`flash-${state.notice === "practiceHit" ? "hit" : state.notice}`);
  if (revealed) revealedTile(e, id, key, t, spent, correct, training);
  else e.append(cover(id, t, key));
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
  const remaining = 4 - state.revealed.length;
  const finish = button(
    "finish",
    remaining ? t.finishRemaining.replace("{count}", String(remaining)) : t.finish,
    { type: "finish" },
    "finish",
  );
  finish.disabled = remaining !== 0;
  c.append(finish);
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
function lesson(t) {
  const p = node("section", "", "practice-panel");
  const hint = state.practiceShot
    ? t.practiceDone
    : state.practiceRevealed
      ? t.practiceCompare
      : t.practicePeel;
  p.append(node("p", hint, "lesson-hint"), tile("application", t, true));
  if (state.practiceShot) p.append(button("begin", t.begin, { type: "begin" }, "primary begin"));
  return p;
}
function play(t) {
  const p = node("div", "", "play");
  const training = state.phase === "practice";
  const sender = node("div", "", "sender");
  sender.append(
    node("span", "AO", "avatar"),
    node("strong", t.sender),
    node("span", training ? t.practiceMessage : t.message),
  );
  const status = node("div", "", "status");
  status.append(node("span", training ? t.practiceLabel : `${t.progress} ${hits(state)}/2`));
  if (!training) status.append(node("strong", `${score(state)}/100`));
  const pause = button("pause", "Ⅱ", { type: "pause" }, "pause");
  pause.setAttribute("aria-label", t.pause);
  status.append(pause);
  p.append(sender, reference(t), status);
  if (training) {
    p.append(lesson(t));
    return p;
  }
  const deadline = node("div", "", "request-window");
  deadline.id = "request-window";
  const label = node("span");
  label.id = "window-label";
  deadline.append(label, node("span", t.deadlineEnd));
  const arena = node("section", "", "arena");
  arena.setAttribute("aria-label", t.message);
  for (const id of state.order) arena.append(tile(id, t));
  p.append(deadline, arena, node("p", t.finishHint, "caption"), controls(t));
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
  for (const id of ["title", "instruction", "safety", "games"]) $(id).textContent = t[id];
  $("format").textContent =
    state.phase === "practice" && !state.outcome ? t.practiceLabel : t.format;
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
  for (const [id, until] of shotReadyAt) {
    if (performance.now() < until) continue;
    shotReadyAt.delete(id);
    const target = $(`shoot-${id}`);
    if (target && !target.disabled) {
      target.setAttribute("aria-disabled", "false");
      const hint = target.querySelector(".shot-hint");
      if (hint) hint.textContent = COPY[lang].directFire;
    }
  }
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
document.addEventListener("keydown", (event) => {
  if (
    event.repeat &&
    event.target instanceof Element &&
    event.target.closest(".cover,.target,.begin")
  )
    event.preventDefault();
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
