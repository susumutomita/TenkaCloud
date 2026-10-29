import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  arrivalInterval,
  collect,
  createGame,
  inputGuardFor,
  MAX_CATCHUP_EVENTS,
  next,
  pause,
  resume,
  showLesson,
  start,
  tick,
  tickFrame,
  tickInput,
} from "../../landing/cloud-master/engine.js";
import { flowPositions } from "../../landing/cloud-master/motion.js";
import { difficulty, pressureFor } from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function game(level: number, maxCards: number) {
  const s = createGame(catalog, 37);
  Object.assign(s, {
    level,
    taughtLevel: level,
    correct: (level - 1) * 5,
    pressureIndex: pressureFor(level),
    maxCards,
    outcomes: Array(2000).fill(false),
  });
  start(s);
  return s;
}
test("every late level decreases actual unrounded fall/cadence without a fixed floor", () => {
  let last = difficulty(105);
  for (let level = 106; level <= 10001; level++) {
    const d = difficulty(level);
    expect(d.fallMs).toBeLessThan(last.fallMs);
    expect(d.intervalMs).toBeLessThan(last.intervalMs);
    for (const maxCards of [2, 3, 6]) {
      expect(
        arrivalInterval({ taughtLevel: level, pressureIndex: pressureFor(level), maxCards }),
      ).toBeCloseTo(d.fallMs / maxCards, 10);
    }
    last = d;
  }
  for (const level of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Infinity]) {
    const d = difficulty(level);
    expect(Number.isFinite(d.fallMs) && Number.isFinite(d.intervalMs)).toBe(true);
    expect(d.fallMs).toBeGreaterThan(0);
    expect(d.intervalMs).toBeGreaterThan(0);
  }
});
test.each([105, 200, 500, 1000, 10000, Number.MAX_SAFE_INTEGER])(
  "late level %i remains bounded across dropped/slow frames and large elapsed clocks",
  (level) => {
    for (const maxCards of [2, 3, 6])
      for (const elapsed of [0, 1e16]) {
        const s = game(level, maxCards);
        s.active = [];
        s.elapsed = elapsed;
        s.nextSpawnAt = elapsed;
        const before = s.serial;
        tickFrame(s, 5000);
        expect(s.elapsed).toBe(elapsed + 5000);
        expect(s.serial - before).toBe(1);
        expect(s.active).toHaveLength(1);
        expect(s.active[0].born).toBe(s.elapsed);
        expect(s.active[0].deadline).toBeGreaterThan(s.elapsed);
        expect(s.nextSpawnAt).toBeGreaterThan(s.elapsed);
        expect(s.passed).toBe(0);
        expect(s.score).toBe(0); // no invisible catch-up cards scored
        expect(Number.isFinite(s.frameLimitedArrivals)).toBe(true);
        const time = s.elapsed,
          serial = s.serial;
        pause(s);
        tickFrame(s, 5000);
        expect(s.elapsed).toBe(time);
        expect(s.serial).toBe(serial);
        resume(s);
        tickFrame(s, 5000);
        expect(s.passed).toBe(1);
        expect(s.score).toBe(10);
        expect(s.active.length).toBeLessThanOrEqual(maxCards);
      }
  },
);
test("bulk-clock callers also have a finite catch-up event budget", () => {
  const s = game(Number.MAX_SAFE_INTEGER, 6);
  tick(s, 5000);
  expect(s.catchupYields).toBe(1);
  expect(s.serial).toBeLessThanOrEqual(MAX_CATCHUP_EVENTS + 2);
  expect(s.elapsed).toBe(5000);
  expect(s.active.length).toBeLessThanOrEqual(6);
  expect(s.nextSpawnAt).toBeGreaterThan(5000);
});
test.each([200, 500, 1000, 10000])(
  "level %i retains a real guarded decision window and exact normal/miss scoring",
  (level) => {
    const s = game(level, 2),
      item = s.active[0],
      guard = inputGuardFor(item);
    item.question.danger = true;
    expect(guard).toBeLessThan(100);
    expect(guard).toBeLessThan(item.deadline - item.born);
    expect(collect(s, item.uid)).toBe(false);
    tickFrame(s, guard + 0.001);
    const before = s.score;
    expect(collect(s, item.uid)).toBe(true);
    expect(s.score).toBeGreaterThan(before);
    expect(collect(s, item.uid)).toBe(false);
    tickFrame(s, 100); // next card is a normal fixture
    const normal = s.active[0],
      passed = s.passed,
      score = s.score;
    tickFrame(s, normal.deadline - s.elapsed);
    expect(s.passed).toBe(passed + 1);
    expect(s.score).toBe(score + 10);
    expect(collect(s, normal.uid)).toBe(false);
    const danger = s.active[0];
    danger.question.danger = true;
    tickFrame(s, danger.deadline - s.elapsed);
    expect(s.phase).toBe("feedback");
    expect(s.mistakes).toBe(1);
    tickFrame(s, 100000);
    expect(s.mistakes).toBe(1);
    next(s);
    expect(s.phase).toBe("playing");
  },
);
test("late level cues coalesce to current earned level without restarting read/grace or skipping introductory material", () => {
  const s = game(226, 6);
  s.correct = 1236 * 5 + 3;
  s.outcomes = Array(2000).fill(false);
  s.active[0].deadline = 1;
  tick(s, 1);
  expect(s.level).toBe(1237);
  expect(s.lessonNotice.level).toBe(1237);
  showLesson(s);
  tick(s, 500);
  const read = s.lessonNotice.readRemaining;
  const item = s.active[0];
  item.question.danger = true;
  tick(s, Math.max(0, inputGuardFor(item) - (s.elapsed - item.born)) + 0.001);
  collect(s, item.uid);
  expect(s.lessonNotice.readRemaining).toBeLessThanOrEqual(read);
  tick(s, s.lessonNotice.readRemaining + s.lessonNotice.graceRemaining);
  expect(s.taughtLevel).toBe(s.level);
  const intro = game(1, 2);
  intro.correct = 100;
  intro.active[0].deadline = 1;
  tick(intro, 1);
  expect(intro.level).toBe(21);
  expect(intro.lessonNotice.level).toBe(2);
});

