export const ROUND_MS = 120_000;
export const TASKS = {
  calendar: { kind: "WEB", site: "aoba", mismatch: null },
  application: { kind: "APP", site: "aoba-skills", mismatch: "application" },
  task: { kind: "WEB", site: "aoba", mismatch: null },
  upload: { kind: "WEB", site: "aoba-skills", mismatch: "destination" },
};
function shuffled(random) {
  const ids = Object.keys(TASKS);
  for (let i = ids.length - 1; i > 0; i--) {
    const sample = random();
    const unit = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;
    const j = Math.floor(unit * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
export function start(random = Math.random) {
  return {
    order: shuffled(random),
    revealed: [],
    shots: [],
    aim: null,
    flash: null,
    paused: false,
    remaining: ROUND_MS,
    outcome: null,
    notice: "",
  };
}
export function hits(state) {
  return state.shots.filter((id) => TASKS[id].mismatch).length;
}
export function score(state) {
  const correct = hits(state);
  return Math.max(0, Math.min(100, correct * 50 - (state.shots.length - correct) * 25));
}
export function elapse(state, delta) {
  if (state.outcome || state.paused || !Number.isFinite(delta) || delta <= 0) return state;
  const remaining = Math.max(0, state.remaining - delta);
  return { ...state, remaining, outcome: remaining === 0 ? "timeout" : null };
}
function reveal(state, id) {
  if (!Object.hasOwn(TASKS, id) || state.revealed.includes(id)) return state;
  return { ...state, revealed: [...state.revealed, id], flash: id, notice: "revealed" };
}
function aim(state, id) {
  if (!state.revealed.includes(id) || state.shots.includes(id)) return state;
  return { ...state, aim: id, flash: null, notice: "aim" };
}
function fire(state) {
  const id = state.aim;
  if (!id || !state.revealed.includes(id) || state.shots.includes(id)) return state;
  return {
    ...state,
    shots: [...state.shots, id],
    aim: null,
    flash: id,
    notice: TASKS[id].mismatch ? "hit" : "miss",
  };
}
export function choose(state, action) {
  if (state.outcome) return state;
  if (action.type === "pause") return { ...state, paused: true, notice: "" };
  if (action.type === "resume") return { ...state, paused: false };
  if (state.paused)
    return action.type === "hold" ? { ...state, outcome: "held", paused: false } : state;
  const handlers = {
    reveal: () => reveal(state, action.id),
    aim: () => aim(state, action.id),
    fire: () => fire(state),
    finish: () => (state.revealed.length === 4 ? { ...state, outcome: "complete" } : state),
  };
  return Object.hasOwn(handlers, action.type) ? handlers[action.type]() : state;
}
