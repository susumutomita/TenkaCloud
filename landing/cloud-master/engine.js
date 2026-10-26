import { buildDeck, objective } from "./recognition.js";
export const FALL_MS = 15000;
export const INPUT_GUARD_MS = 300;
export function createGame(mode = "foundation", seed = 726, study = false) {
  return {
    mode,
    seed: seed >>> 0,
    study,
    target: objective(mode, seed),
    deck: buildDeck(mode, seed),
    phase: "ready",
    previous: null,
    elapsed: 0,
    score: 0,
    lives: 3,
    mistakes: 0,
    grace: 0,
    combo: 0,
    best: 0,
    correct: 0,
    history: [],
    active: [],
    serial: 0,
    cursor: 0,
    cycle: 0,
    lastId: null,
    opportunityAt: null,
    passed: 0,
    feedback: null,
    end: null,
  };
}
function spawn(state, slot, age = 0, forceMatch = false) {
  if (state.cursor === state.deck.length) {
    state.deck = buildDeck(state.mode, state.seed, ++state.cycle);
    state.cursor = 0;
  }
  if (forceMatch) {
    const index = state.deck.findIndex((q, i) => i >= state.cursor && q.match);
    if (index >= 0)
      [state.deck[state.cursor], state.deck[index]] = [state.deck[index], state.deck[state.cursor]];
  }
  const life = Math.max(10000, FALL_MS - state.correct * 100);
  if (state.deck[state.cursor].id === state.lastId) {
    const different = state.deck.findIndex(
      (q, index) => index > state.cursor && q.id !== state.lastId,
    );
    if (different >= 0)
      [state.deck[state.cursor], state.deck[different]] = [
        state.deck[different],
        state.deck[state.cursor],
      ];
  }
  const question = state.deck[state.cursor++];
  state.lastId = question.id;
  const item = {
    uid: state.serial++,
    slot,
    born: state.elapsed - age,
    deadline: state.elapsed - age + life,
    question,
  };
  state.active.push(item);
  return item;
}
export function start(state) {
  if (state.phase !== "ready") return;
  state.phase = "playing";
  if (state.study) {
    spawn(state, 0, 500);
    return;
  }
  spawn(state, 0, 9000);
  spawn(state, 1, 4500);
  spawn(state, 2, 500);
  scheduleOpportunity(state);
}
function record(state, item, picked) {
  const correct = picked === item.question.match;
  const points = correct ? 100 + Math.min(state.combo, 5) * 20 : 0;
  state.combo = correct ? state.combo + 1 : 0;
  state.best = Math.max(state.best, state.combo);
  state.score += points;
  state.correct += Number(correct);
  const entry = {
    uid: item.uid,
    question: item.question,
    picked,
    correct,
    points,
    at: state.elapsed,
  };
  state.history.push(entry);
  state.feedback = entry;
  return entry;
}
function loseLife(state, entry, kind) {
  state.lives = Math.max(0, state.lives - 1);
  state.mistakes++;
  state.combo = 0;
  entry.kind = kind;
  entry.livesAfter = state.lives;
  if (state.lives === 0) state.end = { reason: "lives", trigger: kind, entry };
}
export function collect(state, uid) {
  if (state.phase !== "playing") return false;
  const item = state.active.find((q) => q.uid === uid);
  if (
    !item ||
    (!state.study && (state.elapsed >= item.deadline || state.elapsed - item.born < INPUT_GUARD_MS))
  )
    return false;
  const entry = record(state, item, true);
  if (state.study) {
    state.phase = "feedback";
    return true;
  }
  state.active = state.active.filter((q) => q.uid !== uid);
  spawn(state, item.slot);
  if (!entry.correct) {
    loseLife(state, entry, "wrong");
    if (state.lives === 0) state.phase = "feedback";
  }
  scheduleOpportunity(state);
  return true;
}
export function passStudy(state) {
  if (!state.study || state.phase !== "playing") return false;
  record(state, state.active[0], false);
  state.phase = "feedback";
  return true;
}
export function next(state) {
  if (state.phase !== "feedback") return;
  if (!state.study) {
    if (state.lives === 0) {
      state.phase = "finished";
      return;
    }
    state.phase = "playing";
    state.grace = 800;
    return;
  }
  state.active = [];
  state.phase = "playing";
  spawn(state, 0, 500);
}
function scheduleOpportunity(state) {
  if (state.active.some((item) => item.question.match)) state.opportunityAt = null;
  else state.opportunityAt ??= state.elapsed + 900;
}
function refreshOpportunity(state) {
  if (state.opportunityAt === null || state.elapsed < state.opportunityAt) return;
  const oldest = [...state.active].sort((a, b) => a.born - b.born || a.uid - b.uid)[0];
  state.active = state.active.filter((item) => item.uid !== oldest.uid);
  state.passed++;
  spawn(state, oldest.slot, 0, true);
  state.opportunityAt = null;
}
export function tick(state, milliseconds) {
  if (
    state.phase !== "playing" ||
    state.study ||
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0
  )
    return;
  const grace = Math.min(state.grace, milliseconds);
  state.grace -= grace;
  const target = state.elapsed + milliseconds - grace;
  while (state.elapsed < target) {
    state.elapsed = Math.min(
      target,
      state.opportunityAt ?? Infinity,
      ...state.active.map((q) => q.deadline),
    );
    const expired = state.active
      .filter((q) => q.deadline <= state.elapsed)
      .sort((a, b) => a.uid - b.uid);
    const missed = expired.filter((q) => q.question.match);
    if (missed.length) {
      for (const item of expired) {
        state.active = state.active.filter((q) => q.uid !== item.uid);
        if (item.question.match) {
          const entry = {
            uid: item.uid,
            question: item.question,
            picked: null,
            correct: false,
            points: 0,
            at: state.elapsed,
          };
          state.history.push(entry);
          state.feedback = entry;
          loseLife(state, entry, "miss");
        } else state.passed++;
        spawn(state, item.slot);
      }
      state.feedback.groupCount = missed.length;
      state.phase = "feedback";
      scheduleOpportunity(state);
      return;
    }
    for (const item of expired) {
      state.active = state.active.filter((q) => q.uid !== item.uid);
      state.passed++;
      spawn(state, item.slot);
    }
    scheduleOpportunity(state);
    refreshOpportunity(state);
  }
}
export function pause(state) {
  if (!["playing", "feedback"].includes(state.phase)) return;
  state.previous = state.phase;
  state.phase = "paused";
}
export function resume(state) {
  if (state.phase !== "paused") return;
  state.phase = state.previous;
  state.previous = null;
}
export function finish(state) {
  if (!["playing", "feedback", "paused"].includes(state.phase)) return;
  state.end = { reason: "manual", entry: null };
  state.phase = "finished";
}
