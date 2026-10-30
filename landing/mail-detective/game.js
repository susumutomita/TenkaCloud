import { inspectionRow } from "./cases.js?v=3fb492a390";
import { COPY } from "./copy.js?v=3fb492a390";
import { advanceClock, createClock, progress } from "./deadline.js?v=3fb492a390";
import { updateIdnFonts } from "./idn-explanation.js?v=3fb492a390";
import { levelCase } from "./levels.js?v=3fb492a390";
import { createEmail } from "./mail-view.js?v=3fb492a390";
import {
  createRun,
  currentCase,
  currentLevel,
  end,
  expire,
  next,
  nextStartLevel,
  reveal,
  risks,
  roundScore,
  tap,
  totals,
} from "./model.js?v=3fb492a390";
import { createMailShareLink, createNextStep } from "./next-step.js?v=3fb492a390";
import { createReview } from "./review.js?v=3fb492a390";

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
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
  return (
    (window.matchMedia("(max-width: 900px)").matches && mailUI.active === "reference") ||
    mailUI.lastTarget !== null ||
    Object.values(mailUI.address).some(Boolean) ||
    Object.values(mailUI.link).some(Boolean) ||
    Object.values(mailUI.original).some(Boolean) ||
    Boolean(document.querySelector(".reason details[open]"))
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
const button = (label, action, className) => {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};
function choose(id, focusId) {
  if (run.phase !== "playing" || !settleClock()) return;
  mailUI.lastTarget = focusId;
  run = tap(run, id);
  render(focusId);
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
function playView(t) {
  const fragment = document.createDocumentFragment();
  const item = currentCase(run);
  const checked = run.found[run.index].length + run.revealed[run.index].length;
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
    element(
      "span",
      `${t.found} ${checked}/${risks(run).length} · ${t.score} ${roundScore(run)}/20 · ${t.mistakes} ${run.mistakes[run.index].length}`,
      "spot-count",
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
      element("p", t.roundDone.replace("{count}", String(risks(run).length)), "done-text"),
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
  const fragment = document.createDocumentFragment();
  const counts = totals(run);
  const timedOut = run.phase === "timed-out";
  const heading = element(
    "h2",
    timedOut ? t.timedOut : run.phase === "ended" ? t.ended : t.complete,
    "result-title",
  );
  heading.id = "round-title";
  heading.tabIndex = -1;
  const panel = element("section", undefined, "result-panel");
  panel.append(
    heading,
    element(
      "p",
      `${t.score} ${counts.score}/${counts.maxScore} · ${t.mistakes} ${counts.mistakes}`,
      "result-score",
    ),
    element("p", `${t.ownCount} ${counts.found}/${counts.target}`, "result-count"),
    element("p", `${t.reviewCount} ${counts.reviewed}/${counts.target}`),
    element("p", `${t.timeouts} ${counts.timeouts}`),
    element("p", t.coverage),
    element("p", t.takeaway, "takeaway"),
    element("p", t.caution),
    element("p", t.resultsNote, "safety"),
  );
  if (timedOut) panel.append(element("p", t.timeoutReason));
  const replay = button(
    timedOut ? t.retry : t.again,
    () => {
      guideOpen.clear();
      run = freshRun(run.startLevel);
      resetClock();
      mailUI = freshView();
      render("round-title");
    },
    "primary",
  );
  replay.id = "again";
  const actions = element("div", undefined, "result-actions");
  actions.append(replay, createMailShareLink(lang, run, counts));
  panel.append(actions);
  const nextLevel = nextStartLevel(run);
  if (nextLevel !== null) {
    const continueButton = button(
      t.next.replace("{level}", String(nextLevel)),
      () => {
        guideOpen.clear();
        run = freshRun(nextLevel);
        resetClock();
        mailUI = freshView();
        render("round-title");
      },
      "primary",
    );
    continueButton.id = "continue-level";
    actions.append(continueButton);
  }
  if (run.startLevel > 1) {
    const restart = button(
      t.fromStart,
      () => {
        guideOpen.clear();
        run = freshRun();
        resetClock();
        mailUI = freshView();
        render("round-title");
      },
      "text-button",
    );
    restart.id = "restart-levels";
    actions.append(restart);
  }
  const review = element("details", undefined, "result-review");
  review.append(element("summary", t.expand));
  for (let i = 0; i <= run.index; i++) {
    const item = levelCase(run.startLevel + i, run.variants[run.startLevel + i]);
    review.append(element("h3", item.title[lang]));
    for (const field of item.rows.filter((entry) => entry.kind === "risk")) {
      review.append(element("p", `${field.label[lang]}: ${field.reason[lang]}`));
    }
  }
  if (timedOut) {
    const missed = element("section", undefined, "missed-spots");
    missed.append(element("h3", t.missed));
    for (const row of currentCase(run).rows.filter(
      (entry) => entry.kind === "risk" && !run.found[run.index].includes(entry.id),
    )) {
      missed.append(element("p", `${row.label[lang]}: ${row.reason[lang]}`));
    }
    panel.append(missed);
  }
  fragment.append(
    panel,
    review,
    createReview(lang, guideOpen, currentLevel(run)),
    createNextStep(lang),
  );
  return fragment;
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
