import { CASES } from "./cases.js?v=5b03650870";

export function createRun(random = Math.random) {
  const ids = CASES.map((item) => item.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
      throw new RangeError("Invalid random sample");
    const j = Math.floor(sample * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return {
    phase: "playing",
    rounds: [ids.find((id) => !CASES.find((item) => item.id === id).advanced), "lookalike"],
    index: 0,
    found: [[], []],
    revealed: [[], []],
    checked: [[], []],
    feedback: null,
  };
}
export function currentCase(run) {
  return CASES.find((item) => item.id === run.rounds[run.index]);
}
export function risks(run) {
  return currentCase(run).rows.filter((item) => item.kind === "risk");
}
export function tap(run, id) {
  if (!["playing", "round-complete"].includes(run.phase)) return run;
  const item = currentCase(run).rows.find((candidate) => candidate.id === id);
  if (!item) return run;
  const known = [...run.found[run.index], ...run.revealed[run.index]].includes(id);
  const found = run.found.map((list) => [...list]);
  const checked = run.checked.map((list) => [...list]);
  if (!checked[run.index].includes(id)) checked[run.index].push(id);
  if (item.kind === "risk" && !known) found[run.index].push(id);
  const complete = found[run.index].length + run.revealed[run.index].length === risks(run).length;
  return {
    ...run,
    found,
    checked,
    phase: complete ? "round-complete" : "playing",
    feedback: { id, kind: item.kind, fresh: item.kind === "risk" && !known },
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
  return { found: run.found.flat().length, reviewed: run.revealed.flat().length, target: 6 };
}

export function expire(run) {
  if (run.phase !== "playing") return run;
  return { ...reveal(run), phase: "timed-out", feedback: null };
}
