import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  LESSON_GRACE_MS,
  LESSON_NOTICE_MS,
  LESSONS,
} from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  EMPTY_REFILL_MS,
  next,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import {
  availableAtLevel,
  createQuestionStream,
  levelFor,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function question(danger) {
  const stream = createQuestionStream(catalog, 37);
  stream.outcomes = [danger];
  return nextQuestion(stream);
}
function put(s, danger) {
  const item = {
    uid: s.serial++,
    slot: 0,
    born: s.elapsed - 200,
    deadline: s.elapsed + 1,
    question: question(danger),
  };
  s.active = [item];
  s.nextSpawnAt = Infinity;
  return item;
}
function pass(s) {
  put(s, false);
  tick(s, 2);
}
function ready() {
  const s = createGame(catalog, 71);
  start(s);
  return s;
}
test("only accumulated correct flags and normal passes earn levels, not clock, score or streak", () => {
  const s = ready();
  s.active = [];
  s.nextSpawnAt = Infinity;
  tick(s, 300000);
  expect(s.level).toBe(1);
  expect(s.taughtLevel).toBe(1);
  for (let i = 0; i < 9; i++) pass(s);
  expect(s.level).toBe(1);
  expect(s.passed).toBe(9);
  const missed = put(s, true);
  tick(s, 2);
  expect(s.phase).toBe("feedback");
  expect(s.level).toBe(1);
  expect(s.passed).toBe(9);
  expect(s.history.at(-1).uid).toBe(missed.uid);
  next(s);
  s.grace = 0;
  const item = put(s, true);
  expect(collect(s, item.uid)).toBe(true);
  expect(s.correct + s.passed).toBe(10);
  expect(s.level).toBe(2);
  expect(s.lessonNotice.level).toBe(2);
  expect(collect(s, item.uid)).toBe(false);
  expect(s.correct + s.passed).toBe(10);
  if (s.phase === "hitstop") tick(s, 120);
  for (let i = 0; i < 10; i++) pass(s);
  expect(s.level).toBe(3);
  expect(s.correct + s.passed).toBe(20);
  expect(s.mistakes).toBe(1);
  expect(levelFor(9)).toBe(1);
  expect(levelFor(10)).toBe(2);
  expect(levelFor(19)).toBe(2);
  expect(levelFor(20)).toBe(3);
});
test("a normal pass resolves exactly once and refills promptly, including while a cue awaits paint", () => {
  const s = ready();
  s.maxCards = 2;
  for (let i = 0; i < 10; i++) pass(s);
  const count = s.passed,
    score = s.score;
  expect(s.lessonNotice.shownAt).toBe(null);
  expect(s.active.length).toBe(0);
  expect(s.nextSpawnAt - s.elapsed).toBeLessThanOrEqual(EMPTY_REFILL_MS);
  tickFrame(s, EMPTY_REFILL_MS);
  expect(s.active.length).toBe(1);
  expect(s.active[0].question.lessonLevel).toBe(1);
  expect(s.passed).toBe(count);
  expect(s.score).toBe(score);
  expect(s.taughtLevel).toBe(1);
  const oldDeadline = s.active[0].deadline;
  showLesson(s);
  tick(s, 1000);
  expect(s.active[0].deadline).toBe(oldDeadline);
  pause(s);
  const elapsed = s.elapsed,
    remaining = s.lessonNotice.readRemaining;
  tick(s, 99999);
  expect(s.elapsed).toBe(elapsed);
  expect(s.lessonNotice.readRemaining).toBe(remaining);
  resume(s);
  showLesson(s);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS - 1000);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonNotice).toBe(null);
  expect(s.level).toBe(2);
});
test("an empty intro field can reuse an eligible older case without waiting for all cooldowns", () => {
  const s = ready();
  s.active = [];
  s.history = [];
  for (const scenario of availableAtLevel(catalog, 1))
    for (const danger of [false, true])
      s.history.push({ at: s.elapsed, question: { scenarioId: scenario.id, danger } });
  const q = nextQuestion(s);
  expect(q).toBeTruthy();
  expect(q.lessonLevel).toBe(1);
});
function perfectFrame(s) {
  if (s.lessonNotice?.shownAt === null) showLesson(s);
  for (const item of [...s.active]) {
    expect(item.question.lessonLevel).toBeLessThanOrEqual(Math.min(s.taughtLevel, LESSONS.length));
    if (item.question.danger && s.elapsed - item.born >= 300) collect(s, item.uid);
  }
  tickFrame(s, 50);
  expect(s.phase).not.toBe("feedback");
  expect(s.lives).toBe(3);
  expect(s.level).toBe(levelFor(s.correct + s.passed));
}
const paths = [1, 2, 3, 6].flatMap((capacity) =>
  Array.from({ length: 8 }, (_, seed) => [capacity, seed]),
);
test.each(paths)(
  "five-minute path capacity %i seed %i stays live and resolves each card once",
  (capacity, seed) => {
    const s = createGame(catalog, seed);
    s.maxCards = capacity;
    start(s);
    let emptySince = null,
      maxEmpty = 0;
    const seen = new Set();
    for (let frame = 0; frame < 12000 && s.elapsed < 300000; frame++) {
      perfectFrame(s);
      if (s.active.length) {
        if (emptySince !== null) maxEmpty = Math.max(maxEmpty, s.elapsed - emptySince);
        emptySince = null;
      } else emptySince ??= s.elapsed;
    }
    expect(s.elapsed).toBeGreaterThanOrEqual(300000);
    expect(maxEmpty).toBeLessThanOrEqual(EMPTY_REFILL_MS + 50);
    for (const e of s.history) {
      expect(seen.has(e.uid)).toBe(false);
      seen.add(e.uid);
    }
    expect(s.history.filter((e) => e.correct).length).toBe(s.correct + s.passed);
  },
);
test("the hidden post-notice grace finishes without needing the cue to remain visible", () => {
  const s = ready();
  for (let i = 0; i < 10; i++) pass(s);
  showLesson(s);
  tick(s, LESSON_NOTICE_MS);
  expect(s.lessonNotice.readRemaining).toBe(0);
  s.lessonNotice.visible = false;
  pause(s);
  tick(s, 10000);
  expect(s.taughtLevel).toBe(1);
  resume(s);
  tick(s, LESSON_GRACE_MS);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonNotice).toBe(null);
});

test("fractional RAF notice boundaries cannot retain an unrepresentable clock remainder", () => {
  const s = ready();
  s.elapsed = 12345.678901;
  s.active = [];
  s.nextSpawnAt = Infinity;
  s.level = 2;
  s.lessonNotice = {
    level: 2,
    shownAt: s.elapsed,
    visible: true,
    readRemaining: 1e-13,
    graceRemaining: 0,
  };
  expect(s.elapsed + s.lessonNotice.readRemaining).toBe(s.elapsed);
  tickFrame(s, 16.6666667);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonNotice).toBe(null);
  expect(s.elapsed).toBeGreaterThan(12345.678901);
});

test("a hidden notice also completes a sub-ULP grace remainder", () => {
  const s = ready();
  s.elapsed = 12345.678901;
  s.active = [];
  s.nextSpawnAt = Infinity;
  s.level = 2;
  s.lessonNotice = {
    level: 2,
    shownAt: s.elapsed,
    visible: false,
    readRemaining: 0,
    graceRemaining: 1e-13,
  };
  expect(s.elapsed + s.lessonNotice.graceRemaining).toBe(s.elapsed);
  tickFrame(s, 16.6666667);
  expect(s.taughtLevel).toBe(2);
  expect(s.lessonNotice).toBe(null);
});
