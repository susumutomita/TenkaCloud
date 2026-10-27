import {
  FIRST_LESSON_MS,
  LESSON_GRACE_MS,
  LESSON_NOTICE_MS,
  LESSON_PRACTICE_MS,
  LESSONS,
} from "./curriculum.js?v=222af1e398";
import {
  createQuestionStream,
  difficulty,
  levelChanges,
  levelFor,
  nextQuestion,
} from "./recognition.js?v=222af1e398";
export const INPUT_GUARD_MS = 100;
export const HITSTOP_MS = 120;
export const REVIEW_DECISION_MS = 1500;
const deadlineOf = (item) => item.decisionDeadline ?? item.deadline;
const configFor = (state) => difficulty(state.elapsed, state.taughtLevel);
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
    taughtLevel: 1,
    lessonStats: { normal: 0, danger: 0 },
    nextLessonAt: FIRST_LESSON_MS,
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
  if (slot === undefined || state.lessonNotice) return;
  const question = nextQuestion(state);
  if (!question) return;
  state.active.push({
    uid: state.serial++,
    slot,
    born: state.elapsed,
    deadline: state.elapsed + configFor(state).fallMs,
    question,
  });
}
export function arrivalInterval(state) {
  const config = configFor(state);
  if (state.maxCards === undefined) return config.intervalMs;
  const capacity = Math.max(1, Math.min(config.limit, state.maxCards));
  return Math.max(config.intervalMs, Math.ceil(config.fallMs / capacity));
}
export function start(state) {
  if (state.phase !== "ready") return;
  state.taughtLevel = levelFor(state.elapsed);
  state.nextLessonAt =
    state.elapsed + (state.taughtLevel === 1 ? FIRST_LESSON_MS : LESSON_PRACTICE_MS);
  state.phase = "playing";
  state.nextSpawnAt = state.elapsed + arrivalInterval(state);
  spawn(state);
}
function readyForLesson(state) {
  return (
    state.taughtLevel > LESSONS.length ||
    (state.lessonStats.normal >= 2 && state.lessonStats.danger >= 2)
  );
}
function lessonBoundary(state) {
  return !state.lessonNotice && readyForLesson(state)
    ? Math.max(state.elapsed, state.nextLessonAt)
    : Infinity;
}
function queueLesson(state) {
  if (state.lessonNotice || !readyForLesson(state) || state.elapsed < state.nextLessonAt) return;
  const level = state.taughtLevel + 1;
  if (!levelChanges(state.taughtLevel, level).faster && level > LESSONS.length) {
    state.taughtLevel = level;
    state.nextLessonAt = state.elapsed + LESSON_PRACTICE_MS;
    return;
  }
  state.lessonNotice = {
    level,
    shownAt: null,
    visible: false,
    readRemaining: level <= LESSONS.length ? LESSON_NOTICE_MS : 2200,
    graceRemaining: level <= LESSONS.length ? LESSON_GRACE_MS : 800,
  };
  state.nextSpawnAt = Infinity;
}
// Called only after the browser has painted the unobscured lesson cue.
export function showLesson(state) {
  const notice = state.lessonNotice;
  if (!notice || !["playing", "hitstop"].includes(state.phase)) return false;
  if (notice.shownAt === null) {
    notice.shownAt = state.elapsed;
    state.taughtLevel = notice.level;
    state.lessonStats = { normal: 0, danger: 0 };
    state.practiceTurn = true;
    state.lessonBag = [];
    state.scenarioBag = [];
    state.scenarioTier = 0;
  }
  notice.visible = true;
  return true;
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
  if (correct && item.question.lessonLevel === state.taughtLevel)
    state.lessonStats[item.question.danger ? "danger" : "normal"]++;
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
  const config = configFor(state);
  if (config.level === 1 && !state.active.length && !state.lessonNotice)
    state.nextSpawnAt = Math.min(state.nextSpawnAt, state.elapsed + config.intervalMs);
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
  }
  return false;
}
function protectForReading(state, milliseconds) {
  const notice = state.lessonNotice;
  if (!notice || notice.shownAt === null) return;
  const reading = notice.visible ? Math.min(milliseconds, notice.readRemaining) : 0;
  notice.readRemaining -= reading;
  const grace =
    notice.readRemaining === 0 ? Math.min(milliseconds - reading, notice.graceRemaining) : 0;
  notice.graceRemaining -= grace;
  // The total extension is bounded by the finite reading + grace budget, never reset on resume.
  for (const item of state.active)
    if (reading + grace > 0) item.decisionDeadline = deadlineOf(item) + reading + grace;
}
function finishLessonNotice(state) {
  const notice = state.lessonNotice;
  if (!notice || notice.shownAt === null || notice.readRemaining > 0 || notice.graceRemaining > 0)
    return;
  state.lessonNotice = null;
  state.nextLessonAt = state.elapsed + LESSON_PRACTICE_MS;
  state.nextSpawnAt = state.elapsed + arrivalInterval(state);
  if (state.phase === "playing") state.nextSpawnAt = state.elapsed + admit(state);
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
  // A long, unseen frame cannot consume a painted teaching cue and admit its new rule.
  if (deferNew && state.lessonNotice?.shownAt !== null && state.lessonNotice?.shownAt !== undefined)
    remaining = Math.min(remaining, 100);
  protectForReading(state, remaining);
  advanceWorld(state, state.elapsed + remaining, deferNew);
  finishLessonNotice(state);
}
export function tick(state, milliseconds) {
  advanceClock(state, milliseconds, false);
}
export function tickFrame(state, milliseconds) {
  advanceClock(state, milliseconds, true);
}
function admit(state) {
  const config = configFor(state);
  if (!state.lessonNotice && state.active.length < Math.min(config.limit, state.maxCards ?? 6))
    spawn(state);
  return arrivalInterval(state);
}
function scheduleBoundary(state, deferNew) {
  if (!deferNew) admit(state);
  state.nextSpawnAt = state.elapsed + arrivalInterval(state);
  return deferNew;
}
function advanceWorld(state, target, deferNew) {
  let arrivalDue = false;
  while (state.elapsed < target) {
    const deadline = state.active.length ? Math.min(...state.active.map(deadlineOf)) : Infinity;
    state.elapsed = Math.min(target, state.nextSpawnAt, deadline, lessonBoundary(state));
    const expired = state.active
      .filter((item) => deadlineOf(item) <= state.elapsed)
      .sort((a, b) => a.uid - b.uid);
    if (expired.length && expire(state, expired)) return;
    queueLesson(state);
    if (state.elapsed >= state.nextSpawnAt)
      arrivalDue = scheduleBoundary(state, deferNew) || arrivalDue;
  }
  if (arrivalDue && state.phase === "playing" && !state.lessonNotice)
    state.nextSpawnAt = state.elapsed + admit(state);
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
