import { loadCatalog } from "./api-catalog.js?v=50732f9215";
import { CORRECT_PER_LEVEL, lessonForLevel } from "./curriculum.js?v=50732f9215";
import {
  collect,
  createGame,
  finish,
  INPUT_GUARD_MS,
  next,
  pause,
  resume,
  showLesson,
  start,
  tickFrame as tick,
} from "./engine.js?v=50732f9215";
import { explanationCard } from "./explanation.js?v=50732f9215";
import { decisionFact, reasonDuration } from "./feedback.js?v=50732f9215";
import { formatCount, getLocale, setLocale, tr } from "./i18n.js?v=50732f9215";
import { CARD_GAP, fieldCapacity } from "./layout.js?v=50732f9215";
import { flowPositions } from "./motion.js?v=50732f9215";
import { lessonNotice } from "./notices.js?v=50732f9215";
import { clearSlices, pulseCombo, sliceCard } from "./paper-cut.js?v=50732f9215";
import { createPaperSound } from "./paper-sound.js?v=50732f9215";
import { loadQuestionLocale, questionView } from "./question-locales.js?v=50732f9215";
import { buildShare } from "./share.js?v=50732f9215";
import { formatSurvival } from "./time.js?v=50732f9215";

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
const duration = (milliseconds) => formatSurvival(milliseconds, getLocale());
const languageButton = $("language-switch");
const soundButton = $("sound-toggle");
const paperSound = createPaperSound();
function renderSound() {
  soundButton.textContent = paperSound.enabled ? tr("効果音 オン") : tr("効果音 オフ");
  soundButton.setAttribute("aria-pressed", String(paperSound.enabled));
}
soundButton.addEventListener("click", () => {
  paperSound.setEnabled(!paperSound.enabled);
  renderSound();
});
for (const name of ["pointerdown", "keydown"])
  document.addEventListener(
    name,
    (event) => {
      if (event.isTrusted) paperSound.unlock();
    },
    { capture: true },
  );
