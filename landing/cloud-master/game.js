import { loadCatalog } from "./api-catalog.js";
import {
  collect,
  createGame,
  finish,
  INPUT_GUARD_MS,
  next,
  pause,
  resume,
  start,
  tick,
} from "./engine.js";
import { flowPositions } from "./motion.js";
import { difficulty } from "./recognition.js";
import { buildShare } from "./share.js";
import { formatSurvival } from "./time.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let activeGestureCancel = null;
let layoutBlocked = false,
  layoutKey = "";
const BEST_KEY = "tenkacloud.api-watch.best.v1";
let bestMs = 0;
try {
  const value = Number(localStorage.getItem(BEST_KEY));
  if (Number.isFinite(value) && value >= 0) bestMs = value;
} catch {}
const duration = formatSurvival;
let geometry = null;
const motion = new Map();
let reasonUntil = 0,
  lastReason = "";
function text(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}
function attribute(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
let catalog,
  state,
  epoch = 0,
  phase = "",
  lastTime = null,
  seen = 0;
const nodes = new Map();
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
function announce(text) {
  $("live").textContent = text;
}
function button(text, handler, primary = true) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "primary" : "secondary";
  b.textContent = text;
  b.addEventListener("click", handler);
  return b;
}
function layoutCapacity() {
  return innerWidth <= 740 ? ($("cards").clientHeight >= 620 ? 4 : 3) : 6;
}
function currentLayout() {
  return `${innerWidth <= 740 ? 1 : 2}:${layoutCapacity()}`;
}
function prepare(seed = newSeed(), begin = false) {
  layoutBlocked = false;
  document.body.removeAttribute("data-layout-blocked");
  layoutKey = currentLayout();
  activeGestureCancel?.();
  epoch++;
  state = createGame(catalog, seed);
  state.maxCards = layoutCapacity();
  phase = "";
  lastTime = null;
  seen = 0;
  nodes.clear();
  motion.clear();
  geometry = null;
  lastReason = "";
  reasonUntil = 0;
  $("cards").replaceChildren();
  $("effects").replaceChildren();
  $("review").hidden = true;
  $("about").open = false;
  if (begin) start(state);
  render();
}
function makeCard(item, previewing) {
  const q = item.question;
  const n = document.createElement(previewing ? "div" : "button");
  if (!previewing) n.type = "button";
  n.className = `request${previewing ? " preview" : ""}`;
  n.dataset.uid = String(item.uid);
  n.dataset.scenarioId = q.scenarioId ?? "demo";
  n.dataset.slot = String(item.slot);
  n.dataset.context = JSON.stringify(q.context);
  const top = document.createElement("span");
  top.className = "service";
  const name = document.createElement("span");
  name.textContent = q.service;
  const slot = document.createElement("span");
  slot.className = "slot";
  slot.textContent = String(item.slot + 1);
  slot.setAttribute("aria-hidden", "true");
  top.append(name, slot);
  const operation = document.createElement("span");
  operation.className = "operation";
  operation.textContent = q.operation;
  const wire = document.createElement("span");
  wire.className = "wire-preview";
  wire.textContent = q.payload;
  wire.title = q.wire;
  const policy = document.createElement("span");
  policy.className = "context-row policy";
  policy.textContent = q.context.policy;
  if (previewing) n.append(top, operation, wire, policy);
  else {
    top.append(operation);
    n.append(top, wire, policy);
  }
  if (previewing) {
    const cue = document.createElement("span");
    cue.className = "example-note";
    cue.textContent = q.danger ? "DBを外へ公開 → タップ" : "非公開のまま → 通す ＋10 ↓";
    n.append(cue);
  }
  const thisEpoch = epoch;
  let pointerClickAllowed = false;
  n.addEventListener("click", (event) => {
    if (event.detail > 0) {
      if (!pointerClickAllowed) return;
      pointerClickAllowed = false;
    }
    pick(item.uid, thisEpoch);
  });
  if (!previewing)
    bindTap(
      n,
      () => {
        pointerClickAllowed = false;
      },
      () => {
        pointerClickAllowed = true;
      },
    );
  n.setAttribute(
    "aria-label",
    `${q.service}、${q.operation}。${q.payload}。${q.context.policy}。危険ならタップ、EnterまたはSpaceで検知`,
  );
  return n;
}
function bindTap(node, suppress, beginTap) {
  let pointer = null;
  const reset = () => {
    const id = pointer?.id;
    pointer = null;
    if (id !== undefined && node.hasPointerCapture?.(id)) node.releasePointerCapture(id);
    if (activeGestureCancel === cancel) activeGestureCancel = null;
  };
  const cancel = () => {
    suppress();
    reset();
  };
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || node.disabled || state.phase !== "playing") return;
    activeGestureCancel?.();
    beginTap();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    activeGestureCancel = cancel;
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener("pointermove", (event) => {
    if (
      pointer?.id === event.pointerId &&
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10
    )
      suppress();
  });
  node.addEventListener("pointerup", reset);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("lostpointercapture", () => {
    if (pointer) cancel();
  });
  node.setAttribute("aria-keyshortcuts", "Enter Space");
}
function updateNow() {
  const time = performance.now();
  if (lastTime !== null) tick(state, Math.max(0, time - lastTime));
  lastTime = time;
}
function pick(uid, thisEpoch) {
  if (thisEpoch !== epoch || !state || state.phase !== "playing") return;
  updateNow();
  if (!geometry) syncCards();
  const node = nodes.get(String(uid));
  if (!node || node.disabled) return;
  const accepted = collect(state, uid);
  if (accepted && state.feedback?.kind === "flag" && node && !reduced.matches) {
    const effect = node.cloneNode(true);
    effect.classList.add("tap-hit");
    effect.setAttribute("aria-hidden", "true");
    effect.tabIndex = -1;
    effect.disabled = true;
    effect.dataset.resolvedUid = String(uid);
    const transform = node.style.transform;
    $("cards").append(effect);
    effect
      .animate(
        [
          { transform, opacity: 0.8 },
          { transform: `${transform} translateX(18px) scale(0.97)`, opacity: 0 },
        ],
        { duration: 140, easing: "ease-out" },
      )
      .finished.then(
        () => effect.remove(),
        () => effect.remove(),
      );
  }
  render();
}
function feedbackEffect(entry) {
  const n = document.createElement("div");
  n.className = `impact${entry.correct ? "" : " wrong"}`;
  n.dataset.resolvedUid = String(entry.uid);
  n.dataset.operation = entry.question.operation;

  n.textContent =
    entry.kind === "pass" ? "通過 ＋10" : entry.kind === "flag" ? `検知 ＋${entry.points}` : "♥ −1";
  $("effects").replaceChildren(n);
  setTimeout(() => n.remove(), 220);
}
function positions(items, previewing) {
  const field = $("cards"),
    narrow = innerWidth <= 740;
  const columns = previewing ? (narrow ? 2 : 3) : narrow ? 1 : 2;
  if (!geometry) {
    // Read dimensions as one batch after additions, before any position writes.
    geometry = { width: field.clientWidth, height: field.clientHeight, heights: new Map() };
    for (const [uid, node] of nodes) geometry.heights.set(uid, node.offsetHeight);
  }
  const entries = items.map((item) => ({
    ...item,
    height: geometry.heights.get(String(item.uid)),
  }));
  const located = previewing
    ? entries.map((item) => ({
        ...item,
        y: 14 + [0.18, 0.47][item.slot] * Math.max(0, geometry.height - item.height - 24),
      }))
    : flowPositions(entries, motion, state.elapsed, geometry.height, columns, reduced.matches);
  for (const item of located) {
    const node = nodes.get(String(item.uid));
    const x = ((item.slot % columns) * geometry.width) / columns + (narrow ? 0 : 9);
    node.style.transform = `translate3d(${x}px,${item.y}px,0)`;
    const disabled =
      state.phase !== "playing" || state.elapsed - item.born < INPUT_GUARD_MS || item.y < 0;
    if (node.disabled !== disabled) node.disabled = disabled;
  }
}
function syncCards() {
  const previewing = state.phase === "ready",
    items = previewing ? [] : state.active;
  const valid = new Set(items.map((item) => String(item.uid)));
  for (const [uid, node] of nodes)
    if (!valid.has(uid)) {
      node.remove();
      nodes.delete(uid);
      motion.delete(uid);
      geometry = null;
    }
  for (const item of items) {
    const uid = String(item.uid);
    if (!nodes.has(uid)) {
      const node = makeCard(item, previewing);
      nodes.set(uid, node);
      $("cards").append(node);
      geometry = null;
    }
    const node = nodes.get(uid);
    const arriving = !previewing && state.elapsed - item.born < INPUT_GUARD_MS;
    attribute(node, "data-slot", String(item.slot));
    const slot = node.querySelector(".slot");
    if (slot.textContent !== String(item.slot + 1)) slot.textContent = String(item.slot + 1);
    if (node.classList.contains("arriving") !== arriving)
      node.classList.toggle("arriving", arriving);
    // No per-card countdown: the survival clock is the only running counter.
  }
  positions(items, previewing);
}
function modal(title, description) {
  const node = $("overlay");
  node.replaceChildren();
  node.hidden = false;
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-label", title ?? "判定の解説");
  const h = document.createElement("h2");
  h.textContent = title ?? "";
  const p = document.createElement("p");
  p.textContent = description;
  const actions = document.createElement("div");
  actions.className = "actions";
  if (title) node.append(h);
  node.append(p, actions);
  return actions;
}
function officialLink(question) {
  const a = document.createElement("a");
  a.href = question.source;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "この判定の公式説明 ↗";
  a.addEventListener("click", () => {
    if (["playing", "hitstop"].includes(state.phase)) {
      updateNow();
      pause(state);
      lastTime = null;
      render();
    }
  });
  return a;
}
function actualRequest(entry, actions) {
  $("overlay").insertBefore(officialLink(entry.question), actions);
  const text = document.createElement("p");
  text.className = "actual";
  text.textContent = `${entry.question.operation}\n${entry.question.context.policy}\n${entry.question.context.observed}`;
  $("overlay").insertBefore(text, $("overlay").querySelector("p"));
}
function explanation() {
  const e = state.feedback;
  const title = e.kind === "miss" ? "見逃した観測の解説" : "この判断の解説";
  const actions = modal(null, e.question.why);
  actualRequest(e, actions);
  actions.append(
    button(!state.lives ? "結果を見る" : "わかった・再開", () => {
      next(state);
      lastTime = null;
      render();
    }),
  );
  announce(`${title}。${e.question.why}`);
}
function review() {
  const root = $("review-list");
  root.replaceChildren();
  $("review").hidden = state.history.length === 0;
  for (const e of [...state.history].reverse()) {
    const article = document.createElement("article"),
      h = document.createElement("h3");
    h.textContent = `${{ flag: "正しい検知", pass: "正常通過", wrong: "誤検知", miss: "見逃し" }[e.kind]} · ${e.question.service} / ${e.question.operation} · ${e.points}点`;
    const context = document.createElement("p");
    context.textContent = `${e.question.context.policy} ／ ${e.question.context.observed}`;
    const wire = document.createElement("pre");
    wire.textContent = e.question.wire;
    const why = document.createElement("p");
    why.textContent = e.question.why;
    if (e.question.danger)
      why.textContent += ` ゲーム内危険度 ${e.question.severity} × 10 = ${e.question.points}点。`;
    const source = document.createElement("a");
    source.href = e.question.source;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "GuardDutyの公開説明 ↗";
    article.append(h, context, wire, why, source);
    root.append(article);
  }
}
function sharing() {
  const share = buildShare(state, location);
  const row = document.createElement("div");
  row.className = "share-actions";
  const link = document.createElement("a");
  link.className = "secondary";
  link.href = share.intent;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Xでシェア ↗";
  const copy = button(
    "結果をコピー",
    async () => {
      try {
        await navigator.clipboard.writeText(share.copy);
        copy.textContent = "コピーしました ✓";
      } catch {
        const text = document.createElement("textarea");
        text.readOnly = true;
        text.className = "copy-text";
        text.setAttribute("aria-label", "共有する練習記録");
        text.value = share.copy;
        row.append(text);
        text.focus();
        text.select();
      }
    },
    false,
  );
  row.append(link, copy);
  $("overlay").append(row);
  const note = document.createElement("p");
  note.className = "share-note";
  note.textContent = "投稿はXで確認。開けないときはコピーできます。";
  $("overlay").append(note);
}
function result() {
  if (state.elapsed > bestMs) {
    bestMs = state.elapsed;
    try {
      localStorage.setItem(BEST_KEY, String(bestMs));
    } catch {}
  }
  const actions = modal(
    "今回の生存記録",
    `正しい検知 ${state.correct} ／ 正常通過 ${state.passed} ／ ミス ${state.mistakes} ／ Lv.${difficulty(state.elapsed).level}`,
  );
  const score = document.createElement("div");
  score.className = "score-result";
  score.textContent = duration(state.elapsed);
  {
    const best = document.createElement("p");
    best.className = "best-result";
    best.textContent = `自己ベスト ${duration(bestMs)} · ${state.score} pt`;
    $("overlay").append(best);
  }
  $("overlay").prepend(score);
  const seed = state.seed;
  actions.append(
    button("もう一回", () => prepare(newSeed(), true)),
    button("同じ流れで復習", () => prepare(seed, true), false),
  );
  sharing();
  review();
  announce(
    `結果。生存時間${duration(state.elapsed)}。${state.score}点。正しい検知${state.correct}回。`,
  );
}
function phaseContent() {
  $("overlay").hidden = true;
  $("overlay").replaceChildren();
  $("controls").replaceChildren();
  if (state.phase === "ready")
    $("controls").append(
      button("はじめる", () => {
        start(state);
        lastTime = null;
        render();
      }),
    );
  if (state.phase === "playing") {
    const hint = document.createElement("span");
    hint.className = "keyboard-hint";
    hint.textContent = document.body.classList.contains("keyboard")
      ? "1〜6で検知 · Pで一時停止"
      : "分かった上のカードも、その場でタップ";
    $("controls").append(hint);
  }
  if (state.phase === "paused" && layoutBlocked) {
    const seed = state.seed;
    const actions = modal(
      "画面サイズが変わりました",
      "この広さでは全カードを読めないため停止しました。元の向き・広さへ戻すと、同じ続きから再開できます。",
    );
    actions.append(
      button("最初からやり直す", () => prepare(seed, true)),
      button(
        "ここまでの結果",
        () => {
          layoutBlocked = false;
          document.body.removeAttribute("data-layout-blocked");
          finish(state);
          render();
        },
        false,
      ),
    );
  }
  if (state.phase === "paused" && !layoutBlocked) {
    const actions = modal("ひと休み。", "カードも時間も止まっています。");
    actions.append(
      button("再開", togglePause),
      button(
        "結果を見る",
        () => {
          finish(state);
          render();
        },
        false,
      ),
    );
  }
  if (state.phase === "feedback") explanation();
  if (state.phase === "finished") result();
  if (["feedback", "paused", "finished"].includes(state.phase))
    $("overlay").querySelector("button")?.focus({ preventScroll: true });
}
function renderFeedback() {
  for (let i = seen; i < state.history.length; i++) {
    const entry = state.history[i];
    feedbackEffect(entry);
    if (!entry.correct) {
      lastReason = "";
      reasonUntil = 0;
    }
    if (entry.kind === "flag") {
      lastReason = entry.question.briefReason;
      reasonUntil = state.elapsed + 2200;
      announce(lastReason);
    }
  }
  text("hit-reason", lastReason && state.elapsed < reasonUntil ? lastReason : "");
  seen = state.history.length;
}
function render() {
  attribute(document.body, "data-phase", state.phase);
  const wasActive = document.body.classList.contains("active-game");
  const active = state.phase !== "ready";
  if (wasActive !== active) document.body.classList.toggle("active-game", active);
  const pauseHost = active ? document.querySelector(".hud") : document.querySelector(".top");
  if ($("pause").parentElement !== pauseHost) pauseHost.append($("pause"));
  text("start-best", bestMs > 0 ? `自己ベスト ${duration(bestMs)}` : "");
  text("score", String(state.score));
  text("combo", state.combo >= 2 ? `${state.combo} COMBO` : "");
  if (state.phase !== "playing") activeGestureCancel?.();
  text("survival", duration(state.elapsed));
  text("personal-best", `BEST ${duration(Math.max(bestMs, state.elapsed))}`);
  text("level", String(difficulty(state.elapsed).level));
  text("lives", `${"♥ ".repeat(state.lives)}${"♡ ".repeat(3 - state.lives)}`);
  attribute($("lives"), "aria-label", `残りライフ${state.lives}`);
  const pauseDisabled = !["playing", "hitstop", "feedback", "paused"].includes(state.phase);
  if ($("pause").disabled !== pauseDisabled) $("pause").disabled = pauseDisabled;
  attribute($("pause"), "aria-label", state.phase === "paused" ? "再開" : "一時停止");
  renderFeedback();
  syncCards();
  if (active && !wasActive && !layoutBlocked) state.maxCards = layoutCapacity();
  if (active && !wasActive) layoutKey = currentLayout();
  if (phase !== state.phase) {
    phase = state.phase;
    if (phase !== "hitstop") phaseContent();
  }
}
function togglePause() {
  if (!state || layoutBlocked) return;
  updateNow();
  if (state.phase === "paused") resume(state);
  else pause(state);
  lastTime = null;
  render();
}
$("pause").addEventListener("click", togglePause);
function pauseForRules() {
  if (state && ["playing", "hitstop"].includes(state.phase)) {
    updateNow();
    pause(state);
    lastTime = null;
    render();
  }
}
$("about")
  .querySelector("summary")
  .addEventListener("click", () => {
    if (!$("about").open) pauseForRules();
  });
