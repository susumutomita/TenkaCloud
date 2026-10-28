import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  arrivalInterval,
  collect,
  createGame,
  showLesson,
  start,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import {
  availableAtLevel,
  availableScenarios,
  createQuestionStream,
  difficulty,
  levelFor,
  nextQuestion,
  pressureFor,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function captureBirths(s, seen, births) {
  for (const x of s.active)
    if (!seen.has(x.uid)) {
      seen.add(x.uid);
      births.push({
        at: x.born,
        id: x.question.scenarioId,
        level: x.question.lessonLevel,
        taught: s.taughtLevel,
        danger: x.question.danger,
        source: x.question.source,
      });
    }
}
function solveVisible(s) {
  for (const x of [...s.active])
    if (x.question.danger && s.elapsed - x.born >= 500) collect(s, x.uid);
}
function survive(seed, capacity) {
  const s = createGame(catalog, seed);
  s.maxCards = capacity;
  start(s);
  const births = [],
    events = [],
    seen = new Set();
  let pressure = s.pressureIndex;
  for (let frame = 0; frame < 8000 && s.elapsed < 300000; frame++) {
    captureBirths(s, seen, births);
    if (s.lessonNotice?.shownAt === null) {
      events.push({ kind: "notice", at: s.elapsed, level: s.lessonNotice.level });
      showLesson(s);
    }
    solveVisible(s);
    const notice = s.lessonNotice;
    tickFrame(s, 50);
    if (notice && s.lessonNotice !== notice)
      events.push({ kind: "end", at: s.elapsed, level: s.taughtLevel });
    if (s.pressureIndex !== pressure) {
      events.push({ kind: "pressure", at: s.elapsed, index: s.pressureIndex });
      pressure = s.pressureIndex;
    }
    if (s.phase === "feedback") throw Error("perfect play unexpectedly missed a decision");
  }
  return { s, births, events };
}
const paths = [1, 2, 3, 6].flatMap((capacity) =>
  Array.from({ length: 32 }, (_, seed) => ({ capacity, seed, ...survive(seed, capacity) })),
);
test("0–300s real draws progress with accepted decisions and never leak untaught cases", () => {
  for (const { s, births, events } of paths) {
    expect(s.level).toBe(levelFor(s.correct + s.passed));
    expect(s.taughtLevel).toBeLessThanOrEqual(s.level);
    expect(s.pressureIndex).toBe(pressureFor(s.taughtLevel));
    expect(s.lives).toBe(3);
    expect(s.phase).not.toBe("finished");
    expect(s.elapsed).toBeGreaterThanOrEqual(300000);
    for (const b of births) expect(b.level).toBeLessThanOrEqual(Math.min(b.taught, LESSONS.length));
    expect(births.some((b) => b.source.includes("/guardduty/"))).toBe(true);
    const notices = events.filter((e) => e.kind === "notice");
    expect(notices.map((e) => e.level)).toEqual(
      Array.from({ length: notices.length }, (_, i) => i + 2),
    );
  }
  expect(availableAtLevel(catalog, LESSONS.length)).toHaveLength(260);
});
test("pressure changes only after its earned lesson cue has completed", () => {
  for (const { events } of paths)
    for (const p of events.filter((e) => e.kind === "pressure")) {
      const end = events.find((e) => e.kind === "end" && pressureFor(e.level) === p.index);
      expect(end).toBeDefined();
      expect(p.at).toBe(end.at);
    }
});
test("clock advancement never catches up unearned pressure", () => {
  const s = createGame(catalog, 3);
  start(s);
  s.active = [];
  s.nextSpawnAt = Infinity;
  tickFrame(s, 300000);
  expect(s.elapsed).toBe(300000);
  expect(s.level).toBe(1);
  expect(s.pressureIndex).toBe(0);
  expect(s.lessonNotice).toBe(null);
});
test("viewport caps and earned pressure preserve finite, readable arrival cadence", () => {
  for (const { s, births, capacity } of paths) {
    expect(s.active.length).toBeLessThanOrEqual(capacity);
    const config = difficulty(s.taughtLevel, s.pressureIndex);
    expect(arrivalInterval(s)).toBe(
      Math.max(config.intervalMs, Math.ceil(config.fallMs / Math.min(capacity, config.limit))),
    );
    expect(births.length).toBeGreaterThan(20);
  }
});
test("production protection observes ON/OFF consistently with the actual API boolean", () => {
  const source = availableScenarios(catalog).find(
    (s) => s.id === "EC2ProductionTerminationProtection",
  );
  for (const danger of [false, true]) {
    const stream = createQuestionStream(catalog, 91);
    Object.assign(stream, {
      taughtLevel: LESSONS.length,
      scenarioTier: LESSONS.length,
      scenarioBag: [source],
      outcomes: [danger],
    });
    const q = nextQuestion(stream);
    expect(q.parameters.DisableApiTermination.Value).toBe(!danger);
    expect(q.context.actual).toBe(danger ? "OFF" : "ON");
  }
});
test("earned numeric tiers tighten comparisons without changing their explicit truth rule", () => {
  const source = availableScenarios(catalog).find(
      (s) => s.id === "Behavior:EC2/TrafficVolumeUnusual",
    ),
    averages = [];
  for (const pressureIndex of [0, 5, 10]) {
    let sum = 0;
    for (let seed = 0; seed < 100; seed++) {
      const stream = createQuestionStream(catalog, seed);
      Object.assign(stream, {
        taughtLevel: LESSONS.length,
        pressureIndex,
        scenarioTier: LESSONS.length,
        scenarioBag: [source],
        outcomes: [true],
      });
      const q = nextQuestion(stream);
      expect(q.danger).toBe(true);
      expect(q.context.actual).toBeGreaterThan(q.context.threshold);
      sum += q.context.actual - q.context.threshold;
    }
    averages.push(sum / 100);
  }
  expect(averages[0]).toBeGreaterThan(averages[1]);
  expect(averages[1]).toBeGreaterThan(averages[2]);
  expect(difficulty(18).tier).toBe(3);
});
