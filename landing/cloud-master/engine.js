import { LESSON_GRACE_MS, LESSON_NOTICE_MS } from "./curriculum.js?v=021d9ea7a9";
import {
  createQuestionStream,
  difficulty,
  levelFor,
  nextQuestion,
  pressureFor,
} from "./recognition.js?v=021d9ea7a9";
export const INPUT_GUARD_MS = 100;
export const HITSTOP_MS = 120;
export const REVIEW_DECISION_MS = 1500;
export const EMPTY_REFILL_MS = 100;
const deadlineOf = (item) => item.decisionDeadline ?? item.deadline;
const configFor = (state) => difficulty(state.taughtLevel, state.pressureIndex);
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
    level: 1,
    taughtLevel: 1,
    pressureIndex: 0,
    discardedTeachingMs: 0,
    lessonStats: { normal: 0, danger: 0 },
    lessonNotice: null,
    practiceTurn: true,
    lessonBag: [],
  };
}
function freeSlot(state) {
  return [0, 1, 2, 3, 4, 5].find((slot) => !state.active.some((item) => item.slot === slot));
}
function spawn(state) {
  const slot = freeSlot(state);
  if (slot === undefined) return false;
  const question = nextQuestion(state);
  if (!question) return false;
  state.active.push({
    uid: state.serial++,
    slot,
    born: state.elapsed,
    deadline: state.elapsed + configFor(state).fallMs,
    question,
  });
  return true;
}
export function arrivalInterval(state) {
  const config = configFor(state);
  if (state.maxCards === undefined) return config.intervalMs;
  const capacity = Math.max(1, Math.min(config.limit, state.maxCards));
  return Math.max(config.intervalMs, Math.ceil(config.fallMs / capacity));
}
export function start(state) {
  if (state.phase !== "ready") return;
  state.phase = "playing";
  state.nextSpawnAt = state.elapsed + arrivalInterval(state);
  spawn(state);
}
function queueLesson(state) {
  if (state.lessonNotice || state.level <= state.taughtLevel) return;
  state.lessonNotice = {
    level: state.taughtLevel + 1,
    shownAt: null,
    visible: false,
    readRemaining: LESSON_NOTICE_MS,
    graceRemaining: LESSON_GRACE_MS,
  };
  // Already introduced questions keep arriving while the new lesson is read.
}
export function showLesson(state) {
  const notice = state.lessonNotice;
  if (!notice || !["playing", "hitstop"].includes(state.phase)) return false;
  if (notice.shownAt === null) notice.shownAt = state.elapsed;
  notice.visible = true;
  return true;
}
function finishLessonNotice(state) {
  const notice = state.lessonNotice;
  if (!notice || notice.shownAt === null || notice.readRemaining > 0 || notice.graceRemaining > 0)
    return;
  state.taughtLevel = notice.level;
  state.pressureIndex = pressureFor(state.taughtLevel);
  state.lessonStats = { normal: 0, danger: 0 };
  state.practiceTurn = true;
  state.lessonBag = [];
  state.scenarioBag = [];
  state.scenarioTier = 0;
  state.lessonNotice = null;
  queueLesson(state);
}
function spendReading(state, milliseconds) {
  const notice = state.lessonNotice;
  if (!notice || notice.shownAt === null) return;
  const reading = notice.visible ? Math.min(milliseconds, notice.readRemaining) : 0;
  notice.readRemaining -= reading;
  if (notice.readRemaining === 0)
    notice.graceRemaining -= Math.min(milliseconds - reading, notice.graceRemaining);
}
function readingBoundary(state) {
  const notice = state.lessonNotice;
  return notice && notice.shownAt !== null && (notice.visible || notice.readRemaining === 0)
    ? state.elapsed + notice.readRemaining + notice.graceRemaining
    : Infinity;
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
  if (correct) {
    state.level = levelFor(state.correct + state.passed);
    if (item.question.lessonLevel === state.taughtLevel)
      state.lessonStats[item.question.danger ? "danger" : "normal"]++;
    queueLesson(state);
  }
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
  if (!item || state.elapsed >= deadlineOf(item) || state.elapsed - item.born < INPUT_GUARD_MS)
    return false;
  remove(state, item);
  if (!item.question.danger) {
    lose(state, item, "wrong");
    state.phase = "feedback";
    return true;
  }
  state.correct++;
  state.combo++;
  state.best = Math.max(state.best, state.combo);
  record(state, item, "flag", true, item.question.points);
  refillEmptyField(state);
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
  for (const item of state.active)
    if (item.question.danger && deadlineOf(item) <= state.elapsed)
      item.decisionDeadline = state.elapsed + REVIEW_DECISION_MS;
  state.phase = "playing";
  state.grace = 800;
  refillEmptyField(state);
}
function refillEmptyField(state) {
  if (!state.active.length)
    state.nextSpawnAt = Math.min(state.nextSpawnAt, state.elapsed + EMPTY_REFILL_MS);
}
function expire(state, items) {
  for (const item of items) {
    remove(state, item);
    if (item.question.danger) {
      lose(state, item, "miss");
      state.phase = "feedback";
      return true;
    }
    state.passed++;
    record(state, item, "pass", true, 10);
    refillEmptyField(state);
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
  if (
    deferNew &&
    state.lessonNotice?.shownAt !== null &&
    state.lessonNotice?.shownAt !== undefined
  ) {
    state.discardedTeachingMs += Math.max(0, remaining - 100);
    remaining = Math.min(remaining, 100);
  }
  advanceWorld(state, state.elapsed + remaining, deferNew);
}
export function tick(state, milliseconds) {
  advanceClock(state, milliseconds, false);
}
export function tickFrame(state, milliseconds) {
  advanceClock(state, milliseconds, true);
}
function admit(state) {
  const config = configFor(state);
  if (state.active.length < Math.min(config.limit, state.maxCards ?? 6) && !spawn(state))
    return EMPTY_REFILL_MS;
  return arrivalInterval(state);
}
function advanceWorld(state, target, deferNew) {
  let arrivalDue = false;
  while (state.elapsed < target) {
    const deadline = state.active.length ? Math.min(...state.active.map(deadlineOf)) : Infinity;
    const time = Math.min(target, state.nextSpawnAt, deadline, readingBoundary(state));
    spendReading(state, time - state.elapsed);
    state.elapsed = time;
    const expired = state.active
      .filter((item) => deadlineOf(item) <= state.elapsed)
      .sort((a, b) => a.uid - b.uid);
    if (expired.length && expire(state, expired)) return;
    finishLessonNotice(state);
    if (state.elapsed >= state.nextSpawnAt) {
      if (!deferNew) state.nextSpawnAt = state.elapsed + admit(state);
      else {
        arrivalDue = true;
        state.nextSpawnAt = state.elapsed + arrivalInterval(state);
      }
    }
  }
  if (arrivalDue && state.phase === "playing") state.nextSpawnAt = state.elapsed + admit(state);
}
export function pause(state) {
  if (!["playing", "feedback", "hitstop"].includes(state.phase)) return;
  state.previous = state.phase;
  state.phase = "paused";
  if (state.lessonNotice) state.lessonNotice.visible = false;
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
