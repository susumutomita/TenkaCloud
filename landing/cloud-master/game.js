import { loadCatalog } from "./api-catalog.js";
import {
  allow,
  collect,
  createGame,
  finish,
  INPUT_GUARD_MS,
  next,
  passStudy,
  pause,
  resume,
  start,
  tick,
} from "./engine.js";
import { swipeDirection } from "./gestures.js";
import { difficulty } from "./recognition.js";
import { buildShare } from "./share.js";

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
const duration = (ms) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
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
function prepare(seed = newSeed(), study = false, begin = false) {
  layoutBlocked = false;
  document.body.removeAttribute("data-layout-blocked");
  layoutKey = currentLayout();
  activeGestureCancel?.();
  epoch++;
  state = createGame(catalog, seed, study);
  state.maxCards = layoutCapacity();
  phase = "";
  lastTime = null;
  seen = 0;
  nodes.clear();
  $("cards").replaceChildren();
  $("effects").replaceChildren();
  $("review").hidden = true;
  $("about").open = false;
  if (begin) start(state);
  render();
}
function preview() {
  return [
    {
      uid: "demo-pass",
      slot: 0,
      born: 0,
      deadline: 12000,
      question: {
        service: "RDS",
        operation: "ModifyDBInstance",
        payload: "PubliclyAccessible: false",
        wire: '{"PubliclyAccessible":false}',
        context: {
          kind: "demo",
          allowed: false,
          actual: false,
          policy: "顧客DB / 社内VPC内のみ",
          observed: "PubliclyAccessible: false",
        },
        danger: false,
      },
    },
    {
      uid: "demo-flag",
      slot: 1,
      born: 0,
      deadline: 12000,
      question: {
        service: "RDS",
        operation: "ModifyDBInstance",
        payload: "PubliclyAccessible: true",
        wire: '{"PubliclyAccessible":true}',
        context: {
          kind: "demo",
          allowed: false,
          actual: true,
          policy: "顧客DB / 社内VPC内のみ",
          observed: "PubliclyAccessible: true",
        },
        danger: true,
      },
    },
  ];
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
  const timer = document.createElement("span");
  timer.className = "deadline-time";
  timer.setAttribute("aria-hidden", "true");
  top.append(name, slot, timer);
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
  const actual = document.createElement("span");
  actual.className = "context-row observed";
  actual.textContent = q.context.observed;
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
    bindSwipe(
      n,
      item.uid,
      thisEpoch,
      () => {
        pointerClickAllowed = false;
      },
      () => {
        pointerClickAllowed = true;
      },
    );
  n.setAttribute(
    "aria-label",
    `${q.service}、${q.operation}。${q.payload}。${q.context.policy}。左矢印で検知、右矢印で通す。タップでも検知`,
  );
  return n;
}
function bindSwipe(node, uid, thisEpoch, suppress, beginGesture) {
  let gesture = null;
  const reset = () => {
    if (gesture && node.hasPointerCapture?.(gesture.id)) node.releasePointerCapture(gesture.id);
    gesture = null;
    node.style.transform = "";
    node.removeAttribute("data-drag");
    if (activeGestureCancel === cancel) activeGestureCancel = null;
  };
  const cancel = () => {
    if (gesture) suppress();
    reset();
  };
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || node.disabled || state.phase !== "playing") return;
    activeGestureCancel?.();
    beginGesture();
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      dx: 0,
      dy: 0,
    };
    activeGestureCancel = cancel;
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    gesture.dx = event.clientX - gesture.x;
    gesture.dy = event.clientY - gesture.y;
    if (Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25) {
      node.dataset.drag = gesture.dx < 0 ? "stop" : "allow";
      node.style.transform = `translateX(${Math.max(-90, Math.min(90, gesture.dx))}px)`;
    }
  });
  node.addEventListener("pointerup", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const g = gesture;
    const direction = swipeDirection({
      dx: event.clientX - g.x,
      dy: event.clientY - g.y,
      elapsed: performance.now() - g.time,
    });
    const moved = Math.hypot(event.clientX - g.x, event.clientY - g.y) > 10;
    const bounds = node.getBoundingClientRect();
    reset();
    if (moved) suppress();
    if (direction && state.phase === "playing") {
      event.preventDefault();
      suppress();
      decide(uid, thisEpoch, direction, bounds);
    }
  });
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("lostpointercapture", () => {
    if (gesture) cancel();
  });
  node.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Enter");
}
function directionEffect(bounds, direction, uid) {
  if (reduced.matches) return;
  const n = document.createElement("div");
  n.className = `decision-trail ${direction}`;
  n.dataset.resolvedUid = String(uid);
  Object.assign(n.style, {
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
  document.body.append(n);
  setTimeout(() => n.remove(), 180);
}
function decide(uid, thisEpoch, direction, bounds) {
  if (thisEpoch !== epoch || !state || state.phase !== "playing") return;
  updateNow();
  const accepted = direction === "allow" ? allow(state, uid) : collect(state, uid);
  if (accepted && bounds) directionEffect(bounds, direction, uid);
  render();
}
function updateNow() {
  const time = performance.now();
  if (lastTime !== null) tick(state, Math.max(0, time - lastTime));
  lastTime = time;
}
function pick(uid, thisEpoch) {
  if (thisEpoch !== epoch || !state || state.phase !== "playing") return;
  updateNow();
  collect(state, uid);
  render();
}
function feedbackEffect(entry) {
  const n = document.createElement("div");
  n.className = `impact${entry.correct ? "" : " wrong"}`;
  n.dataset.resolvedUid = String(entry.uid);
  n.dataset.operation = entry.question.operation;

  n.textContent = ["pass", "allow"].includes(entry.kind)
    ? "通過 ＋10"
    : entry.kind === "flag"
      ? `検知 ＋${entry.points}`
      : "♥ −1";
  const detail = document.createElement("small");
  detail.textContent = entry.question.operation;
  n.append(detail);
  if (
    entry.correct &&
    entry.kind !== "pass" &&
    entry.comboAfter >= 3 &&
    (entry.comboAfter === 3 || entry.comboAfter === 5 || entry.comboAfter % 10 === 0)
  ) {
    const combo = document.createElement("b");
    combo.textContent = `${entry.comboAfter} COMBO`;
    n.append(combo);
    n.classList.add("combo-milestone");
  }
  $("effects").replaceChildren(n);
  setTimeout(() => n.remove(), 220);
}
function stackLanePositions(entries, columns, fieldHeight) {
  for (let lane = 0; lane < columns; lane++) {
    const pair = entries
      .filter((v) => v.lane === lane)
      .sort((a, b) => a.item.born - b.item.born || a.item.slot - b.item.slot);
    const stack = [...pair].reverse();
    let bottom = 8;
    for (const entry of stack) {
      entry.y = Math.max(entry.y, bottom);
      bottom = entry.y + entry.node.offsetHeight + 12;
    }
    const overflow = bottom - 12 - fieldHeight + 2;
    if (overflow > 0) for (const entry of stack) entry.y -= overflow;
    if (stack[0]?.y < 8) {
      let y = 8;
      for (const entry of stack) {
        entry.y = y;
        y += entry.node.offsetHeight + 12;
      }
    }
  }
}
function positions(items, previewing) {
  const field = $("cards"),
    narrow = innerWidth <= 740,
    columns = previewing ? (narrow ? 2 : 3) : narrow ? 1 : 2;
  const entries = items.map((item) => {
    const node = nodes.get(String(item.uid));
    const fraction = previewing
      ? [0.18, 0.47][item.slot]
      : state.study
        ? 0.22
        : Math.max(0, Math.min(1, (state.elapsed - item.born) / (item.deadline - item.born)));
    const stationary = reduced.matches && !previewing && !state.study;
    const movement = stationary
      ? Math.max(0.04, 0.55 - Math.floor(item.slot / columns) * 0.51)
      : fraction;
    const lane = item.slot % columns;
    node.style.left = `${lane * (field.clientWidth / columns) + (narrow ? 0 : 9)}px`;
    const y =
      previewing || state.study
        ? 14 + movement * Math.max(0, field.clientHeight - node.offsetHeight - 24)
        : Math.max(8, movement * Math.max(0, field.clientHeight - node.offsetHeight));
    return { item, node, lane, y };
  });
  stackLanePositions(entries, columns, field.clientHeight);
  for (const entry of entries) entry.node.style.top = `${Math.max(8, entry.y)}px`;
}
function syncCards() {
  const previewing = state.phase === "ready",
    items = previewing ? preview() : state.active;
  const valid = new Set(items.map((item) => String(item.uid)));
  for (const [uid, node] of nodes)
    if (!valid.has(uid)) {
      node.remove();
      nodes.delete(uid);
    }
  for (const item of items) {
    const uid = String(item.uid);
    if (!nodes.has(uid)) {
      const node = makeCard(item, previewing);
      nodes.set(uid, node);
      $("cards").append(node);
    }
    const node = nodes.get(uid);
    const arriving = !previewing && !state.study && state.elapsed - item.born < INPUT_GUARD_MS;
    node.dataset.slot = String(item.slot);
    node.querySelector(".slot").textContent = String(item.slot + 1);
    node.classList.toggle("arriving", arriving);
    node.querySelector(".deadline-time").textContent =
      previewing || state.study
        ? ""
        : `残り${Math.max(0, Math.ceil((item.deadline - state.elapsed) / 1000))}秒`;
    node.disabled = state.phase !== "playing" || arriving;
  }
  positions(items, previewing);
}
function modal(title, description) {
  const node = $("overlay");
  node.replaceChildren();
  node.hidden = false;
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = description;
  const actions = document.createElement("div");
  actions.className = "actions";
  node.append(h, p, actions);
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
  if (entry.question.danger) {
    const score = document.createElement("p");
    score.textContent = `ゲーム内危険度 ${entry.question.severity} × 10 = ${entry.question.points}点${entry.kind === "miss" ? "（今回は見逃し）" : ""}`;
    $("overlay").insertBefore(score, actions);
  }
}
function explanation() {
  const e = state.feedback;
  const title =
    e.kind === "miss"
      ? `取り逃し ${e.groupCount ?? 1}件 · ♥−${e.groupCount ?? 1}`
      : e.kind === "allow-danger"
        ? "危険な操作を通しました · ♥−1"
        : e.kind === "wrong"
          ? "正常な操作を検知しました"
          : e.kind === "flag"
            ? "検知できました"
            : "正しく通しました";
  const actions = modal(title, e.question.why);
  actualRequest(e, actions);
  const lives = document.createElement("p");
  lives.textContent = `残りライフ ${state.lives} / 3。カードと時間は停止中。`;
  $("overlay").insertBefore(lives, actions);
  actions.append(
    button(!state.lives ? "結果を見る" : state.study ? "次のリクエスト" : "わかった・再開", () => {
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
    h.textContent = `${{ flag: "正しい検知", pass: "正常通過", allow: "手動で正常通過", "allow-danger": "危険を通過", wrong: "誤検知", miss: "見逃し" }[e.kind]} · ${e.question.service} / ${e.question.operation} · ${e.points}点`;
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
  if (!state.study && state.elapsed > bestMs) {
    bestMs = state.elapsed;
    try {
      localStorage.setItem(BEST_KEY, String(bestMs));
    } catch {}
  }
  const actions = modal(
    state.study ? "今回の練習記録" : "今回の生存記録",
    `正しい検知 ${state.correct} ／ 正常通過 ${state.passed} ／ ミス ${state.mistakes} ／ Lv.${difficulty(state.elapsed).level}`,
  );
  const score = document.createElement("div");
  score.className = "score-result";
  score.textContent = state.study ? `${state.score} pt` : duration(state.elapsed);
  if (!state.study) {
    const best = document.createElement("p");
    best.className = "best-result";
    best.textContent = `自己ベスト ${duration(bestMs)} · ${state.score} pt`;
    $("overlay").append(best);
  }
  $("overlay").prepend(score);
  const seed = state.seed,
    study = state.study;
  actions.append(
    button("もう一回", () => prepare(newSeed(), study, true)),
    button("同じ流れで復習", () => prepare(seed, study, true), false),
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
  if (state.phase === "playing" && state.study)
    $("controls").append(
      button(
        "そのまま通す",
        () => {
          passStudy(state);
          render();
        },
        false,
      ),
      button(
        "ここまでの結果",
        () => {
          finish(state);
          render();
        },
        false,
      ),
    );
  if (state.phase === "playing" && !state.study) {
    const hint = document.createElement("span");
    hint.className = "keyboard-hint";
    hint.textContent = document.body.classList.contains("keyboard")
      ? "1〜6で検知 · Pで一時停止"
      : "分かった上のカードも、その場でタップ";
    $("controls").append(hint);
  }
  if (state.phase === "paused" && layoutBlocked) {
    const seed = state.seed,
      study = state.study;
    const actions = modal(
      "画面サイズが変わりました",
      "この広さでは全カードを読めないため停止しました。元の向き・広さへ戻すと、同じ続きから再開できます。",
    );
    actions.append(
      button("最初からやり直す", () => prepare(seed, study, true)),
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
function render() {
  document.body.dataset.phase = state.phase;
  document.body.dataset.study = String(state.study);
  const wasActive = document.body.classList.contains("active-game");
  const active = state.phase !== "ready";
  document.body.classList.toggle("active-game", active);
  const pauseHost = active ? document.querySelector(".hud") : document.querySelector(".top");
  if ($("pause").parentElement !== pauseHost) pauseHost.append($("pause"));
  $("score").textContent = String(state.score);
  $("combo").textContent = state.combo >= 2 ? `${state.combo} COMBO` : "";
  if (state.phase !== "playing") activeGestureCancel?.();
  $("survival").textContent = duration(state.elapsed);
  $("personal-best").textContent =
    `BEST ${duration(Math.max(bestMs, state.study ? 0 : state.elapsed))}`;
  $("level").innerHTML = `${difficulty(state.elapsed).level}`;
  $("lives").textContent = `${"♥ ".repeat(state.lives)}${"♡ ".repeat(3 - state.lives)}`;
  $("lives").setAttribute("aria-label", `残りライフ${state.lives}`);
  $("pause").disabled = !["playing", "hitstop", "feedback", "paused"].includes(state.phase);
  $("pause").setAttribute("aria-label", state.phase === "paused" ? "再開" : "一時停止");
  $("floor").textContent = state.study
    ? "時間なし · 拾うか、そのまま通すか"
    : "危険な操作を見逃すと ♥−1・止まって解説";
  for (const entry of state.history.slice(seen)) feedbackEffect(entry);
  seen = state.history.length;
  syncCards();
  if (active && !layoutBlocked) state.maxCards = layoutCapacity();
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
$("study").addEventListener("click", () => prepare(newSeed(), true, true));
function handleDirectionalKey(event) {
  const target = event.target.closest?.("button.request");
  if (!["ArrowLeft", "ArrowRight"].includes(event.key) || !target || state.phase !== "playing")
    return false;
  event.preventDefault();
  if (!event.repeat)
    decide(Number(target.dataset.uid), epoch, event.key === "ArrowRight" ? "allow" : "stop");
  return true;
}
document.addEventListener("keydown", (event) => {
  if (!state || event.altKey || event.ctrlKey || event.metaKey) return;
  if (handleDirectionalKey(event)) return;
  if (["Tab", "1", "2", "3", "4", "5", "6"].includes(event.key))
    document.body.classList.add("keyboard");
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
  if (!state) return;
  const key = currentLayout();
  if (key === layoutKey && !layoutBlocked) return;
  if (state.phase === "ready") {
    prepare(state.seed, state.study);
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
window.addEventListener("pagehide", backgroundPause);
function frame(time) {
  if (lastTime !== null) tick(state, Math.max(0, time - lastTime));
  lastTime = time;
  render();
  requestAnimationFrame(frame);
}
async function boot() {
  try {
    catalog = await loadCatalog();
    prepare();
    requestAnimationFrame(frame);
  } catch (error) {
    $("controls").replaceChildren(button("読み込みを再試行", () => location.reload()));
    $("floor").textContent = "問題データを読み込めませんでした。対応ブラウザで再試行してください。";
    announce(String(error));
  }
}
boot();
