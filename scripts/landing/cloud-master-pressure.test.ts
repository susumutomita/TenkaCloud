import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSON_GRACE_MS, LESSON_NOTICE_MS } from "../../landing/cloud-master/curriculum.js";
import {
  arrivalInterval,
  collect,
  createGame,
  next,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { fieldCapacity } from "../../landing/cloud-master/layout.js";
import {
  difficulty,
  MIN_FALL_MS,
  MIN_INTERVAL_MS,
  pressureFor,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const sizes = [
  [375, 555, 1, 2],
  [390, 732, 1, 3],
  [1440, 784, 2, 6],
];
function game(level: number, capacity: number) {
  const s = createGame(catalog, 37);
  Object.assign(s, {
    level,
    taughtLevel: level,
    pressureIndex: pressureFor(level),
    correct: (level - 1) * 5,
    maxCards: capacity,
  });
  start(s);
  return s;
}
test("late pressure decreases flight AND effective arrivals until the technical floor", () => {
  for (const [width, height, columns, capacity] of sizes) {
    expect(fieldCapacity(height, columns, width)).toBe(capacity);
    let previousFall = Infinity,
      previousInterval = Infinity;
    for (const level of [28, 29, 31, 50, 100, 105]) {
      const s = game(level, capacity),
        d = difficulty(level),
        interval = arrivalInterval(s);
      expect(d.fallMs).toBeLessThan(previousFall);
      expect(interval).toBeLessThan(previousInterval);
      expect(interval).toBeGreaterThanOrEqual(Math.ceil(d.fallMs / capacity));
      expect(d.limit).toBe(6);
      expect(s.active[0].deadline - s.active[0].born).toBe(d.fallMs);
      previousFall = d.fallMs;
      previousInterval = interval;
    }
  }
  expect(difficulty(28)).toMatchObject({ fallMs: 4200, intervalMs: 280 });
  expect(difficulty(105)).toMatchObject({ fallMs: MIN_FALL_MS, intervalMs: MIN_INTERVAL_MS });
});
test("extreme and invalid levels produce finite bounded timings without allocating stages", () => {
  for (const level of [105, 1000, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity]) {
    const d = difficulty(level);
    expect(d.fallMs).toBe(MIN_FALL_MS);
    expect(d.intervalMs).toBe(MIN_INTERVAL_MS);
    expect(Number.isFinite(d.level)).toBe(true);
    expect(d.level).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(difficulty(level, NaN)).toEqual(d);
  }
  for (const level of [NaN, -Infinity, -100, 0])
    expect(difficulty(level)).toMatchObject({ level: 1, fallMs: 10000, intervalMs: 1600 });
});
test.each([28, 31, 50, 100, 1000000])(
  "level %i staggered actual births, safe passes, pause and no catch-up burst",
  (level) => {
    for (const capacity of [2, 3, 6]) {
      const s = game(level, capacity);
      // QA fixture: all-normal cards fill the field without human reaction assumptions.
      s.active = [];
      s.nextSpawnAt = 0;
      s.outcomes = Array(100).fill(false);
      const d = difficulty(level),
        interval = arrivalInterval(s),
        births = new Map<number, number>();
      for (let frame = 0; frame < 2000 && s.elapsed < d.fallMs * 2; frame++) {
        tickFrame(s, 10);
        for (const item of s.active) births.set(item.uid, item.born);
        expect(s.active.length).toBeLessThanOrEqual(capacity);
        expect(s.phase).toBe("playing");
      }
      expect(s.elapsed).toBeGreaterThanOrEqual(d.fallMs * 2);
      const times = [...births.values()];
      expect(times.length).toBeGreaterThanOrEqual(capacity * 2 - 1);
      for (let i = 1; i < times.length; i++) {
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(interval);
        expect(times[i] - times[i - 1]).toBeLessThanOrEqual(interval + 10);
      }
      expect(s.passed).toBeGreaterThan(0);
      expect(s.score).toBe(s.passed * 10);
      expect(new Set(s.history.map((x) => x.uid)).size).toBe(s.history.length);
      const elapsed = s.elapsed,
        serial = s.serial;
      pause(s);
      tickFrame(s, 300000);
      expect(s.elapsed).toBe(elapsed);
      resume(s);
      tickFrame(s, 300000);
      expect(s.serial - serial).toBeLessThanOrEqual(1);
      expect(s.active.length).toBeLessThanOrEqual(capacity);
      const fresh = createGame(catalog, 37);
      expect(fresh.level).toBe(1);
      expect(fresh.active).toEqual([]);
      expect(arrivalInterval(fresh)).toBe(1600);
    }
  },
);
test("Lv28 to29 waits for the notice, preserves existing deadlines and scores once", () => {
  const s = game(28, 6);
  s.correct = 139;
  const item = s.active[0];
  item.question.danger = true;
  tick(s, 150);
  const oldDeadline = item.deadline;
  expect(collect(s, item.uid)).toBe(true);
  expect(collect(s, item.uid)).toBe(false);
  expect(s.correct).toBe(140);
  expect(s.level).toBe(29);
  expect(s.taughtLevel).toBe(28);
  s.outcomes = Array(100).fill(false);
  tick(s, 100);
  const old = s.active[0],
    deadline = old.deadline;
  expect(deadline - old.born).toBe(4200);
  showLesson(s);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS);
  expect(s.taughtLevel).toBe(29);
  expect(old.deadline).toBe(deadline);
  expect(deadline).toBeGreaterThan(oldDeadline);
  expect(arrivalInterval(s)).toBeLessThan(700);
});
test("minimum flight still resolves misses once, preserves review/resume, and accepts guarded taps", () => {
  const s = game(1000, 2);
  const missed = s.active[0];
  missed.question.danger = true;
  tick(s, 600);
  expect(s.phase).toBe("feedback");
  expect(s.mistakes).toBe(1);
  expect(s.active.some((x) => x.uid === missed.uid)).toBe(false);
  tick(s, 60000);
  expect(s.mistakes).toBe(1);
  next(s);
  tick(s, 900);
  const item = s.active[0];
  item.question.danger = true;
  tick(s, Math.max(0, 100 - (s.elapsed - item.born)));
  const score = s.score;
  expect(collect(s, item.uid)).toBe(true);
  expect(collect(s, item.uid)).toBe(false);
  expect(s.score).toBeGreaterThan(score);
  expect(s.mistakes).toBe(1);
});
