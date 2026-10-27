import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { ALL_RULES_AT, LESSONS } from "../../landing/cloud-master/curriculum.js";
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
  nextQuestion,
  PRESSURE_STAGES,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function newBirths(s: ReturnType<typeof createGame>, seen: Set<number>) {
  return s.active
    .filter((item) => !seen.has(item.uid))
    .map((item) => {
      seen.add(item.uid);
      return {
        at: item.born,
        id: item.question.scenarioId,
        level: item.question.lessonLevel,
        taught: s.taughtLevel,
        danger: item.question.danger,
        source: item.question.source,
      };
    });
}
function solveVisible(s: ReturnType<typeof createGame>) {
  for (const item of [...s.active])
    if (item.question.danger && s.elapsed - item.born >= 500) collect(s, item.uid);
}
function survive(seed: number, capacity: number) {
  const s = createGame(catalog, seed);
  s.maxCards = capacity;
  start(s);
  const births = [],
    events = [],
    seen = new Set<number>();
  let previousPressure = s.pressureIndex;
  for (let frame = 0; frame < 8000 && s.elapsed < 300000; frame++) {
    births.push(...newBirths(s, seen));
    if (s.lessonNotice && s.lessonNotice.shownAt === null) {
      events.push({ kind: "notice", at: s.elapsed, level: s.lessonNotice.level });
      showLesson(s);
    }
    solveVisible(s);
    const notice = s.lessonNotice;
    tickFrame(s, 50);
    if (notice && !s.lessonNotice)
      events.push({ kind: "end", at: s.elapsed, level: s.taughtLevel });
    if (s.pressureIndex !== previousPressure) {
      events.push({ kind: "pressure", at: s.elapsed, index: s.pressureIndex });
      previousPressure = s.pressureIndex;
    }
    if (s.phase === "feedback") throw Error("perfect play unexpectedly missed a decision");
  }
  return { s, births, events };
}
const paths = [1, 2, 3, 6].flatMap((capacity) =>
  Array.from({ length: 32 }, (_, seed) => ({ capacity, seed, ...survive(seed, capacity) })),
);
test("0–300s actual draws reach early GuardDuty and all pools without leaking untaught cases", () => {
  const seen = new Set();
  for (const { s, births, events } of paths) {
    expect(s.taughtLevel).toBe(LESSONS.length);
    expect(s.lessonNotice).toBe(null);
    expect(s.pressureIndex).toBe(PRESSURE_STAGES.length - 1);
    expect(s.lives).toBe(3);
    expect(s.phase).not.toBe("finished");
    const firstThreat = births.find((b) => b.level === 2);
    expect(firstThreat).toBeDefined();
    expect(firstThreat.at).toBeLessThanOrEqual(26000);
    expect(
      births.filter((b) => b.at < 60000 && b.source.includes("/guardduty/")).length,
    ).toBeGreaterThan(0);
    const allRulesEnd = events.find((e) => e.kind === "end" && e.level === LESSONS.length);
    expect(allRulesEnd.at).toBeLessThanOrEqual(ALL_RULES_AT + 100);
    for (const b of births) {
      expect(b.level).toBeLessThanOrEqual(b.taught);
      seen.add(b.id);
    }
    expect(
      new Set(births.filter((b) => b.at < 30000).map((b) => b.id)).size,
    ).toBeGreaterThanOrEqual(2);
  }
  expect(seen).toEqual(new Set(availableScenarios(catalog).map((s) => s.id)));
  expect(availableAtLevel(catalog, LESSONS.length)).toHaveLength(260);
});
test("actual teaching and pressure events stay separated even when time targets differ from application", () => {
  for (const { events } of paths) {
    const notices = events.filter((e) => e.kind === "notice"),
      ends = events.filter((e) => e.kind === "end"),
      pressure = events.filter((e) => e.kind === "pressure");
    expect(notices.map((e) => e.level)).toEqual(
      Array.from({ length: LESSONS.length - 1 }, (_, i) => i + 2),
    );
    for (const p of pressure) {
      for (const n of notices) {
        const end = ends.find((e) => e.level === n.level);
        expect(p.at <= n.at - 3000 || p.at >= end.at + 3000).toBe(true);
      }
    }
    for (let i = 1; i < pressure.length; i++)
      expect(pressure[i].at - pressure[i - 1].at).toBeGreaterThanOrEqual(6000);
  }
});
test("late pressure catches up one step at a time after real teaching grace", () => {
  const s = createGame(catalog, 3);
  start(s);
  s.active = [];
  s.elapsed = 240000;
  s.nextSpawnAt = Infinity;
  s.lessonNotice = {
    level: 2,
    shownAt: null,
    visible: false,
    readRemaining: 3000,
    graceRemaining: 1000,
  };
  showLesson(s);
  for (let i = 0; i < 80; i++) tickFrame(s, 50);
  expect(s.pressureIndex).toBe(0);
  // Clear admissions to isolate the scheduling contract from misses on unread cards.
  s.active = [];
  s.nextSpawnAt = Infinity;
  s.nextLessonAt = Infinity;
  for (let i = 0; i < 59; i++) tickFrame(s, 50);
  expect(s.pressureIndex).toBe(0);
  tickFrame(s, 50);
  expect(s.pressureIndex).toBe(1);
  for (let i = 0; i < 119; i++) tickFrame(s, 50);
  expect(s.pressureIndex).toBe(1);
  tickFrame(s, 50);
  expect(s.pressureIndex).toBe(2);
});
test("short and wide fields preserve caps while actual late arrivals become denser", () => {
  for (const { s, births, capacity } of paths) {
    expect(s.active.length).toBeLessThanOrEqual(capacity);
    expect(arrivalInterval(s)).toBe(Math.max(280, Math.ceil(4200 / capacity)));
    expect(births.filter((b) => b.at >= 270000).length).toBeGreaterThan(
      births.filter((b) => b.at < 30000).length,
    );
  }
});
test("production protection observes ON/OFF consistently with the actual API boolean", () => {
  const source = availableScenarios(catalog).find(
    (s) => s.id === "EC2ProductionTerminationProtection",
  );
  for (const danger of [false, true]) {
    const stream = createQuestionStream(catalog, 91);
    Object.assign(stream, {
      elapsed: ALL_RULES_AT,
      scenarioTier: LESSONS.length,
      scenarioBag: [source],
      outcomes: [danger],
    });
    const q = nextQuestion(stream);
    expect(q.parameters.DisableApiTermination.Value).toBe(!danger);
    expect(q.context.actual).toBe(danger ? "OFF" : "ON");
  }
});
test("late numeric evidence tightens the comparison without changing its explicit truth rule", () => {
  const source = availableScenarios(catalog).find(
      (s) => s.id === "Behavior:EC2/TrafficVolumeUnusual",
    ),
    averages = [];
  for (const elapsed of [0, 150000, 300000]) {
    let sum = 0;
    for (let seed = 0; seed < 100; seed++) {
      const stream = createQuestionStream(catalog, seed);
      Object.assign(stream, {
        elapsed,
        taughtLevel: LESSONS.length,
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
  expect(difficulty(300000).tier).toBe(3);
});
