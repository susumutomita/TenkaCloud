export const ROUND_MS = 30_000;

export function start(variant = Math.random() < 0.5 ? "install" : "browser") {
  return {
    variant: variant === "browser" ? "browser" : "install",
    stage: "dm",
    checked: false,
    companyFound: false,
    panel: null,
    remaining: ROUND_MS,
    outcome: null,
    points: 0,
  };
}

export function finish(state, outcome, points) {
  if (state.outcome) return state;
  return { ...state, outcome, points, decisionStage: state.stage, panel: null, stage: "result" };
}

export function elapse(state, milliseconds) {
  if (state.outcome || state.panel || !Number.isFinite(milliseconds) || milliseconds <= 0)
    return state;
  const remaining = Math.max(0, state.remaining - milliseconds);
  return remaining === 0 ? finish({ ...state, remaining }, "timeout", 0) : { ...state, remaining };
}

function proceed(state) {
  if (state.variant === "install") return finish(state, "unsafe", 0);
  return finish(state, state.checked ? "resolved" : "limited", state.checked ? 100 : 50);
}

function stopRequest(state) {
  if (state.stage === "setup" && state.variant === "install") return finish(state, "resolved", 100);
  return finish(state, "held", 40);
}

function play(state, action) {
  const transitions = {
    discuss: ["dm", "invite"],
    visit: ["invite", "site"],
    begin: ["site", "setup"],
  };
  const transition = transitions[action];
  if (transition && state.stage === transition[0]) return { ...state, stage: transition[1] };
  if (action === "hold") return stopRequest(state);
  if (state.stage !== "setup") return state;
  if (action === "proceed") return proceed(state);
  if (action === "report" && state.variant === "install") return stopRequest(state);
  return state;
}

export function choose(state, action) {
  if (state.outcome) return state;
  switch (action) {
    case "close":
      return { ...state, panel: null };
    case "tools":
      return state.panel ? state : { ...state, panel: "tools" };
    case "company":
      return state.panel === "tools" ? { ...state, companyFound: true, panel: "company" } : state;
    case "verify":
      return state.stage === "setup" && state.panel === "tools"
        ? { ...state, checked: true, panel: "verification" }
        : state;
    default:
      return state.panel ? state : play(state, action);
  }
}
