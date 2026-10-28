import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSON_GRACE_MS, LESSON_NOTICE_MS } from "../../landing/cloud-master/curriculum.js";
import {
  arrivalInterval,
  collect,
  createGame,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { fieldCapacity } from "../../landing/cloud-master/layout.js";
import { difficulty, levelFor, pressureFor } from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const schedule = [
  [1, 10000, 1],
  [2, 9000, 2],
  [3, 8000, 3],
  [4, 7600, 3],
  [5, 7200, 4],
  [6, 6800, 4],
  [8, 6200, 5],
  [10, 5600, 6],
  [12, 5000, 6],
  [15, 4600, 6],
  [18, 4200, 6],
];
test.each(schedule)("level %i has fall %ims and staggered limit %i", (level, fallMs, limit) => {
  expect(difficulty(level)).toMatchObject({ fallMs, limit });
  for (const capacity of [
    fieldCapacity(555, 1, 375),
    fieldCapacity(732, 1, 390),
    fieldCapacity(784, 2, 1440),
  ]) {
    const s = createGame(catalog, 37);
    Object.assign(s, {
      level,
      taughtLevel: level,
      pressureIndex: pressureFor(level),
      correct: (level - 1) * 5,
      maxCards: capacity,
      outcomes: Array(100).fill(false),
    });
    start(s);
    const births = new Map([[s.active[0].uid, s.active[0].born]]);
    while (s.elapsed < fallMs - 1) {
      tickFrame(s, Math.min(50, fallMs - 1 - s.elapsed));
      for (const x of s.active) births.set(x.uid, x.born);
      expect(s.phase).toBe("playing");
    }
    expect(s.active).toHaveLength(Math.min(limit, capacity));
    const times = [...births.values()];
    expect(new Set(times).size).toBe(times.length);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(arrivalInterval(s));
    expect(s.active.every((x) => x.deadline - x.born === fallMs)).toBe(true);
    expect(s.level).toBe(level);
    const elapsed = s.elapsed,
      serial = s.serial;
    pause(s);
    tickFrame(s, 99999);
    expect(s.elapsed).toBe(elapsed);
    expect(s.serial).toBe(serial);
    resume(s);
    tickFrame(s, 5000);
    expect(s.serial - serial).toBeLessThanOrEqual(1);
    expect(new Set(s.history.map((x) => x.uid)).size).toBe(s.history.length);
  }
});
test("five correct decisions keep progression independent of elapsed time", () => {
  expect([0, 4, 5, 9, 10].map(levelFor)).toEqual([1, 1, 2, 2, 3]);
});
test("new cadence waits for reading, retains old deadlines, and never batches arrivals", () => {
  const s = createGame(catalog, 37);
  s.maxCards = 6;
  s.correct = 4;
  s.outcomes = Array(100).fill(false);
  start(s);
  s.active[0].deadline = 500;
  tick(s, 500);
  expect(s.passed).toBe(1);
  expect(s.level).toBe(2);
  tick(s, 100);
  const old = s.active[0],
    deadline = old.deadline;
  const oldNext = s.nextSpawnAt;
  showLesson(s);
  tick(s, LESSON_NOTICE_MS + LESSON_GRACE_MS - 1);
  expect(s.taughtLevel).toBe(1);
  tick(s, 1);
  expect(s.taughtLevel).toBe(2);
  expect(old.deadline).toBe(deadline);
  expect(s.nextSpawnAt).toBeLessThan(oldNext);
  expect(s.nextSpawnAt - s.elapsed).toBe(arrivalInterval(s));
  const serial = s.serial;
  tick(s, arrivalInterval(s) - 1);
  expect(s.serial).toBe(serial);
  tick(s, 1);
  expect(s.serial).toBe(serial + 1);
  expect(s.active).toHaveLength(2);
  const fresh = s.active.at(-1);
  expect(fresh.deadline - fresh.born).toBe(9000);
  expect(old.deadline).toBe(deadline);
  tick(s, deadline - s.elapsed);
  expect(s.passed).toBe(2);
  expect(s.score).toBe(20);
  expect(collect(s, old.uid)).toBe(false);
  expect(s.score).toBe(20);
});
