import { LESSON_GRACE_MS, LESSON_NOTICE_MS, LESSONS } from "./curriculum.js?v=3638284e92";
import {
  createQuestionStream,
  difficulty,
  levelFor,
  nextQuestion,
  pressureFor,
} from "./recognition.js?v=3638284e92";
import {
  createRenderBudget,
  observeFrame,
  outlierThreshold,
  RENDER_MIN_SAMPLES,
  renderEvidence,
} from "./render-budget.js?v=3638284e92";
export const INPUT_GUARD_MS = 100;
export const HITSTOP_MS = 0;
export const REVIEW_DECISION_MS = 1500;
export const EMPTY_REFILL_MS = 100;
// Exact bulk-clock simulation is bounded; excess time uses the same visible-frame
// path as RAF rather than inventing an arbitrarily large unseen card history.
export const MAX_CATCHUP_EVENTS = 512;
const futureAt = (now, delay) => {
  const at = now + delay;
  return at > now ? at : now + Number.EPSILON * Math.max(1, Math.abs(now));
};
export const inputGuardFor = (item) => item.inputGuardMs ?? INPUT_GUARD_MS;
const deadlineOf = (item) =>
  item.presentationPending || (item.renderTracked && !item.inputPresented)
    ? Infinity
    : (item.decisionDeadline ?? item.deadline);
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
    renderBudget: createRenderBudget(),
    pressureDrain: false,
    grace: 0,
    hitstop: 0,
    nextSpawnAt: 1200,
    level: 1,
    taughtLevel: 1,
    pressureIndex: 0,
    discardedTeachingMs: 0,
    frameLimitedArrivals: 0,
    capacityLimitedArrivals: 0,
    catchupYields: 0,
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
  const deadline = futureAt(state.elapsed, configFor(state).fallMs);
  state.active.push({
    uid: state.serial++,
    slot,
    born: state.elapsed,
    deadline,
    inputGuardMs: Math.min(INPUT_GUARD_MS, (deadline - state.elapsed) / 6),
    flightMs: configFor(state).fallMs,
    renderTracked: state.renderBudget.enabled,
    presentationPending: state.renderBudget.enabled,
    inputPresented: false,
    renderedEligible: false,
    question,
  });
  return true;
}
export function arrivalInterval(state) {
  const config = configFor(state);
  if (state.maxCards === undefined) return config.intervalMs;
  const capacity = Math.max(1, Math.min(config.limit, state.maxCards));
  const spacing = config.fallMs / capacity;
  return Math.max(config.intervalMs, config.level > 105 ? spacing : Math.ceil(spacing));
}
export function start(state) {
  if (state.phase !== "ready") return;
  state.phase = "playing";
  state.nextSpawnAt = state.elapsed + arrivalInterval(state);
  spawn(state);
}
function queueLesson(state) {
  if (state.level <= state.taughtLevel) return;
  // All material is taught by Lv7. Later cues can track the latest earned level
  // without skipping any new rules or restarting an already visible read window.
  const level = state.taughtLevel >= LESSONS.length ? state.level : state.taughtLevel + 1;
  if (state.lessonNotice) {
    state.lessonNotice.level = level;
    return;
  }
  state.lessonNotice = {
    level,
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
  const previousInterval = arrivalInterval(state);
  const previousFall = configFor(state).fallMs;
  state.taughtLevel = notice.level;
  state.pressureIndex = pressureFor(state.taughtLevel);
  // Adopt the new staggered cadence after the cue, without a simultaneous catch-up burst.
  const interval = arrivalInterval(state);
  if (interval < previousInterval)
    state.nextSpawnAt = Math.min(state.nextSpawnAt, state.elapsed + interval);
  const nextFall = configFor(state).fallMs;
  const plannedBirth = Math.max(state.elapsed, state.nextSpawnAt);
  const hasBlockingOldCard = state.active.some((item) => {
    const oldDeadline = item.presentationPending ? state.elapsed + item.flightMs : deadlineOf(item);
    return oldDeadline > plannedBirth + nextFall;
  });
  if (nextFall < previousFall && hasBlockingOldCard) {
    state.pressureDrain = true;
    state.nextSpawnAt = Infinity;
  }
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
  notice.readRemaining = Math.max(0, notice.readRemaining - reading);
  // A sub-nanosecond remainder cannot advance a millisecond clock at this magnitude.
  if (notice.readRemaining < 1e-7) notice.readRemaining = 0;
  if (notice.readRemaining === 0)
    notice.graceRemaining -= Math.min(milliseconds - reading, notice.graceRemaining);
  if (notice.graceRemaining < 1e-7) notice.graceRemaining = 0;
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
  if (
    !item ||
    item.presentationPending ||
    state.elapsed >= deadlineOf(item) ||
    state.elapsed - item.born < inputGuardFor(item)
  )
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
  return true;
}
export function next(state) {
  if (state.phase !== "feedback") return;
  state.renderBudget.outliers = [];
  if (!state.lives) {
    state.phase = "finished";
    return;
  }
  for (const item of state.active)
    if (item.question.danger && deadlineOf(item) <= state.elapsed)
      item.decisionDeadline = state.elapsed + REVIEW_DECISION_MS;
  state.phase = "playing";
  if (
    state.active.some(
      (item) => (item.decisionDeadline ?? item.deadline) > state.elapsed + configFor(state).fallMs,
    )
  ) {
    state.pressureDrain = true;
    state.nextSpawnAt = Infinity;
  }
  state.grace = 800;
  refillEmptyField(state);
}
function refillEmptyField(state) {
  if (!state.active.length) {
    state.pressureDrain = false;
    const delay =
      configFor(state).level > 105
        ? Math.min(EMPTY_REFILL_MS, arrivalInterval(state))
        : EMPTY_REFILL_MS;
    state.nextSpawnAt = Math.min(state.nextSpawnAt, futureAt(state.elapsed, delay));
  }
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
function advanceClock(state, milliseconds, deferNew, allowNew = true) {
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
  advanceWorld(state, state.elapsed + remaining, deferNew, allowNew);
}
export function tick(state, milliseconds) {
  advanceClock(state, milliseconds, false);
}
// UI input advances existing deadlines only. New cards are admitted by RAF.
export function tickInput(state, milliseconds) {
  if (
    !["playing", "hitstop"].includes(state.phase) ||
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0
  )
    return;
  if (state.renderBudget.enabled && milliseconds > outlierThreshold(state.renderBudget)) {
    state.renderBudget.excludedClockMs += milliseconds;
    return;
  }
  advanceClock(state, milliseconds, true, false);
}
export function tickFrame(state, milliseconds) {
  advanceClock(state, milliseconds, true);
}
function admit(state) {
  const config = configFor(state);
  if (state.pressureDrain && state.active.length) return Infinity;
  state.pressureDrain = false;
  if (state.active.length >= Math.min(config.limit, state.maxCards ?? 6)) {
    state.capacityLimitedArrivals = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.capacityLimitedArrivals + 1,
    );
    return arrivalInterval(state);
  }
  return spawn(state) ? arrivalInterval(state) : EMPTY_REFILL_MS;
}
function finishFrameArrival(state, dueAt, allowNew) {
  if (dueAt === null) return;
  if (!allowNew) {
    state.nextSpawnAt = dueAt;
    return;
  }
  if (state.phase !== "playing") return;
  const interval = admit(state);
  if (!Number.isFinite(interval)) {
    state.nextSpawnAt = Infinity;
    return;
  }
  if (configFor(state).level <= 105) {
    state.nextSpawnAt = futureAt(state.elapsed, interval);
  } else {
    // Retain the cadence phase instead of rounding every interval up to a frame.
    // Missed arrivals never become invisible graded cards. Record renderer limits.
    const slots = Math.max(1, Math.floor((state.elapsed - dueAt) / interval) + 1);
    state.frameLimitedArrivals = Math.min(
      Number.MAX_SAFE_INTEGER,
      state.frameLimitedArrivals + slots - 1,
    );
    state.nextSpawnAt = futureAt(state.elapsed, dueAt + slots * interval - state.elapsed);
  }
}
function expireDue(state, dueAt) {
  const expired = state.active
    .filter((item) => deadlineOf(item) <= state.elapsed)
    .sort((a, b) => a.uid - b.uid);
  if (!expired.length || !expire(state, expired)) return false;
  if (dueAt !== null) state.nextSpawnAt = dueAt;
  return true;
}
function scheduleDue(state, target, deferNew, dueAt) {
  if (state.elapsed < state.nextSpawnAt) return dueAt;
  if (!deferNew) {
    state.nextSpawnAt = futureAt(state.elapsed, admit(state));
    return dueAt;
  }
  const pending = dueAt ?? state.nextSpawnAt;
  // One admission opportunity per RAF. Input updates keep it pending instead.
  state.nextSpawnAt = futureAt(target, arrivalInterval(state));
  return pending;
}
function advanceWorld(state, target, deferNew, allowNew = true) {
  let dueAt = null,
    events = 0;
  while (state.elapsed < target) {
    if (!deferNew && events++ >= MAX_CATCHUP_EVENTS) {
      state.catchupYields++;
      advanceWorld(state, target, true, allowNew);
      return;
    }
    const deadline = state.active.length ? Math.min(...state.active.map(deadlineOf)) : Infinity;
    const time = Math.min(
      target,
      Math.max(state.elapsed, state.nextSpawnAt),
      Math.max(state.elapsed, deadline),
      readingBoundary(state),
    );
    spendReading(state, time - state.elapsed);
    state.elapsed = time;
    if (expireDue(state, dueAt)) return;
    finishLessonNotice(state);
    dueAt = scheduleDue(state, target, deferNew, dueAt);
  }
  finishFrameArrival(state, dueAt, allowNew);
}
export function pause(state) {
  if (!["playing", "feedback", "hitstop"].includes(state.phase)) return;
  state.renderBudget.outliers = [];
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

export function enableRenderTracking(state, context = {}) {
  state.renderBudget.enabled = true;
  state.renderBudget.context = { ...context };
}
export function measurementLimit(state, reason, evidence) {
  if (!["playing", "hitstop"].includes(state.phase)) return false;
  state.end = {
    reason: "measurement-limit",
    entry: null,
    measurement: {
      ...renderEvidence(state.renderBudget),
      terminalReason: reason,
      level: state.level,
      pressureLevel: state.taughtLevel,
      score: state.score,
      elapsedMs: state.elapsed,
      fallMs: configFor(state).fallMs,
      arrivalMs: arrivalInterval(state),
      ...evidence,
    },
  };
  state.phase = "finished";
  state.active = [];
  return true;
}
function checkRenderLimit(state, observation) {
  const budget = state.renderBudget,
    summary = renderEvidence(budget);
  const frameMs = observation.sustainedFrameMs ?? summary.frameP90Ms;
  const ready = observation.sustainedFrameMs !== undefined || summary.samples >= RENDER_MIN_SAMPLES;
  if (!ready || frameMs === null || configFor(state).fallMs >= 3 * frameMs) return false;
  return measurementLimit(
    state,
    observation.sustainedFrameMs === undefined
      ? "flight-below-render-budget"
      : "sustained-slow-frames",
    {
      limitingFrameMs: frameMs,
      requiredFlightMs: 3 * frameMs,
      slowFrameEvidence: observation.evidence ?? [],
    },
  );
}
function acknowledgePresented(state, frameMs) {
  for (const item of state.active) {
    if (!item.inputPresented && item.renderedEligible) {
      item.inputPresented = true;
      if (item.deadline <= state.elapsed) {
        item.deadline = futureAt(state.elapsed, frameMs);
        state.renderBudget.presentationExtensions++;
      }
    }
    if (!item.presentationPending || item.flightMs < 3 * frameMs) continue;
    item.presentationPending = false;
    item.born = state.elapsed;
    item.deadline = futureAt(state.elapsed, item.flightMs);
  }
}
export function frameStep(state, milliseconds, visible = true, renderMilliseconds = milliseconds) {
  if (!visible) {
    pause(state);
    return;
  }
  if (!["playing", "hitstop"].includes(state.phase)) return;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    !Number.isFinite(renderMilliseconds) ||
    renderMilliseconds < 0
  )
    return;
  if (!state.renderBudget.enabled) {
    tickFrame(state, milliseconds);
    return;
  }
  const observation = observeFrame(state.renderBudget, renderMilliseconds);
  if (checkRenderLimit(state, observation)) return;
  if (observation.advance <= 0) {
    state.renderBudget.excludedClockMs += Math.max(0, milliseconds);
    return;
  }
  acknowledgePresented(state, observation.advance);
  tickFrame(state, Math.max(0, milliseconds));
  if (milliseconds === 0 && state.nextSpawnAt <= state.elapsed)
    finishFrameArrival(state, state.nextSpawnAt, true);
}
