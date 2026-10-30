import { inspectionRow } from "./cases.js?v=09ce225f20";
import { COPY } from "./copy.js?v=09ce225f20";
import {
  advanceClock,
  createClock,
  inspectionOpen,
  progress,
  viewAfterAnswer,
} from "./deadline.js?v=09ce225f20";
import { button, element } from "./dom.js?v=09ce225f20";
import { updateIdnFonts } from "./idn-explanation.js?v=09ce225f20";
import { createEmail } from "./mail-view.js?v=09ce225f20";
import {
  createRun,
  currentCase,
  currentLevel,
  end,
  expire,
  next,
  reveal,
  risks,
  roundScore,
  tap,
  totals,
} from "./model.js?v=09ce225f20";
import { createResultsView } from "./result-view.js?v=09ce225f20";

const byId = (id) => document.getElementById(id);
let lang = new URL(location.href).searchParams.get("lang") === "en" ? "en" : "ja";
const previousVariants = {};
function freshRun(level = 1) {
  const nextRun = createRun(Math.random, level, previousVariants, lang);
  Object.assign(previousVariants, nextRun.variants);
  return nextRun;
}
let run = freshRun();
const guideOpen = new Set();
const freshView = () => ({
  active: "received",
  lastTarget: null,
  idnOpen: {},
  address: { reference: false, received: false },
  link: { reference: false, received: false },
  original: { reference: false, received: false },
});
let mailUI = freshView();
let clock = createClock(performance.now());
let foreground = !document.hidden;
let deadlineStage = "";
function inspecting() {
  return inspectionOpen(
    mailUI,
    window.matchMedia("(max-width: 900px)").matches,
    Boolean(document.querySelector(".reason details[open]")),
  );
}
function rebaseClock() {
  clock = advanceClock(clock, performance.now(), false);
}
function resetClock() {
  clock = createClock(performance.now());
  deadlineStage = "";
}
function closeInspection() {
  if (!settleClock()) return;
  mailUI.lastTarget = null;
  for (const kind of ["address", "link", "original"])
    mailUI[kind] = { reference: false, received: false };
  render("details-received");
}
function deadlineState(complete, paused) {
  if (complete) return "complete";
  if (paused) return "paused";
  return progress(clock) >= 0.8 ? "soon" : "queued";
}
function stageLabel(stage, t) {
  return { complete: t.inspected, paused: t.inspecting, soon: t.soon, queued: t.queued }[stage];
}
function paintDeadline() {
  const card = byId("email-received"),
    t = COPY[lang];
  if (!card) return;
  const paused = inspecting(),
    complete = run.phase !== "playing";
  const stage = deadlineState(complete, paused);
  const marker = Math.floor(progress(clock) * 100);
  card.classList.add("processing-mail");
  card.style.setProperty("--process", `${marker}%`);
  card.dataset.processing = stage;
  const label = byId("deadline-state");
  if (label) label.textContent = run.timedOut[run.index] ? t.timedOut : stageLabel(stage, t);
  const resume = byId("deadline-resume");
  if (resume) resume.hidden = !paused || complete;
  if (stage !== deadlineStage && stage === "soon") byId("live").textContent = t.soon;
  deadlineStage = stage;
}
function settleClock(now = performance.now()) {
  clock = advanceClock(
    clock,
    now,
    foreground && !document.hidden && run.phase === "playing" && !inspecting(),
  );
  if (run.phase === "playing" && progress(clock) >= 1) {
    run = expire(run);
    mailUI.active = "received";
    mailUI.address.received = risks(run).some((row) => ["from", "reply"].includes(row.id));
    mailUI.link.received = risks(run).some((row) => row.id === "link");
    render("round-title");
    byId("live").textContent = COPY[lang].timedOut;
    return false;
  }
  return run.phase !== "timed-out";
}
function frame(now) {
  settleClock(now);
  paintDeadline();
  requestAnimationFrame(frame);
}
function visibility() {
  settleClock();
  foreground = !document.hidden && document.hasFocus();
  rebaseClock();
}
document.addEventListener("visibilitychange", visibility);
window.addEventListener("blur", () => {
  settleClock();
  foreground = false;
  rebaseClock();
});
window.addEventListener("focus", visibility);
function choose(id, focusId) {
  if (run.phase !== "playing" || !settleClock()) return;
  run = tap(run, id);
  mailUI = viewAfterAnswer(mailUI, focusId);
  render(focusId);
  const target = byId(focusId);
  if (!target?.getClientRects().length) byId("details-received")?.focus({ preventScroll: true });
  const item = inspectionRow(currentCase(run), id);
  byId("live").textContent =
    `${run.feedback.delta < 0 ? COPY[lang].wrong : item.kind === "risk" ? COPY[lang].statusRisk : COPY[lang].statusNormal} ${item.reason[lang]}`;
}
function advance() {
  run = next(run);
  resetClock();
  mailUI = freshView();
  render("round-title");
}
function restartRun(level = 1) {
  guideOpen.clear();
  run = freshRun(level);
  resetClock();
  mailUI = freshView();
  render("round-title");
}
function playView(t) {
  const fragment = document.createDocumentFragment();
  const item = currentCase(run);
  const counts = totals(run);
  const scoreText = (template, score, max) =>
    template.replace("{score}", String(score)).replace("{max}", String(max));
  const hud = element("div", undefined, "round-bar");
  hud.append(
    element(
      "span",
      `Lv${currentLevel(run)} · ${run.index + 1}/${run.rounds.length}`,
      "round-number",
    ),
    element(
      "span",
      run.emailLanguages[run.index] === "en" ? "English email" : "日本語メール",
      "email-language",
    ),
    Object.assign(element("div", undefined, "spot-count"), { id: "score-summary" }),
  );
  hud.lastChild.append(
    element("span", scoreText(t.roundScore, roundScore(run), 20), "round-score"),
    element("span", scoreText(t.totalScore, counts.score, counts.maxScore), "total-score"),
    element(
      "span",
      `${t.ownCount} ${run.found[run.index].length}/${risks(run).length} · ${t.mistakes} ${run.mistakes[run.index].length}`,
      "answer-count",
    ),
  );
  const heading = element("h2", item.title[lang]);
  heading.id = "round-title";
  heading.tabIndex = -1;
  const facts = element("p", item.context[lang], "scene-context");
  const tabs = element("div", undefined, "mail-tabs");
  tabs.setAttribute("aria-label", t.mobileCompare);
  for (const side of ["reference", "received"]) {
    const tab = button(side === "reference" ? t.reference : t.received, () => {
      if (!settleClock()) return;
      mailUI.active = side;
      render(`tab-${side}`);
    });
    tab.id = `tab-${side}`;
    tab.setAttribute("aria-pressed", String(mailUI.active === side));
    tab.setAttribute("aria-controls", `email-${side}`);
    tabs.append(tab);
  }
  const board = element("div", undefined, "email-comparison");
  board.setAttribute("aria-label", t.roundAria);
  const handlers = {
    choose,
    toggle: (kind, side, focus) => {
      if (!settleClock()) return;
      mailUI[kind][side] = !mailUI[kind][side];
      render(focus);
    },
  };
  board.append(
    ...["reference", "received"].map((side) =>
      createEmail(item, side, lang, run, mailUI, handlers),
    ),
  );
  const deadline = element("div", undefined, "processing-status");
  const state = element("span");
  state.id = "deadline-state";
  const resume = button(t.resume, closeInspection, "text-button");
  resume.id = "deadline-resume";
  deadline.append(state, resume);
  board.querySelector("#email-received .message-source").append(deadline);
  const controls = element("div", undefined, "round-controls");
  if (run.phase === "round-complete") {
    if (run.timedOut[run.index])
      controls.append(element("p", `${t.timedOut} ${t.timeoutReason}`, "round-timeout"));
    controls.append(
      element(
        "p",
        run.revealed[run.index].length
          ? t.reviewedRound
          : t.roundDone.replace("{count}", String(risks(run).length)),
        "done-text",
      ),
    );
    const advanceButton = button(
      run.index + 1 < run.rounds.length
        ? t.next.replace("{level}", String(currentLevel(run) + 1))
        : t.finish,
      advance,
      "primary",
    );
    advanceButton.id = "next";
    controls.append(advanceButton);
  } else {
    const answerButton = button(
      t.reveal,
      () => {
        if (!settleClock()) return;
        run = reveal(run);
        mailUI.active = "received";
        mailUI.address.received = risks(run).some((row) => ["from", "reply"].includes(row.id));
        mailUI.link.received = risks(run).some((row) => row.id === "link");
        render("next");
        byId("live").textContent = t.shownAnswers;
      },
      "text-button",
    );
    answerButton.id = "reveal";
    controls.append(answerButton);
  }
  fragment.append(hud, heading, facts, element("p", t.tapHint, "tap-hint"), tabs, board, controls);
  return fragment;
}
function resultsView(t) {
  return createResultsView({
    t,
    run,
    lang,
    guideOpen,
    onReplay: () => restartRun(run.startLevel),
    onRestart: () => restartRun(),
  });
}
function render(focusId) {
  const t = COPY[lang];
  document.documentElement.lang = lang;
  document.title = `${t.title} | TenkaCloud`;
  document.querySelector('meta[name="description"]').content = t.pageDescription;
  byId("title").textContent = t.title;
  byId("instruction").textContent = `${t.instruction} ${t.processing}`;
  byId("safety").textContent = t.safety;
  byId("home").textContent = "TenkaCloud";
  byId("home").setAttribute("aria-label", t.home);
  byId("home").href = `../?lang=${lang}`;
  byId("games").textContent = t.games;
  byId("games").href =
    `../portal-demo/?demo=1&goto=${encodeURIComponent(`/problems?lang=${lang}`)}`;
  byId("exit").textContent = t.exit;
  byId("exit").hidden = ["ended", "results", "timed-out"].includes(run.phase);
  for (const locale of ["ja", "en"])
    byId(locale).setAttribute("aria-pressed", String(lang === locale));
  byId("app").replaceChildren(
    ["results", "ended", "timed-out"].includes(run.phase) ? resultsView(t) : playView(t),
  );
  updateIdnFonts();
  paintDeadline();
  if (focusId) byId(focusId)?.focus({ preventScroll: !["round-title", "next"].includes(focusId) });
}
function language(locale) {
  settleClock();
  lang = locale;
  const url = new URL(location.href);
  url.searchParams.set("lang", lang);
  history.replaceState(null, "", url);
  byId("live").textContent = "";
  render(locale);
}
byId("ja").addEventListener("click", () => language("ja"));
byId("en").addEventListener("click", () => language("en"));
byId("exit").addEventListener("click", () => {
  settleClock();
  run = end(run);
  render("round-title");
});
window.addEventListener("popstate", () => {
  lang = new URL(location.href).searchParams.get("lang") === "en" ? "en" : "ja";
  render();
});
render();
window.addEventListener("resize", updateIdnFonts);

requestAnimationFrame(frame);
