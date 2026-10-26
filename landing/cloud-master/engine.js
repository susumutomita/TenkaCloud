import { createQuestionStream, difficulty, nextQuestion } from "./recognition.js";
export const INPUT_GUARD_MS = 100;
export const HITSTOP_MS = 120;
export function createGame(catalog, seed = 726) {
  return {
    ...createQuestionStream(catalog, seed),
    seed: seed >>> 0,
    phase: "ready",
    previous: null,
    elapsed: 0,
    score: 0,
    lives: 3,
    mistakes: 0,
    combo: 0,
    best: 0,
    history: [],
    active: [],
    serial: 0,
    passed: 0,
    feedback: null,
    end: null,
    grace: 0,
    hitstop: 0,
    nextSpawnAt: 1200,
  };
}
function freeSlot(state) {
  return [0, 1, 2, 3, 4, 5].find((slot) => !state.active.some((item) => item.slot === slot));
}
function spawn(state) {
  const slot = freeSlot(state);
  if (slot === undefined) return;
  const config = difficulty(state.elapsed);
  const question = nextQuestion(state);
  if (!question) return;
  state.active.push({
    uid: state.serial++,
    slot,
    born: state.elapsed,
    deadline: state.elapsed + config.fallMs,
    question,
  });
}
export function start(state) {
  if (state.phase !== "ready") return;
  state.phase = "playing";
  state.nextSpawnAt = state.elapsed + difficulty(state.elapsed).intervalMs;
  spawn(state);
}
function remove(state, item) {
  state.active = state.active.filter((entry) => entry.uid !== item.uid);
}
function record(state, item, kind, correct, points) {
  const entry = {
    uid: item.uid,
    question: item.question,
    kind,
    correct,
    points,
    at: state.elapsed,
    livesAfter: state.lives,
    comboAfter: state.combo,
  };
  state.history.push(entry);
  state.feedback = entry;
  state.score += points;
  return entry;
}
function lose(state, item, kind) {
  state.lives = Math.max(0, state.lives - 1);
  state.mistakes++;
  state.combo = 0;
  const entry = record(state, item, kind, false, 0);
  entry.livesAfter = state.lives;
  if (!state.lives) state.end = { reason: "lives", trigger: kind, entry };
  return entry;
}
export function collect(state, uid) {
  if (state.phase !== "playing") return false;
  const item = state.active.find((entry) => entry.uid === uid);
  if (!item || state.elapsed >= item.deadline || state.elapsed - item.born < INPUT_GUARD_MS)
    return false;
  remove(state, item);
  if (!item.question.danger) {
    lose(state, item, "wrong");
    if (!state.lives) state.phase = "feedback";
    return true;
  }
  state.correct++;
  state.combo++;
  state.best = Math.max(state.best, state.combo);
  record(state, item, "flag", true, item.question.points);
  if (item.question.points === 10) {
    state.hitstop = HITSTOP_MS;
    state.phase = "hitstop";
  }
  return true;
}
export function next(state) {
  if (state.phase !== "feedback") return;
  if (!state.lives) {
    state.phase = "finished";
    return;
  }
  state.phase = "playing";
  state.grace = 800;
}
function expire(state, items) {
  const missed = items.filter((item) => item.question.danger);
  for (const item of items) {
    remove(state, item);
    if (item.question.danger) lose(state, item, "miss");
    else {
      state.passed++;
      record(state, item, "pass", true, 10);
    }
  }
  if (missed.length) {
    state.feedback = state.history.findLast(
      (entry) => entry.kind === "miss" && entry.at === state.elapsed,
    );
    state.feedback.groupCount = missed.length;
    state.phase = "feedback";
    return true;
  }
  return false;
}
function advanceClock(state, milliseconds, deferNew) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  let remaining = milliseconds;
  if (state.phase === "hitstop") {
    const stop = Math.min(remaining, state.hitstop);
    state.hitstop -= stop;
    remaining -= stop;
    if (state.hitstop > 0) return;
    state.phase = "playing";
  }
  if (state.phase !== "playing") return;
  const grace = Math.min(state.grace, remaining);
  state.grace -= grace;
  remaining -= grace;
  advanceWorld(state, state.elapsed + remaining, deferNew);
}
export function tick(state, milliseconds) {
  advanceClock(state, milliseconds, false);
}
export function tickFrame(state, milliseconds) {
  advanceClock(state, milliseconds, true);
}
function admit(state) {
  const config = difficulty(state.elapsed);
  if (state.active.length < Math.min(config.limit, state.maxCards ?? 6)) spawn(state);
  return config.intervalMs;
}
function scheduleBoundary(state, deferNew) {
  if (!deferNew) admit(state);
  state.nextSpawnAt = state.elapsed + difficulty(state.elapsed).intervalMs;
  return deferNew;
}
function advanceWorld(state, target, deferNew) {
  let arrivalDue = false;
  while (state.elapsed < target) {
    const deadline = state.active.length
      ? Math.min(...state.active.map((item) => item.deadline))
      : Infinity;
    state.elapsed = Math.min(target, state.nextSpawnAt, deadline);
    const expired = state.active
      .filter((item) => item.deadline <= state.elapsed)
      .sort((a, b) => a.uid - b.uid);
    if (expired.length && expire(state, expired)) return;
    if (state.elapsed >= state.nextSpawnAt)
      arrivalDue = scheduleBoundary(state, deferNew) || arrivalDue;
  }
  if (arrivalDue && state.phase === "playing") state.nextSpawnAt = state.elapsed + admit(state);
}
export function pause(state) {
  if (!["playing", "feedback", "hitstop"].includes(state.phase)) return;
  state.previous = state.phase;
  state.phase = "paused";
}
export function resume(state) {
  if (state.phase !== "paused") return;
  state.phase = state.previous;
  state.previous = null;
}
export function finish(state) {
  if (!["playing", "feedback", "hitstop", "paused"].includes(state.phase)) return;
  state.end = { reason: "manual", entry: null };
  state.phase = "finished";
}
