import { button, element } from "./dom.js?v=09ce225f20";
import { levelCase } from "./levels.js?v=09ce225f20";
import { currentCase, currentLevel, totals } from "./model.js?v=09ce225f20";
import { createMailShareLink, createNextStep } from "./next-step.js?v=09ce225f20";
import { createReview } from "./review.js?v=09ce225f20";

export function createResultsView({ t, run, lang, guideOpen, onReplay, onRestart }) {
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
      `${t.totalScore.replace("{score}", String(counts.score)).replace("{max}", String(counts.maxScore))} · ${t.mistakes} ${counts.mistakes}`,
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
  const replay = button(timedOut ? t.retry : t.again, onReplay, "primary");
  replay.id = "again";
  const actions = element("div", undefined, "result-actions");
  actions.append(replay, createMailShareLink(lang, run, counts));
  panel.append(actions);
  if (run.startLevel > 1) {
    const restart = button(t.fromStart, onRestart, "text-button");
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
