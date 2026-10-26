import { loadCatalog } from "./api-catalog.js";
import { collect, createGame, finish, next, pause, resume, start, tick } from "./engine.js";
import { difficulty } from "./recognition.js";
import { buildShare } from "./share.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
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
function prepare(seed = newSeed(), study = false, begin = false) {
  epoch++;
  state = createGame(catalog, seed, study);
  state.maxCards = innerWidth <= 740 ? 2 : 3;
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
  const s3 = catalog.find((s) => s.id === "s3"),
    iam = catalog.find((s) => s.id === "iam");
  return [
    {
      uid: "demo-pass",
      slot: 0,
      born: 0,
      deadline: 18000,
      question: {
        service: s3.name,
        operation: "GetObject",
        method: "GET",
        path: "/{Bucket}/{Key+}",
        wire: "GET /training-assets/guide.txt HTTP/1.1",
        context: {
          kind: "service",
          allowed: "S3",
          actual: "S3",
          policy: "許可: S3 の全API",
          observed: "要求先: S3",
        },
        danger: false,
      },
    },
    {
      uid: "demo-flag",
      slot: 1,
      born: 0,
      deadline: 18000,
      question: {
        service: iam.name,
        operation: "CreateAccessKey",
        method: "POST",
        path: "/",
        wire: "POST / HTTP/1.1\nAction=CreateAccessKey&Version=2010-05-08",
        context: {
          kind: "service",
          allowed: "S3",
          actual: "IAM",
          policy: "許可: S3 の全API",
          observed: "要求先: IAM",
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
  n.dataset.slot = String(item.slot);
  n.dataset.context = JSON.stringify({
    kind: q.context.kind,
    allowed: q.context.allowed,
    actual: q.context.actual,
  });
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
  wire.textContent = `${q.method} ${q.path}`;
  wire.title = q.wire;
  const policy = document.createElement("span");
  policy.className = "context-row policy";
  policy.textContent = q.context.policy;
  const actual = document.createElement("span");
  actual.className = "context-row observed";
  actual.textContent = q.context.observed;
  n.append(top, operation, wire, policy, actual);
  if (previewing) {
    const cue = document.createElement("span");
    cue.className = "example-note";
    cue.textContent = q.danger ? "許可外 → タップして検知" : "許可内 → 触らず通す ＋10 ↓";
    n.append(cue);
  }
  const thisEpoch = epoch;
  n.addEventListener("click", () => pick(item.uid, thisEpoch));
  n.setAttribute(
    "aria-label",
    `${q.service}、${q.operation}。${q.context.policy}。${q.context.observed}。タップして検知`,
  );
  return n;
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

  n.textContent =
    entry.kind === "pass" ? "通過 ＋10" : entry.kind === "flag" ? `検知 ＋${entry.points}` : "♥ −1";
  const detail = document.createElement("small");
  detail.textContent = entry.question.operation;
  n.append(detail);
  $("effects").replaceChildren(n);
  setTimeout(() => n.remove(), 220);
}
function positions(items, previewing) {
  const field = $("cards"),
    narrow = innerWidth <= 740,
    columns = narrow ? 2 : 3;
  const entries = items.map((item) => {
    const node = nodes.get(String(item.uid));
    const fraction = previewing
      ? [0.18, 0.47][item.slot]
      : state.study
        ? 0.22
        : Math.max(0, Math.min(1, (state.elapsed - item.born) / (item.deadline - item.born)));
    const movement =
      reduced.matches && !previewing && !state.study ? [0.55, 0.1, 0.02][item.slot] : fraction;
    const lane = item.slot % columns;
    node.style.left = `${lane * (field.clientWidth / columns) + (narrow ? 0 : 9)}px`;
    const y =
      previewing || state.study
        ? 14 + movement * Math.max(0, field.clientHeight - node.offsetHeight - 24)
        : Math.max(8, movement * Math.max(0, field.clientHeight - node.offsetHeight));
    return { item, node, lane, y };
  });
  if (narrow)
    for (let lane = 0; lane < 2; lane++) {
      const pair = entries
        .filter((v) => v.lane === lane)
        .sort((a, b) => a.item.born - b.item.born || a.item.slot - b.item.slot);
      if (pair.length === 2) {
        const [older, younger] = pair;
        younger.y = Math.min(
          younger.y,
          Math.max(
            10,
            field.clientHeight - older.node.offsetHeight - younger.node.offsetHeight - 14,
          ),
        );
        older.y = Math.max(older.y, younger.y + younger.node.offsetHeight + 12);
        older.y = Math.min(older.y, field.clientHeight - older.node.offsetHeight - 2);
      }
    }
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
    const arriving = !previewing && !state.study && state.elapsed - item.born < 300;
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
function actualRequest(entry, actions) {
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
      : e.kind === "wrong"
        ? "許可内の操作でした"
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
    source.textContent = "固定版のAWSモデル ↗";
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
  const actions = modal(
    "今回の検知記録",
    `正しい検知 ${state.correct} ／ 正常通過 ${state.passed} ／ ミス ${state.mistakes} ／ Lv.${difficulty(state.correct).level}`,
  );
  const score = document.createElement("div");
  score.className = "score-result";
  score.textContent = `${state.score} pt`;
  $("overlay").prepend(score);
  const seed = state.seed,
    study = state.study;
  actions.append(
    button("もう一回", () => prepare(newSeed(), study, true)),
    button("同じ流れで復習", () => prepare(seed, study, true), false),
  );
  sharing();
  review();
  announce(`結果。${state.score}点。正しい検知${state.correct}回。`);
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
      ? "1〜3で検知 · Pで一時停止"
      : "分かった上のカードも、その場でタップ";
    $("controls").append(hint);
  }
  if (state.phase === "paused") {
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
  $("score").textContent = String(state.score);
  $("level").innerHTML = `${difficulty(state.correct).level}<span>/ 5</span>`;
  $("lives").textContent = `${"♥ ".repeat(state.lives)}${"♡ ".repeat(3 - state.lives)}`;
  $("lives").setAttribute("aria-label", `残りライフ${state.lives}`);
  $("pause").disabled = !["playing", "hitstop", "feedback", "paused"].includes(state.phase);
  $("pause").setAttribute("aria-label", state.phase === "paused" ? "再開" : "一時停止");
  $("floor").textContent = state.study
    ? "時間なし · 拾うか、そのまま通すか"
    : "許可外を見逃すと ♥−1・止まって解説";
  for (const entry of state.history.slice(seen)) feedbackEffect(entry);
  seen = state.history.length;
  syncCards();
  if (phase !== state.phase) {
    phase = state.phase;
    if (phase !== "hitstop") phaseContent();
  }
}
function togglePause() {
  if (!state) return;
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
document.addEventListener("keydown", (event) => {
  if (!state || event.altKey || event.ctrlKey || event.metaKey) return;
  if (["Tab", "1", "2", "3"].includes(event.key)) document.body.classList.add("keyboard");
  if (event.repeat && ["1", "2", "3", "Enter", " ", "p", "P", "Escape"].includes(event.key)) {
    event.preventDefault();
    return;
  }
  if (["1", "2", "3"].includes(event.key) && state.phase === "playing") {
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
  if (!state) return;
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