test("motion follows a positive sub-millisecond lifetime rather than a hidden 1ms denominator", () => {
  const item = { uid: 1, slot: 0, born: 0, deadline: 0.25, height: 100 };
  expect(flowPositions([item], new Map(), 0.125, 500, 1)[0].y).toBe(200);
  expect(flowPositions([item], new Map(), 0.25, 500, 1)[0].y).toBe(400);
});
test("phase accumulation changes real births rather than just lowering an unused nominal interval", () => {
  for (const level of [200, 500, 1000]) {
    const s = game(level, 6);
    s.active[0].question.danger = true;
    s.outcomes = Array(2000).fill(true);
    const births = new Map([[0, 0]]);
    for (let frame = 0; frame < 600; frame++) {
      tickFrame(s, 1000 / 60);
      for (const item of [...s.active]) {
        births.set(item.uid, item.born);
        if (s.elapsed - item.born >= inputGuardFor(item)) collect(s, item.uid);
      }
      expect(s.lives).toBe(3);
    }
    const times = [...births.values()],
      mean = (times.at(-1) - times[0]) / (times.length - 1);
    expect(Math.abs(mean - arrivalInterval(s))).toBeLessThan(0.2);
    expect(mean).toBeLessThan(Math.ceil(arrivalInterval(s) / (1000 / 60)) * (1000 / 60) - 0.5);
    expect(s.capacityLimitedArrivals).toBe(0);
  }
});

test("multiple UI clock updates between RAF callbacks cannot mint unrendered cards or pass scores", () => {
  const s = game(1000000, 6);
  s.active = [];
  s.nextSpawnAt = 0;
  const serial = s.serial;
  for (let i = 0; i < 100; i++) tickInput(s, 1);
  expect(s.elapsed).toBe(100);
  expect(s.serial).toBe(serial);
  expect(s.passed).toBe(0);
  expect(s.score).toBe(0);
  tickFrame(s, 1);
  expect(s.serial).toBe(serial + 1);
  expect(s.active).toHaveLength(1);
  const born = s.active[0].born;
  tickInput(s, 10);
  expect(s.elapsed).toBeGreaterThan(born);
  expect(s.passed).toBe(1);
  for (let i = 0; i < 100; i++) tickInput(s, 1);
  expect(s.serial).toBe(serial + 1);
  expect(s.passed).toBe(1);
});
test("a dropped-frame miss restores pending arrival instead of deferring it to the distant frame target", () => {
  const s = game(200, 6);
  s.active[0].question.danger = true;
  tickFrame(s, 5000);
  expect(s.phase).toBe("feedback");
  expect(s.nextSpawnAt).toBeLessThanOrEqual(s.elapsed);
  next(s);
  const elapsed = s.elapsed;
  tickFrame(s, 801);
  expect(s.elapsed).toBeGreaterThanOrEqual(elapsed);
  expect(s.active).toHaveLength(1);
  expect(s.active[0].born).toBeLessThan(5000);
});
