export const ROUND_MS = 120_000;
export const SOURCES = {
  domain: "assessment",
  application: "assessment",
  deadline: "assessment",
  role: "profile",
  officialDomain: "official",
  officialApplication: "official",
  officialDeadline: "official",
  officialRole: "official",
};
export const CONNECTIONS = {
  location: ["domain", "officialDomain"],
  software: ["application", "officialApplication"],
};
const VIEWS = ["dm", "profile", "assessment", "official"];
const pairKey = (ids) => [...ids].sort().join(":");

export function start() {
  return {
    view: "dm",
    board: false,
    collected: [],
    selected: [],
    connected: [],
    presented: [],
    attempted: [],
    mistakes: 0,
    armed: null,
    remaining: ROUND_MS,
    outcome: null,
    notice: "",
  };
}
export function score(state) {
  return Math.max(0, Math.min(100, state.presented.length * 50 - state.mistakes * 10));
}
export function elapse(state, delta) {
  if (state.outcome || !Number.isFinite(delta) || delta <= 0) return state;
  const remaining = Math.max(0, state.remaining - delta);
  return { ...state, remaining, outcome: remaining === 0 ? "timeout" : null };
}
function collect(state, id) {
  if (SOURCES[id] !== state.view || state.collected.includes(id)) return state;
  return { ...state, collected: [...state.collected, id], notice: "saved" };
}
function select(state, id) {
  if (!state.collected.includes(id)) return state;
  if (state.selected.includes(id))
    return { ...state, selected: state.selected.filter((item) => item !== id), notice: "" };
  if (state.selected.length === 2) return { ...state, notice: "full" };
  return { ...state, selected: [...state.selected, id], notice: "" };
}
function connect(state) {
  if (state.selected.length !== 2) return state;
  const key = pairKey(state.selected);
  if (state.attempted.includes(key)) return { ...state, selected: [], notice: "repeated" };
  const attempted = [...state.attempted, key];
  const match = Object.keys(CONNECTIONS).find((id) => pairKey(CONNECTIONS[id]) === key);
  if (match)
    return {
      ...state,
      attempted,
      connected: [...state.connected, match],
      selected: [],
      notice: "linked",
    };
  const mistakes = state.mistakes + 1;
  return {
    ...state,
    attempted,
    mistakes,
    selected: [],
    notice: "mismatch",
    outcome: mistakes === 3 ? "unresolved" : null,
  };
}
function arm(state, id) {
  if (!state.connected.includes(id) || state.presented.includes(id)) return state;
  return { ...state, armed: id, view: "dm", board: false, notice: "aim" };
}
function present(state) {
  if (!state.armed || state.view !== "dm" || state.presented.includes(state.armed)) return state;
  const presented = [...state.presented, state.armed];
  return {
    ...state,
    presented,
    armed: null,
    notice: "presented",
    outcome: presented.length === 2 ? "solved" : null,
  };
}
export function choose(state, action) {
  if (state.outcome) return state;
  const handlers = {
    collect: () => collect(state, action.id),
    select: () => select(state, action.id),
    connect: () => connect(state),
    arm: () => arm(state, action.id),
    present: () => present(state),
    board: () => ({ ...state, board: Boolean(action.open), notice: "" }),
    open: () =>
      VIEWS.includes(action.view)
        ? { ...state, view: action.view, board: false, notice: "" }
        : state,
  };
  return Object.hasOwn(handlers, action.type) ? handlers[action.type]() : state;
}