$("about").addEventListener("toggle", () => {
  if ($("about").open) pauseForRules();
});
document.addEventListener("keydown", (event) => {
  if (!state || event.altKey || event.ctrlKey || event.metaKey) return;

  if (
    ["Tab", "1", "2", "3", "4", "5", "6"].includes(event.key) &&
    !document.body.classList.contains("keyboard")
  ) {
    document.body.classList.add("keyboard");
    geometry = null;
  }
  if (
    event.repeat &&
    ["1", "2", "3", "4", "5", "6", "Enter", " ", "p", "P", "Escape"].includes(event.key)
  ) {
    event.preventDefault();
    return;
  }
  if (["1", "2", "3", "4", "5", "6"].includes(event.key) && state.phase === "playing") {
    event.preventDefault();
    const item = state.active.find((v) => v.slot === Number(event.key) - 1);
    if (item) pick(item.uid, epoch);
  }
  if (event.key.toLowerCase() === "p" || event.key === "Escape") {
    event.preventDefault();
    togglePause();
  }
});
function backgroundPause() {
  if (!state || !["playing", "hitstop"].includes(state.phase)) return;
  pause(state);
  lastTime = null;
  render();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) backgroundPause();
});
window.addEventListener("blur", backgroundPause);
function fitsLayout(columns, remap) {
  const heights = Array.from({ length: columns }, () => []);
  state.active.forEach((item, i) => {
    heights[(remap ? i : item.slot) % columns].push(nodes.get(String(item.uid))?.offsetHeight ?? 0);
  });
  return heights.every(
    (list) =>
      list.reduce((n, h) => n + h, 0) + Math.max(0, list.length - 1) * 12 <=
      $("cards").clientHeight - 16,
  );
}
window.addEventListener("resize", () => {
  geometry = null;
  if (!state) return;
  const key = currentLayout();
  if (key === layoutKey && !layoutBlocked) return;
  if (state.phase === "ready") {
    prepare(state.seed);
    return;
  }
  if (state.phase === "finished") return;
  const columns = innerWidth <= 740 ? 1 : 2;
  const changed = Number(layoutKey.split(":")[0]) !== columns;
  if (!fitsLayout(columns, changed || layoutBlocked)) {
    updateNow();
    pause(state);
    layoutBlocked = true;
    document.body.dataset.layoutBlocked = "true";
    lastTime = null;
    layoutKey = key;
    phase = "";
    render();
    return;
  }
  state.maxCards = layoutCapacity();
  if (changed || layoutBlocked) {
    updateNow();
    pause(state);
    state.active.forEach((item, i) => {
      item.slot = i;
    });
    layoutBlocked = false;
    document.body.removeAttribute("data-layout-blocked");
    lastTime = null;
    phase = "";
  }
  layoutKey = key;
  render();
});
reduced.addEventListener("change", () => {
  geometry = null;
  motion.clear();
  if (state) render();
});
window.addEventListener("pagehide", backgroundPause);
function frame(time) {
  if (lastTime !== null) tick(state, Math.max(0, time - lastTime));
  lastTime = time;
  if (["playing", "hitstop"].includes(state.phase) || phase !== state.phase) render();
  requestAnimationFrame(frame);
}
async function boot() {
  try {
    catalog = await loadCatalog();
    document.fonts.ready.then(() => {
      geometry = null;
    });
    prepare();
    requestAnimationFrame(frame);
  } catch (error) {
    $("controls").replaceChildren(button("読み込みを再試行", () => location.reload()));
    $("controls").querySelector("button").textContent = "問題を読み込めませんでした・再試行";
    announce(String(error));
  }
}
boot();
