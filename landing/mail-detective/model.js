import { inspectionRow } from "./cases.js?v=a6c3955e99";
import { chooseVariant, LEVELS, levelCase } from "./levels.js?v=a6c3955e99";

export function createRun(random = Math.random, startLevel = 1, previousVariants = {}) {
  if (!Number.isInteger(startLevel) || startLevel < 1 || startLevel > LEVELS.length)
    throw new RangeError("Invalid start level");
  const rounds = LEVELS.slice(startLevel - 1, startLevel + 1).map((entry) => entry.id);
  const variants = {};
  for (let offset = 0; offset < rounds.length; offset++) {
    const level = startLevel + offset;
    variants[level] = chooseVariant(random, previousVariants[level]);
  }
  return {
    phase: "playing",
    startLevel,
    rounds,
    variants,
    index: 0,
    found: rounds.map(() => []),
    revealed: rounds.map(() => []),
    checked: rounds.map(() => []),
    mistakes: rounds.map(() => []),
    feedback: null,
  };
}
export function currentLevel(run) {
  return run.startLevel + run.index;
}
export function currentCase(run) {
  return levelCase(currentLevel(run), run.variants[currentLevel(run)]);
}
export function nextStartLevel(run) {
  const level = run.startLevel + run.rounds.length;
  return run.phase === "results" && level <= LEVELS.length ? level : null;
}
export function risks(run) {
  return currentCase(run).rows.filter((item) => item.kind === "risk");
}
export function tap(run, id) {
  if (!["playing", "round-complete"].includes(run.phase)) return run;
  const item = inspectionRow(currentCase(run), id);
  if (!item) return run;
  const known = [...run.found[run.index], ...run.revealed[run.index]].includes(id);
  const found = run.found.map((list) => [...list]);
  const checked = run.checked.map((list) => [...list]);
  const firstAnswer = !checked[run.index].includes(id);
  const mistakes = run.mistakes.map((list) => [...list]);
  if (firstAnswer) {
    checked[run.index].push(id);
    if (item.kind !== "risk") mistakes[run.index].push(id);
  }
  if (item.kind === "risk" && !known) found[run.index].push(id);
  const complete = found[run.index].length + run.revealed[run.index].length === risks(run).length;
  return {
    ...run,
    found,
    checked,
    mistakes,
    phase: complete ? "round-complete" : "playing",
    feedback: {
      id,
      kind: item.kind,
      fresh: item.kind === "risk" && !known,
      delta: item.kind === "risk" ? (known ? 0 : 1) : firstAnswer ? -1 : 0,
    },
  };
}
export function reveal(run) {
  if (run.phase !== "playing") return run;
  const revealed = run.revealed.map((list) => [...list]);
  revealed[run.index] = risks(run)
    .filter((item) => !run.found[run.index].includes(item.id))
    .map((item) => item.id);
  return { ...run, revealed, phase: "round-complete", feedback: null };
}
export function next(run) {
  if (run.phase !== "round-complete") return run;
  return run.index + 1 < run.rounds.length
    ? { ...run, index: run.index + 1, phase: "playing", feedback: null }
    : { ...run, phase: "results", feedback: null };
}
export function end(run) {
  return ["playing", "round-complete"].includes(run.phase)
    ? { ...run, phase: "ended", feedback: null }
    : run;
}
export function totals(run) {
  const target = Array.from(
    { length: run.index + 1 },
    (_, offset) =>
      levelCase(run.startLevel + offset, run.variants[run.startLevel + offset]).rows.filter(
        (row) => row.kind === "risk",
      ).length,
  ).reduce((sum, count) => sum + count, 0);
  const found = run.found.flat().length,
    mistakes = run.mistakes.flat().length;
  return { found, reviewed: run.revealed.flat().length, target, mistakes, score: found - mistakes };
}

export function expire(run) {
  if (run.phase !== "playing") return run;
  return { ...reveal(run), phase: "timed-out", feedback: null };
}