let cardLanguage = getLocale();
let geometry = null;
const motion = new Map();
let reasonUntil = 0,
  lastReason = "",
  shownLevel = 1,
  lessonPaintToken = null;
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
  b.addEventListener("click", (event) => {
    if (!b.isConnected || b.disabled) return;
    handler(event);
  });
  return b;
}
function layoutCapacity() {
  return fieldCapacity($("cards").clientHeight, innerWidth <= 740 ? 1 : 2, innerWidth);
}
function currentLayout() {
  return `${innerWidth <= 740 ? 1 : 2}:${layoutCapacity()}`;
}
function prepare(seed = newSeed(), begin = false) {
  paperSound.stop();
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
  shownLevel = 1;
  lessonPaintToken = null;
  $("cards").replaceChildren();
  $("effects").replaceChildren();
  clearSlices($("slice-effects"));
  $("review").hidden = true;
  $("about").open = false;
  if (begin) beginRound();
  else render();
}
function beginRound() {
  document.body.classList.add("active-game");
  state.maxCards = layoutCapacity();
  layoutKey = currentLayout();
  start(state);
  lastTime = null;
  render();
}
function makeCard(item, previewing) {
  const q = item.question,
    view = questionView(q, getLocale());
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
  name.textContent = view.service;
  const slot = document.createElement("span");
  slot.className = "slot";
  slot.textContent = String(item.slot + 1);
  slot.setAttribute("aria-hidden", "true");
  top.append(name, slot);
  const operation = document.createElement("span");
  operation.className = "operation";
  operation.textContent = view.operation;
  const wire = document.createElement("span");
  wire.className = "wire-preview";
  wire.textContent = view.payload;
  wire.title = view.wire;
  const policy = document.createElement("span");
  policy.className = "context-row policy";
  policy.textContent = view.policy;
  if (previewing) n.append(top, operation, wire, policy);
  else {
    top.append(operation);
    n.append(top, wire, policy);
  }
  if (previewing) {
    const cue = document.createElement("span");
    cue.className = "example-note";
    cue.textContent = q.danger ? tr("DBを外へ公開 → タップ") : tr("非公開のまま → 通す ＋10 ↓");
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
    tr("{service}、{operation}。{payload}。{policy}。危険ならタップ、EnterまたはSpaceで検知", {
      service: view.service,
      operation: view.operation,
      payload: view.payload,
      policy: view.policy,
    }),
  );
  return n;
}
function refreshCard(node, q) {
  const view = questionView(q, getLocale());
  node.querySelector(".service>span:first-child").textContent = view.service;
  node.querySelector(".operation").textContent = view.operation;
  node.querySelector(".wire-preview").textContent = view.payload;
  node.querySelector(".wire-preview").title = view.wire;
  node.querySelector(".policy").textContent = view.policy;
  node.setAttribute(
    "aria-label",
    tr("{service}、{operation}。{payload}。{policy}。危険ならタップ、EnterまたはSpaceで検知", {
      service: view.service,
      operation: view.operation,
      payload: view.payload,
      policy: view.policy,
    }),
  );
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
  const success = accepted && state.feedback?.kind === "flag" && state.feedback.correct;
  if (success) {
    paperSound.play(uid);
    sliceCard(node, $("slice-effects"), { uid, combo: state.combo, reduced: reduced.matches });
  }

  render();
  if (success) pulseCombo($("combo"), state.combo, reduced.matches);
}
function feedbackEffect(entry) {
  const n = document.createElement("div");
  n.className = `impact${entry.correct ? "" : " wrong"}${entry.kind === "pass" ? " pass" : ""}`;
  n.dataset.resolvedUid = String(entry.uid);
  n.dataset.operation = entry.question.operation;

  n.textContent =
    entry.kind === "pass"
      ? tr("通過 ＋10")
      : entry.kind === "flag"
        ? tr("検知 ＋{points}", { points: formatCount(entry.points) })
        : "♥ −1";
  $("effects").replaceChildren(n);
  setTimeout(() => n.remove(), 900);
}
function positions(items, previewing) {
  const field = $("cards"),
    narrow = innerWidth <= 740;
  const columns = previewing ? (narrow ? 2 : 3) : narrow ? 1 : 2;
  if (!geometry) {
    // Read dimensions as one batch after additions, before any position writes.
    geometry = {
      width: field.clientWidth,
      height: field.clientHeight,
      left: field.offsetLeft,
      heights: new Map(),
    };
    for (const [uid, node] of nodes) geometry.heights.set(uid, node.offsetHeight);
  }
  const entries = items.map((item) => ({
    ...item,
    height: geometry.heights.get(String(item.uid)),
  }));
  // Essential linear fall still communicates the pass line in reduced motion;
  // decorative hit effects respect the reduced-motion preference separately.
  const located = previewing
    ? entries.map((item) => ({
        ...item,
        y: 14 + [0.18, 0.47][item.slot] * Math.max(0, geometry.height - item.height - 24),
      }))
    : flowPositions(entries, motion, state.elapsed, geometry.height, columns, false);
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
  const changedLanguage = cardLanguage !== getLocale();
  if (changedLanguage) {
    geometry = null;
    cardLanguage = getLocale();
  }
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
    if (changedLanguage) refreshCard(node, item.question);
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
  node.setAttribute("aria-label", title ?? tr("判定の解説"));
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
  a.textContent = tr("参考となるAWS公式資料 ↗");
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
function explanation() {
  const e = state.feedback,
    view = explanationCard(e.question, getLocale());
  const actions = modal(view.headline, view.reason),
    root = $("overlay");
  root.classList.add("miss-card");
  root.dataset.judgment = e.question.danger ? "danger" : "normal";
  const mark = document.createElement("span");
  mark.className = "miss-mark";
  mark.textContent = e.question.danger ? "!" : "✓";
  mark.setAttribute("aria-hidden", "true");
  root.prepend(mark);
  const policy = document.createElement("p");
  policy.className = "miss-context";
  policy.textContent = `${view.operation} · ${view.meaning}`;
  const comparison = document.createElement("dl");
  comparison.className = "miss-comparison";
  for (const [label, content] of [
    [tr("{field}（今回）", { field: view.field }), view.actual],
    [view.expectedLabel, view.expected],
  ]) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd"),
      code = document.createElement("code");
    dt.textContent = label;
    code.textContent = content;
    if (content.length > 24) code.classList.add("long-value");
    dd.append(code);
    comparison.append(dt, dd);
  }
  root.insertBefore(policy, root.querySelector("p"));
  root.insertBefore(comparison, root.querySelector("p:not(.miss-context)"));
  root.insertBefore(officialLink(e.question), actions);
  const details = document.createElement("section"),
    why = document.createElement("p"),
    wire = document.createElement("pre");
  details.className = "miss-details";
  why.textContent = view.fullReason;
  wire.textContent = view.wire;
  details.append(why, wire);
  root.insertBefore(details, actions);
  actions.append(
    button(!state.lives ? tr("結果を見る") : tr("続ける"), () => {
      next(state);
      lastTime = null;
      render();
    }),
  );
  const content = document.createElement("div");
  content.className = "miss-body";
  for (const child of [...root.children]) if (child !== actions) content.append(child);
  root.insertBefore(content, actions);
  announce(tr("{summary}。{detail}", { summary: view.headline, detail: view.reason }));
}
function review() {
  const root = $("review-list");
  root.replaceChildren();
  $("review").hidden = state.history.length === 0;
  for (const e of [...state.history].reverse()) {
    const view = questionView(e.question, getLocale()),
      explanationView = explanationCard(e.question, getLocale());
    const article = document.createElement("article"),
      h = document.createElement("h3");
    h.textContent = tr("{kind} · {service} / {operation} · {points}点", {
      kind: {
        flag: tr("正しい検知"),
        pass: tr("正常通過"),
        wrong: tr("誤検知"),
        miss: tr("見逃し"),
      }[e.kind],
      service: view.service,
      operation: view.operation,
      points: formatCount(e.points),
    });
    const context = document.createElement("p");
    context.textContent = tr("{policy} ／ {observed}", {
      policy: view.policy,
      observed: view.observed,
    });
    const wire = document.createElement("pre");
    wire.textContent = view.wire;
    const why = document.createElement("p");
    why.textContent = explanationView.fullReason;
    if (e.question.danger)
      why.textContent += ` ${tr("ゲーム内危険度 {severity} × 10 = {points}点。", { severity: e.question.severity, points: e.question.points })}`;
    const source = document.createElement("a");
    source.href = e.question.source;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = tr("参考となるAWS公式資料 ↗");
    article.append(h, context, wire, why, source);
    root.append(article);
  }
}
function sharing() {
  const share = buildShare(state, location, getLocale());
  const row = document.createElement("div");
  row.className = "share-actions";
  const link = document.createElement("a");
  link.className = "secondary";
  link.href = share.intent;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = tr("Xでシェア ↗");
  const copy = button(
    tr("結果をコピー"),
    async () => {
      try {
        await navigator.clipboard.writeText(share.copy);
        copy.textContent = tr("コピーしました ✓");
      } catch {
        const text = document.createElement("textarea");
        text.readOnly = true;
        text.className = "copy-text";
        text.setAttribute("aria-label", tr("共有する練習記録"));
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
  note.textContent = tr("投稿はXで確認。開けないときはコピーできます。");
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
    tr("今回の生存記録"),
    tr("正しい検知 {correct} ／ 正常通過 {passed} ／ ミス {mistakes} ／ Lv{level}", {
      correct: formatCount(state.correct),
      passed: formatCount(state.passed),
      mistakes: formatCount(state.mistakes),
      level: formatCount(state.level),
    }),
  );
  const score = document.createElement("div");
  score.className = "score-result";
  score.textContent = duration(state.elapsed);
  {
    const best = document.createElement("p");
    best.className = "best-result";
    best.textContent = tr("自己ベスト {time} · {score} pt", {
      time: duration(bestMs),
      score: formatCount(state.score),
    });
    $("overlay").append(best);
  }
  $("overlay").prepend(score);
  const seed = state.seed;
  actions.append(
    button(tr("もう一回"), () => prepare(newSeed(), true)),
    button(tr("同じ流れで復習"), () => prepare(seed, true), false),
  );
  sharing();
  review();
  announce(
    tr("結果。生存時間{time}。{score}点。正しい検知{correct}回。", {
      time: duration(state.elapsed),
      score: formatCount(state.score),
      correct: formatCount(state.correct),
    }),
  );
}
function phaseContent() {
  $("language-home").append(languageButton, soundButton);
  $("overlay").hidden = true;
  $("overlay").classList.remove("miss-card");
  $("overlay").replaceChildren();
  $("controls").replaceChildren();
  if (state.phase === "ready")
    $("controls").append(
      button(tr("はじめる"), () => {
        beginRound();
      }),
    );
  if (state.phase === "playing") {
    const hint = document.createElement("span");
    hint.className = "keyboard-hint";
    hint.textContent = document.body.classList.contains("keyboard")
      ? tr("1〜6で検知 · Pで一時停止")
      : tr("分かった上のカードも、その場でタップ");
    $("controls").append(hint);
  }
  if (state.phase === "paused" && layoutBlocked) {
    const seed = state.seed;
    const actions = modal(
      tr("画面サイズが変わりました"),
      tr(
        "この広さでは全カードを読めないため停止しました。元の向き・広さへ戻すと、同じ続きから再開できます。",
      ),
    );
    actions.append(
      button(tr("最初からやり直す"), () => prepare(seed, true)),
      button(
        tr("ここまでの結果"),
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
    const actions = modal(tr("ひと休み。"), tr("カードも時間も止まっています。"));
    actions.append(
      button(tr("再開"), togglePause),
      button(
        tr("結果を見る"),
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
  if (["paused", "finished"].includes(state.phase))
    $("overlay").querySelector(".actions").append(languageButton, soundButton);
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
    if (entry.kind === "flag" && entry.correct) {
      const v = explanationCard(entry.question, getLocale());
      lastReason = {
        question: entry.question,
        copy: v.successReason,
        ...decisionFact(entry.question, getLocale()),
      };
      reasonUntil = 0;
      announce(
        tr("{summary}。{detail}", {
          summary: lastReason.copy,
          detail: `${lastReason.label}: ${lastReason.value}`,
        }),
      );
    }
  }
  const show =
    lastReason &&
    (!reasonUntil || performance.now() < reasonUntil) &&
    ["playing", "hitstop"].includes(state.phase);
  text("hit-copy", show ? lastReason.copy : "");
  text("hit-label", show ? lastReason.label : "");
  text("hit-value", show ? lastReason.value : "");
  attribute($("hit-value"), "title", show ? lastReason.fullValue : "");
  $("hit-reason").hidden = !show;
  seen = state.history.length;
}
function lessonText(lesson, key) {
  return getLocale() === "en" ? lesson[key === "title" ? "enTitle" : "enExample"] : lesson[key];
}
function renderLevel() {
  const level = state.level;
  if (level > shownLevel) {
    shownLevel = level;
    const message = lessonNotice(level, getLocale());
    announce(`${message.title}. ${message.detail}`);
  }
  text("level", String(level));
  const progress = (state.correct + state.passed) % CORRECT_PER_LEVEL;
  text("level-progress", `${progress}/${CORRECT_PER_LEVEL}`);
  attribute(
    $("level-progress"),
    "aria-label",
    tr("次のレベルへ {count}/5 正解", { count: progress }),
  );
  const up = Boolean(
    state.lessonNotice?.shownAt !== null &&
      state.lessonNotice?.shownAt !== undefined &&
      state.lessonNotice.readRemaining > 0,
  );
  text("survival-label", tr("生存時間"));
  $("level-caption").classList.toggle("level-up", up);
  $("field").classList.toggle("level-up-active", up);
}
function cueIsVisible(cue) {
  const box = cue.getBoundingClientRect(),
    field = $("message-bar").getBoundingClientRect();
  return !document.hidden && box.height > 0 && box.top >= field.top && box.bottom <= field.bottom;
}
function confirmLessonPaint(notice, cue) {
  if (lessonPaintToken === notice) return;
  lessonPaintToken = notice;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (lessonPaintToken !== notice) return;
      lessonPaintToken = null;
      if (state.lessonNotice !== notice || cue.hidden || !cueIsVisible(cue)) return;
      if (showLesson(state)) {
        lastTime = performance.now();
        renderLevel();
      }
    }),
  );
}
function currentProgressMessage(notice, teaching) {
  if (teaching) return lessonNotice(notice.level, getLocale());
  return { title: tr("5枚正解でレベルアップ"), detail: "" };
}
function startReasonTimer() {
  if (!$("hit-reason").hidden && !reasonUntil)
    reasonUntil =
      performance.now() + reasonDuration(lastReason.copy, lastReason.value, getLocale());
}
function positionLevelCue() {
  const cue = $("level-transition"),
    notice = state.lessonNotice;
  const teaching = Boolean(notice && notice.readRemaining > 0);
  const active = ["playing", "hitstop"].includes(state.phase);
  const intro = state.elapsed < 3000 && $("hit-reason").hidden;
  const visible = (teaching || intro) && active;
  cue.hidden = !visible;
  if (!visible) {
    if (notice) notice.visible = false;
    startReasonTimer();
    return;
  }
  $("hit-reason").hidden = true;
  const message = currentProgressMessage(notice, teaching);
  text("level-transition-title", message.title);
  text("level-transition-detail", message.detail);
  if (teaching) {
    if (!cueIsVisible(cue)) {
      cue.hidden = true;
      notice.visible = false;
      return;
    }
    if (!notice.visible) confirmLessonPaint(notice, cue);
  }
}

function cancelInactiveInput() {
  if (state.phase !== "playing") {
    activeGestureCancel?.();
    paperSound.stop();
  }
  if (!["playing", "hitstop"].includes(state.phase)) clearSlices($("slice-effects"));
}
function render() {
  attribute(document.body, "data-phase", state.phase);
  const wasActive = document.body.classList.contains("active-game");
  const active = state.phase !== "ready";
  if (wasActive !== active) document.body.classList.toggle("active-game", active);
  const pauseHost = active ? document.querySelector(".hud") : document.querySelector(".top");
  if ($("pause").parentElement !== pauseHost) pauseHost.append($("pause"));
  text("start-best", bestMs > 0 ? tr("自己ベスト {time}", { time: duration(bestMs) }) : "");
  document.querySelector(".start-role").textContent =
    `${lessonText(lessonForLevel(1), "title")}。${lessonText(lessonForLevel(1), "example")}`;
  text("score", formatCount(state.score));
  text("combo", state.combo >= 2 ? tr("{count}連続", { count: formatCount(state.combo) }) : "");
  cancelInactiveInput();
  text("survival", duration(state.elapsed));
  text("personal-best", tr("BEST {time}", { time: duration(Math.max(bestMs, state.elapsed)) }));
  renderLevel();
  text("lives", `${"♥".repeat(state.lives)}${"♡".repeat(3 - state.lives)}`);
  attribute($("lives"), "aria-label", tr("残りライフ{count}", { count: formatCount(state.lives) }));
  const pauseDisabled = !["playing", "hitstop", "feedback", "paused"].includes(state.phase);
  if ($("pause").disabled !== pauseDisabled) $("pause").disabled = pauseDisabled;
  attribute($("pause"), "aria-label", state.phase === "paused" ? tr("再開") : tr("一時停止"));
  renderFeedback();
  syncCards();
  positionLevelCue();
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
      list.reduce((n, h) => n + h, 0) + Math.max(0, list.length - 1) * CARD_GAP <=
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
  if (reduced.matches) clearSlices($("slice-effects"));
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
const staticTextNodes = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  const key = node.textContent.trim();
  if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(key))
    staticTextNodes.push({
      node,
      key,
      before: node.textContent.match(/^\s*/)[0],
      after: node.textContent.match(/\s*$/)[0],
    });
}
function applyStaticLocale() {
  const locale = getLocale();
  document.documentElement.lang = locale;
  document.title = tr("APIの番人。 | 目指せクラウドマスター");
  document.querySelector('meta[name="description"]').content = tr(
    "本番AWSの異変をリクエスト引数から見抜く、生存時間チャレンジ。",
  );
  for (const { node, key, before, after } of staticTextNodes)
    node.textContent = before + tr(key) + after;
  $("cards").setAttribute("aria-label", tr("流れてくるAWSリクエスト"));
  document.querySelector(".game").setAttribute("aria-label", tr("AWSリクエスト検知ゲーム"));
  $("pause").setAttribute("aria-label", tr("一時停止"));
  $("lives").setAttribute("aria-label", tr("残りライフ{count}", { count: state?.lives ?? 3 }));
  renderSound();
  languageButton.textContent = locale === "ja" ? "English" : "日本語";
  languageButton.setAttribute(
    "aria-label",
    locale === "ja" ? tr("英語に切り替え") : tr("日本語に切り替え"),
  );
}
function pauseForLanguage() {
  if (state && ["playing", "hitstop"].includes(state.phase)) {
    updateNow();
    pause(state);
    lastTime = null;
    render();
  }
}
languageButton.addEventListener("click", async () => {
  if (languageButton.disabled) return;
  const nextLocale = getLocale() === "ja" ? "en" : "ja";
  pauseForLanguage();
  languageButton.disabled = true;
  try {
    await loadQuestionLocale(nextLocale);
    pauseForLanguage();
    setLocale(nextLocale);
    try {
      const url = new URL(location.href);
      url.searchParams.set("lang", nextLocale);
      history.replaceState(null, "", url);
    } catch {}
    applyStaticLocale();
    geometry = null;
    phase = "";
    if (lastReason?.question) {
      const q = lastReason.question;
      lastReason = {
        question: q,
        copy: explanationCard(q, getLocale()).successReason,
        ...decisionFact(q, getLocale()),
      };
    }
    if (state) {
      state.maxCards = layoutCapacity();
      layoutKey = currentLayout();
      render();
    }
  } catch {
    announce(tr("言語データを読み込めませんでした。もう一度お試しください。"));
  } finally {
    languageButton.disabled = false;
  }
});
async function boot() {
  try {
    [catalog] = await Promise.all([loadCatalog(), loadQuestionLocale(getLocale())]);
    document.fonts.ready.then(() => {
      geometry = null;
    });
    prepare();
    requestAnimationFrame(frame);
  } catch (error) {
    $("controls").replaceChildren(button(tr("読み込みを再試行"), () => location.reload()));
    $("controls").querySelector("button").textContent = tr("問題を読み込めませんでした・再試行");
    announce(String(error));
  }
}
applyStaticLocale();
boot();
