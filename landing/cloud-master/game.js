import {
  answer,
  choices,
  createGame,
  current,
  fallDuration,
  finish,
  next,
  pause,
  resume,
  start,
  tick,
} from "./engine.js";

const $ = (id) => document.getElementById(id);
let state = createGame();
let shownPhase = "";
let lastTime = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const buttons = choices.map((choice, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "answer";
  button.setAttribute("aria-keyshortcuts", String(index + 1));
  button.innerHTML = `<kbd aria-hidden="true">${index + 1}</kbd><span class="mark" aria-hidden="true">${choice.mark}</span><span class="label">${choice.label}</span><span class="name">${choice.name}</span>`;
  button.addEventListener("click", () => choose(choice.id));
  $("answers").append(button);
  return button;
});
function announce(message) {
  $("live").textContent = message;
}
function action(label, callback, primary = true) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = primary ? "primary" : "secondary";
  button.addEventListener("click", callback);
  return button;
}
function begin(mode) {
  state = createGame(mode);
  shownPhase = "";
  $("review").hidden = true;
  start(state);
  lastTime = null;
  render();
  $("field").closest(".arena").scrollIntoView({ block: "start" });
}
function choose(id) {
  if (answer(state, id)) render();
}
function advance() {
  if (state.mode === "learn" && state.index + 1 === state.deck.length) finish(state);
  else next(state);
  lastTime = null;
  render();
}
function togglePause() {
  if (state.phase === "paused") resume(state);
  else pause(state);
  lastTime = null;
  render();
}
function overlayContent(symbol, title, description) {
  const overlay = $("overlay");
  overlay.replaceChildren();
  const icon = document.createElement("div");
  icon.className = "symbol";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = symbol;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = description;
  const actions = document.createElement("div");
  actions.className = "actions";
  overlay.append(icon, heading, text, actions);
  return actions;
}
function readyScreen() {
  const actions = overlayContent(
    "☁",
    "その判断で、空へ。",
    "カードが地面に着く前に、5つの役割から選ぼう。3連続正解ごとに空の道がつながる。",
  );
  actions.append(
    action("75秒チャレンジ →", () => begin("timed")),
    action("じっくり学ぶ", () => begin("learn"), false),
  );
  const note = document.createElement("p");
  note.className = "sub";
  note.textContent = "チャレンジは操作中の75秒。解説中は時間が止まります。";
  $("overlay").append(note);
}
function feedbackScreen() {
  const feedback = state.feedback;
  const correctChoice = choices.find((choice) => choice.id === feedback.question.answer);
  const title = feedback.correct
    ? `正解！ +${feedback.points}`
    : feedback.answer === null
      ? "通り過ぎた！ 一緒に確認。"
      : "おしい！ 役割を確認しよう。";
  const actions = overlayContent(
    feedback.correct ? "✓" : "↻",
    title,
    `${correctChoice.label}（${correctChoice.name}）。${feedback.question.why}`,
  );
  actions.append(
    action(
      state.mode === "learn" && state.index === 19 ? "学習の結果を見る →" : "次のシナリオ →",
      advance,
    ),
  );
  announce(`${title} ${correctChoice.label}。${feedback.question.why}`);
}
function renderReview() {
  const missed = state.history.filter((entry) => !entry.correct);
  $("review").hidden = missed.length === 0;
  $("review-list").replaceChildren();
  for (const entry of missed) {
    const article = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = entry.question.title;
    const prompt = document.createElement("p");
    prompt.textContent = entry.question.prompt;
    const explanation = document.createElement("p");
    const correctChoice = choices.find((choice) => choice.id === entry.question.answer);
    explanation.textContent = `答え：${correctChoice.label}。${entry.question.why}`;
    article.append(heading, prompt, explanation);
    $("review-list").append(article);
  }
}
function resultScreen() {
  const count = state.history.length;
  const actions = overlayContent(
    "✦",
    "今日の一歩が、次の力に。",
    `${count}問に挑戦 / ${state.correct}問正解 / 最長 ${state.best} チェイン。${count === 0 ? "まずは時間制限なしで、1問から。" : "得点はゲーム内の目安です。"}`,
  );
  const score = document.createElement("div");
  score.className = "result-score";
  score.textContent = `${state.score} pt`;
  $("overlay").insertBefore(score, actions);
  actions.append(
    action("もう一度挑戦 →", () => begin(state.mode)),
    action(
      "モードを選ぶ",
      () => {
        state = createGame();
        $("review").hidden = true;
        render();
      },
      false,
    ),
  );
  renderReview();
  announce(`終了。${state.score}点。${count}問中${state.correct}問正解。`);
}
function phaseScreen() {
  $("overlay").replaceChildren();
  if (state.phase === "ready") readyScreen();
  if (state.phase === "feedback") feedbackScreen();
  if (state.phase === "paused") {
    const actions = overlayContent(
      "Ⅱ",
      "ひと休み。",
      "時間とカードは止まっています。準備ができたら再開しよう。",
    );
    actions.append(
      action("再開する →", togglePause),
      action("最初から", () => begin(state.mode), false),
    );
    announce("一時停止しました。再開ボタンで続けられます。");
  }
  if (state.phase === "finished") resultScreen();
  if (state.phase === "playing") {
    const question = current(state);
    $("question-number").textContent = `SCENARIO ${String(state.index + 1).padStart(2, "0")}`;
    $("question-title").textContent = question.title;
    $("question-prompt").textContent = question.prompt;
    announce(`${question.title}。${question.prompt}`);
  }
  if (state.phase !== "ready") {
    const target = state.phase === "playing" ? buttons[0] : $("overlay").querySelector("button");
    target?.focus({ preventScroll: true });
  }
}
function render() {
  document.body.classList.toggle("is-session", state.phase !== "ready");
  $("score").textContent = String(state.score).padStart(4, "0");
  $("combo").textContent = String(state.combo);
  $("time-label").textContent = state.mode === "learn" ? "時間制限なし" : "残り時間";
  $("time").textContent =
    state.mode === "learn" ? "∞" : `${Math.ceil((75000 - state.elapsed) / 1000)}秒`;
  $("scenario").hidden = state.phase !== "playing";
  $("pause").disabled = !["playing", "paused", "feedback"].includes(state.phase);
  $("pause").setAttribute("aria-label", state.phase === "paused" ? "再開" : "一時停止");
  $("finish").hidden = !["playing", "feedback"].includes(state.phase);
  for (const button of buttons) button.disabled = state.phase !== "playing";
  document.querySelectorAll("#nodes circle").forEach((node, index) => {
    node.classList.toggle("lit", index < Math.floor(state.best / 3));
  });
  const fraction = state.mode === "learn" ? 0 : Math.min(1, state.fall / fallDuration(state));
  const travel = Math.max(0, $("field").clientHeight - $("scenario").offsetHeight - 62);
  $("scenario").style.top = `${20 + (reducedMotion.matches ? 0 : fraction * travel)}px`;
  $("fall-progress").style.width = `${100 * (1 - fraction)}%`;
  if (shownPhase !== state.phase) {
    shownPhase = state.phase;
    phaseScreen();
  }
}
$("pause").addEventListener("click", togglePause);
$("finish").addEventListener("click", () => {
  finish(state);
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  const choice = choices[Number(event.key) - 1];
  if (choice && state.phase === "playing") {
    event.preventDefault();
    choose(choice.id);
  }
  if (event.key.toLowerCase() === "p" || event.key === "Escape") {
    event.preventDefault();
    togglePause();
  }
});
function backgroundPause() {
  pause(state);
  lastTime = null;
  render();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) backgroundPause();
});
window.addEventListener("blur", backgroundPause);
window.addEventListener("pagehide", backgroundPause);
function frame(time) {
  if (lastTime !== null) tick(state, time - lastTime);
  lastTime = time;
  render();
  requestAnimationFrame(frame);
}
render();
requestAnimationFrame(frame);
