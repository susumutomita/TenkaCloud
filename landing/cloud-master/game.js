import {
  collect,
  createGame,
  finish,
  next,
  passStudy,
  pause,
  resume,
  start,
  tick,
} from "./engine.js";
import { choices } from "./questions.js";
import { modes } from "./recognition.js";
import { buildShare } from "./share.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let state = createGame("foundation", newSeed());
let epoch = 0;
let shownPhase = "";
let lastTime = null;
let demoDone = false;
const cardNodes = new Map();
function newSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
function announce(message) {
  $("live").textContent = message;
}
function button(label, callback, primary = true) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = primary ? "primary" : "secondary";
  element.textContent = label;
  element.addEventListener("click", callback);
  return element;
}
function prepare(mode = state.mode, seed = newSeed(), study = false, begin = false) {
  epoch++;
  state = createGame(mode, seed, study);
  demoDone = false;
  shownPhase = "";
  lastTime = null;
  $("review").hidden = true;
  cardNodes.clear();
  $("cards").replaceChildren();
  $("effects").replaceChildren();
  if (begin) start(state);
  render();
}
function begin(study = false) {
  prepare(state.mode, state.seed, study, true);
}
function updateNow() {
  const now = performance.now();
  if (lastTime !== null) tick(state, Math.max(0, now - lastTime));
  lastTime = now;
}
function hit(item, points, demo = false) {
  const node = cardNodes.get(String(item.uid));
  const spark = document.createElement("div");
  spark.className = "hit";
  spark.style.left = node ? `${node.offsetLeft + 12}px` : "40%";
  spark.style.top = node ? `${node.offsetTop + 20}px` : "35%";
  spark.textContent = `✓ +${points}`;
  const chain = document.createElement("small");
  chain.textContent = demo ? "キャッチ！" : `${state.combo} CHAIN`;
  spark.append(chain);
  $("effects").append(spark);
  setTimeout(() => spark.remove(), reduced.matches ? 850 : 650);
  $("catch-zone").classList.remove("success");
  requestAnimationFrame(() => $("catch-zone").classList.add("success"));
}
function pick(uid, expectedEpoch) {
  if (expectedEpoch !== epoch) return;
  if (state.phase === "ready") {
    const item = previewItems().find((candidate) => candidate.uid === uid);
    if (item?.question.match) {
      demoDone = true;
      hit(item, 100, true);
      announce("キャッチ成功。対象のカードだけを拾います。開始ボタンで本番へ。");
    } else announce("このカードは対象外。光っているカードをタップしてみよう。");
    render();
    return;
  }
  updateNow();
  const item = state.active.find((candidate) => candidate.uid === uid);
  if (collect(state, uid) && item) {
    if (state.feedback.correct) {
      hit(item, state.feedback.points);
      announce(`キャッチ。${state.combo}連続、${state.score}点。`);
    } else {
      lifeHit(item);
      announce(`誤タップ。ライフが1減りました。残り${state.lives}。${explanation(state.feedback)}`);
    }
  }
  render();
}
function lifeHit(item) {
  const node = cardNodes.get(String(item.uid));
  const spark = document.createElement("div");
  spark.className = "hit wrong";
  spark.textContent = "× −1 LIFE";
  spark.style.left = node ? `${node.offsetLeft + 5}px` : "35%";
  spark.style.top = node ? `${node.offsetTop + 15}px` : "35%";
  $("effects").append(spark);
  setTimeout(() => spark.remove(), 1000);
}
function previewItems() {
  const matching = state.deck.find((q) => q.match);
  const others = state.deck.filter((q) => !q.match);
  return [matching, others[0], others.find((q) => q.id !== others[0].id)].map((question, slot) => ({
    uid: `demo-${slot}`,
    slot,
    question,
    born: 0,
    deadline: 15000,
  }));
}
function card(item) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `falling${item.question.code ? " code" : ""}`;
  element.dataset.uid = String(item.uid);
  element.dataset.slot = String(item.slot);
  const top = document.createElement("span");
  top.className = "card-top";
  const name = document.createElement("span");
  name.textContent = item.question.title;
  const key = document.createElement("span");
  key.className = "slot";
  key.textContent = String(item.slot + 1);
  key.setAttribute("aria-hidden", "true");
  top.append(name, key);
  const prompt = document.createElement("span");
  prompt.className = "prompt";
  prompt.textContent = item.question.code
    ? item.question.prompt.split(/\r?\n/u).slice(0, 3).join("\n")
    : item.question.prompt;
  const track = document.createElement("span");
  track.className = "deadline";
  track.setAttribute("aria-hidden", "true");
  track.append(document.createElement("i"));
  element.append(top, prompt, track);
  const currentEpoch = epoch;
  element.addEventListener("click", () => pick(item.uid, currentEpoch));
  element.addEventListener("focus", () => {
    element.classList.add("focused");
  });
  element.addEventListener("blur", () => {
    element.classList.remove("focused");
  });
  element.setAttribute(
    "aria-label",
    `カード${item.slot + 1}。${item.question.title}。${item.question.prompt}。拾う`,
  );
  return element;
}
function itemFraction(item, preview) {
  if (preview) return [0.04, 0.43, 0.34][item.slot];
  if (state.study) return 0.22;
  return Math.max(0, Math.min(1, (state.elapsed - item.born) / (item.deadline - item.born)));
}
function styleCard(node, item, preview) {
  const isDemoAnswer = preview && item.question.match;
  node.classList.toggle("demo-answer", isDemoAnswer);
  node.classList.toggle("example-other", preview && !item.question.match);
  if (isDemoAnswer && !node.querySelector(".demo-hint")) {
    const hint = document.createElement("span");
    hint.className = "demo-hint";
    hint.textContent = "ここをタップ ↓ キャッチ";
    node.append(hint);
  }
  node.disabled =
    !["ready", "playing"].includes(state.phase) ||
    (!preview && !state.study && state.elapsed - item.born < 300);
  const fraction = itemFraction(item, preview);
  node.classList.toggle("urgent", !preview && !state.study && fraction > 0.8);
  node.querySelector(".deadline i").style.transform = `scaleX(${1 - fraction})`;
}
function syncCards() {
  const preview = state.phase === "ready";
  const items = preview ? previewItems() : state.active;
  const valid = new Set(items.map((item) => String(item.uid)));
  for (const [uid, node] of cardNodes)
    if (!valid.has(uid)) {
      node.remove();
      cardNodes.delete(uid);
    }
  for (const item of items) {
    const uid = String(item.uid);
    if (!cardNodes.has(uid)) {
      const node = card(item);
      cardNodes.set(uid, node);
      $("cards").append(node);
    }
    styleCard(cardNodes.get(uid), item, preview);
  }
  positionCards(items, preview);
}
function positionEntry(item, preview, narrow, columns, width, height) {
  const node = cardNodes.get(String(item.uid));
  const lane = state.study ? 0 : item.slot % columns;
  const fraction = itemFraction(item, preview);
  const progress =
    reduced.matches && !preview && !state.study ? [0.56, 0.16, 0.02][item.slot] : fraction;
  const y = 22 + progress * Math.max(0, height - node.offsetHeight - 30);
  if (state.study) {
    node.style.width = narrow ? "86%" : "48%";
    node.style.left = "50%";
    node.style.transform = "translateX(-50%)";
  } else {
    node.style.left = `${lane * (width / columns) + (narrow ? 0 : 10)}px`;
    node.style.width = "";
    node.style.transform = "";
  }
  return { item, node, lane, y };
}
function positionCards(items, preview) {
  const container = $("cards");
  const narrow = innerWidth <= 740;
  const width = container.clientWidth;
  const height = container.clientHeight;
  const columns = narrow ? 2 : 3;
  const entries = items.map((item) => positionEntry(item, preview, narrow, columns, width, height));
  // Two columns on phones: keep the two objects in one lane readable and separately tappable.
  if (narrow && !state.study)
    for (let lane = 0; lane < columns; lane++) {
      const group = entries
        .filter((entry) => entry.lane === lane)
        .sort((a, b) => a.item.born - b.item.born || a.item.slot - b.item.slot);
      if (group.length === 2) {
        const [older, younger] = group;
        younger.y = Math.min(
          younger.y,
          Math.max(12, height - older.node.offsetHeight - younger.node.offsetHeight - 12),
        );
        older.y = Math.max(older.y, younger.y + younger.node.offsetHeight + 12);
        older.y = Math.min(older.y, height - older.node.offsetHeight - 3);
      }
    }
  for (const entry of entries) entry.node.style.top = `${Math.max(8, entry.y)}px`;
}
function togglePause() {
  updateNow();
  if (state.phase === "paused") resume(state);
  else pause(state);
  lastTime = null;
  render();
}
function overlay(title, description) {
  const node = $("overlay");
  node.replaceChildren();
  node.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = description;
  const actions = document.createElement("div");
  actions.className = "actions";
  node.append(heading, text, actions);
  return actions;
}
function result() {
  const end = state.end;
  const title = end?.reason === "lives" ? "この回の記録" : "ここまでの記録";
  const actions = overlay(
    title,
    `${state.correct} ${state.study ? "正解" : "キャッチ"} · 最長 ${state.best} チェイン · ${(state.elapsed / 1000).toFixed(1)} 秒`,
  );
  const score = document.createElement("div");
  score.className = "result-score";
  score.textContent = `${state.score} pt`;
  $("overlay").prepend(score);
  if (end?.entry) {
    const entry = end.entry;
    const mistake = document.createElement("p");
    mistake.className = "mistake";
    mistake.textContent = entry.question.prompt.split(/\r?\n/u).slice(0, 3).join("\n");
    const why = document.createElement("p");
    why.textContent = explanation(entry);
    $("overlay").insertBefore(mistake, actions);
    $("overlay").insertBefore(why, actions);
  }
  const mode = state.mode,
    seed = state.seed;
  actions.append(
    button("新しい回へ →", () => prepare(mode)),
    button("同じ回を再挑戦", () => prepare(mode, seed, false, true), false),
  );
  addSharing();
  renderReview();
  announce(`${title}${state.score}点。${end?.entry?.question.why ?? ""}`);
}
function explanation(entry) {
  if (state.mode !== "foundation") return entry.question.why;
  const role = choices.find((choice) => choice.id === entry.question.answer);
  const decision = entry.question.match
    ? `今回の対象「${state.target.label}」の仕事です。`
    : `これは「${role.label}」の仕事。今回の対象「${state.target.label}」ではないので見送ります。`;
  return `${decision}${entry.question.why}`;
}
function addSharing() {
  const share = buildShare(state, location);
  const row = document.createElement("div");
  row.className = "share-actions";
  const link = document.createElement("a");
  link.className = "secondary";
  link.href = share.intent;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "X でシェア ↗";
  const copy = button(
    "結果をコピー",
    async () => {
      try {
        await navigator.clipboard.writeText(share.copy);
        copy.textContent = "コピーしました ✓";
      } catch {
        const text = document.createElement("textarea");
        text.readOnly = true;
        text.className = "share-copy";
        text.setAttribute("aria-label", "共有する練習記録。選択してコピーできます");
        text.value = share.copy;
        row.append(text);
        text.focus();
        text.select();
        announce("共有テキストを選択しました。コピーして使えます。");
      }
    },
    false,
  );
  row.append(link, copy);
  $("overlay").append(row);
  const note = document.createElement("p");
  note.className = "share-note";
  note.textContent = "投稿は X の画面で確認。開けないときはコピーできます。";
  $("overlay").append(note);
}
function renderReview() {
  $("review").hidden = state.history.length === 0;
  $("review-list").replaceChildren();
  for (const entry of [...state.history].reverse()) {
    const article = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = `${entry.picked === null ? "取り逃し" : entry.correct ? "✓ 正解" : "× 誤ったキャッチ"} · ${entry.question.title}`;
    const prompt = document.createElement(entry.question.code ? "pre" : "p");
    prompt.textContent = entry.question.prompt;
    const why = document.createElement("p");
    why.textContent = explanation(entry);
    article.append(title, prompt, why);
    if (entry.question.source) {
      const link = document.createElement("a");
      link.href = entry.question.source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "公式仕様で確認 ↗";
      article.append(link);
    }
    $("review-list").append(article);
  }
}
function feedbackScreen() {
  const entry = state.feedback;
  let title = entry.correct ? "✓ その判断で OK" : "ここを確認しよう";
  if (!state.study)
    title = entry.kind === "miss" ? `取り逃し −${entry.groupCount ?? 1} LIFE` : "誤タップ −1 LIFE";
  const actions = overlay(title, explanation(entry));
  const prompt = document.createElement("p");
  prompt.className = "mistake";
  prompt.textContent = entry.question.prompt.split(/\r?\n/u).slice(0, 3).join("\n");
  $("overlay").insertBefore(prompt, $("overlay").querySelector("p"));
  const note = document.createElement("p");
  note.textContent = state.study
    ? "時間は止まっています。"
    : `残りライフ ${state.lives} / 3。カードも時間も停止中。`;
  $("overlay").insertBefore(note, actions);
  const label = state.study ? "次へ →" : state.lives === 0 ? "結果を見る →" : "わかった・再開 →";
  actions.append(
    button(label, () => {
      next(state);
      lastTime = null;
      render();
    }),
  );
  announce(`${title}。${explanation(entry)}`);
}
function phaseContent() {
  $("overlay").hidden = true;
  $("overlay").replaceChildren();
  $("controls").replaceChildren();
  if (state.phase === "ready") {
    $("controls").append(
      button("サバイバル開始 →", () => begin(false)),
      button("時間なしで練習", () => begin(true), false),
    );
  }
  if (state.phase === "playing") {
    if (state.study)
      $("controls").append(
        button(
          "見送る",
          () => {
            passStudy(state);
            render();
          },
          false,
        ),
        button(
          "結果を見る",
          () => {
            finish(state);
            render();
          },
          false,
        ),
      );
    else {
      const hint = document.createElement("span");
      hint.className = "play-hint";
      hint.textContent = "カードをタップ ／ 1・2・3 キーでキャッチ ／ P で休憩";
      $("controls").append(hint);
    }
  }
  if (state.phase === "paused") {
    const actions = overlay("空も、ひと休み。", "カードと時間は止まっています。");
    actions.append(
      button("再開する →", togglePause),
      button(
        "ここで終了",
        () => {
          finish(state);
          render();
        },
        false,
      ),
    );
    announce("一時停止。再開ボタンで続けられます。");
  }
  if (state.phase === "feedback") feedbackScreen();
  if (state.phase === "finished") result();
  if (["paused", "feedback", "finished"].includes(state.phase))
    $("overlay").querySelector("button")?.focus({ preventScroll: true });
}
function renderLives() {
  $("lives").textContent = state.study
    ? "練習"
    : `${"♥ ".repeat(state.lives)}${"♡ ".repeat(3 - state.lives)}`;
  $("lives").setAttribute("aria-label", state.study ? "練習モード" : `残りライフ${state.lives}`);
}
function render() {
  document.body.dataset.phase = state.phase;
  $("mode-caption").textContent = modes.find((mode) => mode.id === state.mode).eyebrow;
  $("objective").textContent = state.target.title;
  $("objective-detail").textContent = state.target.detail;
  $("score").textContent = String(state.score);
  renderLives();
  $("record").textContent = `${state.correct} ${state.study ? "正解 · 練習" : "キャッチ"}`;
  $("catch-mark").textContent = state.target.mark;
  $("catch-label").textContent = state.target.label;
  $("seed-label").textContent = `SEED ${state.seed}`;
  $("pause").disabled = !["playing", "paused", "feedback"].includes(state.phase);
  $("pause").setAttribute("aria-label", state.phase === "paused" ? "再開" : "一時停止");
  $("modes")
    .querySelectorAll("button")
    .forEach((node) => {
      node.disabled = !["ready", "finished"].includes(state.phase);
      node.setAttribute("aria-pressed", String(node.dataset.mode === state.mode));
    });
  $("field-cue").hidden = !["ready", "playing"].includes(state.phase);
  $("field-cue").textContent =
    state.phase === "ready"
      ? demoDone
        ? "✓ キャッチ成功！ 下のボタンで開始"
        : "光るカードでキャッチを試そう ↓"
      : state.study
        ? "時間制限なし · 拾うか、見送るか"
        : "上のカードも、分かった瞬間に拾える";
  $("miss-rule").textContent = state.study
    ? "練習中は落ちません"
    : "見逃し −1 · 止まって解説 ／ 対象外は通過";
  $("rule-line").innerHTML = state.study
    ? "練習は間違えても続けられます。"
    : "<strong>ライフ3 · 0で終了。</strong> 誤タップ −1 ／ 見逃し −1。対象外は見送る。";
  $("catch-hint").textContent =
    state.phase === "ready"
      ? "光るカード → この役割"
      : state.study
        ? "カードを拾う / 見送る"
        : "対象カードを直接タップ";
  syncCards();
  if (shownPhase !== state.phase) {
    shownPhase = state.phase;
    phaseContent();
  }
  if (state.phase === "ready" && demoDone)
    $("controls").querySelector(".primary").textContent = "準備 OK · 開始 →";
}
for (const mode of modes) {
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.mode = mode.id;
  element.textContent = mode.label;
  element.addEventListener("click", () => prepare(mode.id));
  $("modes").append(element);
}
$("pause").addEventListener("click", togglePause);
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.repeat && ["1", "2", "3", "Enter", " ", "p", "P", "Escape"].includes(event.key)) {
    event.preventDefault();
    return;
  }
  if (["1", "2", "3"].includes(event.key) && state.phase === "playing") {
    event.preventDefault();
    const item = state.active.find((candidate) => candidate.slot === Number(event.key) - 1);
    if (item) pick(item.uid, epoch);
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
  if (lastTime !== null) tick(state, Math.max(0, time - lastTime));
  lastTime = time;
  render();
  requestAnimationFrame(frame);
}
render();
requestAnimationFrame(frame);
