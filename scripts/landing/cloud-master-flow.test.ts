import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import {
  arrivalInterval,
  collect,
  createGame,
  next,
  pause,
  resume,
  start,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import { decisionFact, REASON_DURATION_MS } from "../../landing/cloud-master/feedback.js";
import { CARD_GAP, cardHeightBudget, fieldCapacity } from "../../landing/cloud-master/layout.js";
import {
  availableScenarios,
  createQuestionStream,
  difficulty,
  levelChanges,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
test("bounded geometry fits full-height cards and keeps maximum six keyboard targets", () => {
  for (const [height, columns, width, capacity] of [
    [772, 1, 390, 4],
    [595, 1, 375, 3],
    [496, 1, 320, 2],
    [824, 2, 1440, 6],
  ]) {
    expect(fieldCapacity(height, columns, width)).toBe(capacity);
    const lane = Math.ceil(capacity / columns);
    expect(lane * cardHeightBudget(width) + (lane - 1) * CARD_GAP).toBeLessThanOrEqual(height - 16);
  }
});
function flow(at: number, capacity: number) {
  const s = createGame(catalog, 28);
  s.elapsed = at;
  s.maxCards = capacity;
  start(s);
  const births = [s.active[0].born],
    seen = new Set([s.active[0].uid]);
  for (let i = 0; i < 1180; i++) {
    tickFrame(s, 16);
    for (const item of [...s.active]) {
      if (!seen.has(item.uid)) {
        seen.add(item.uid);
        births.push(item.born);
      }
      if (item.question.danger && s.elapsed - item.born >= 100) collect(s, item.uid);
    }
    expect(s.phase).not.toBe("feedback");
    expect(s.active.length).toBeLessThanOrEqual(capacity);
  }
  return { s, births };
}
test("Lv1 and Lv8 arrivals stay regular at real viewport capacities with opening reading time and unchanged late-stage pressure", () => {
  for (const at of [0, 180000])
    for (const capacity of [2, 3, 4, 5, 6]) {
      const { s, births } = flow(at, capacity),
        gaps = births.slice(1).map((t, i) => t - births[i]);
      expect(births.length).toBeGreaterThan(2);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(arrivalInterval(s) + 16);
      expect(s.active.every((x) => x.deadline - x.born === (at ? 5000 : 16000))).toBe(true);
    }
});
test("pause, first mistake and resume cannot dump arrivals or resurrect a resolved identity", () => {
  const s = createGame(catalog, 28);
  s.maxCards = 5;
  start(s);
  tickFrame(s, arrivalInterval(s) + 100);
  pause(s);
  const elapsed = s.elapsed,
    serial = s.serial;
  tickFrame(s, 100000);
  expect(s.elapsed).toBe(elapsed);
  expect(s.serial).toBe(serial);
  resume(s);
  const normal = s.active.find((x) => !x.question.danger);
  expect(normal).toBeDefined();
  expect(collect(s, normal.uid)).toBe(true);
  expect(s.lives).toBe(2);
  expect(s.phase).toBe("feedback");
  tickFrame(s, 100000);
  expect(s.elapsed).toBe(elapsed);
  next(s);
  tickFrame(s, 816);
  expect(s.active.some((x) => x.uid === normal.uid)).toBe(false);
  expect(s.serial - serial).toBeLessThanOrEqual(1);
});
test("every dangerous fact retains its value; shortened account and AWS-managed policy ARNs keep exact meaning", () => {
  for (const scenario of availableScenarios(catalog)) {
    const stream = createQuestionStream(catalog, 37);
    Object.assign(stream, {
      elapsed: 120000,
      scenarioTier: 5,
      scenarioBag: [scenario],
      outcomes: [true],
    });
    const q = nextQuestion(stream),
      fact = decisionFact(q),
      raw =
        typeof q.context.actual === "string" ? q.context.actual : JSON.stringify(q.context.actual);
    expect(fact.fullValue).toBe(raw);
    expect(fact.value.length).toBeGreaterThan(0);
    if (fact.label === "AWSアカウント") expect(raw).toBe(`arn:aws:iam::${fact.value}:root`);
    else if (fact.label === "AWS管理ポリシー")
      expect(raw).toBe(`arn:aws:iam::aws:policy/${fact.value}`);
    else expect(fact.value).toBe(raw);
  }
  expect(REASON_DURATION_MS).toBe(2000);
});

test("opening reading time increases while time thresholds and later pressure stay intact", () => {
  for (const [at, level, fallMs] of [
    [0, 1, 16000],
    [20000, 2, 13500],
    [40000, 3, 11000],
    [60000, 4, 9000],
    [90000, 5, 6800],
    [120000, 6, 6000],
    [150000, 7, 5400],
    [180000, 8, 5000],
  ]) {
    expect(difficulty(at).level).toBe(level);
    expect(difficulty(at).fallMs).toBe(fallMs);
    if (at) expect(difficulty(at - 1).level).toBe(level - 1);
  }
  for (const capacity of [3, 4, 6]) {
    const { s, births } = flow(0, capacity);
    const expected = Math.ceil(16000 / capacity);
    expect(arrivalInterval(s)).toBe(expected);
    for (let i = 1; i < births.length; i++)
      expect(births[i] - births[i - 1]).toBeLessThanOrEqual(expected + 16);
    expect(s.elapsed).toBeLessThan(20000);
  }
});

test("clearing the opening field schedules one finite arrival without changing late-game cadence", () => {
  for (const at of [0, 90000]) {
    const s = createGame(catalog, 1);
    s.elapsed = at;
    s.maxCards = 3;
    s.outcomes = [true];
    start(s);
    tickFrame(s, 2000);
    const item = s.active[0],
      due = s.nextSpawnAt;
    expect(item.question.danger).toBe(true);
    expect(collect(s, item.uid)).toBe(true);
    expect(s.active.length).toBe(0);
    const score = s.score;
    expect(collect(s, item.uid)).toBe(false);
    expect(s.score).toBe(score);
    expect(s.nextSpawnAt).toBe(at ? due : s.elapsed + 1200);
    if (!at) {
      if (s.hitstop) tickFrame(s, s.hitstop);
      pause(s);
      const elapsed = s.elapsed;
      tickFrame(s, 10000);
      expect(s.elapsed).toBe(elapsed);
      resume(s);
      if (s.grace) tickFrame(s, s.grace);
      tickFrame(s, 1199);
      expect(s.active.length).toBe(0);
      tickFrame(s, 1);
      expect(s.active.length).toBe(1);
      expect(s.active[0].uid).not.toBe(item.uid);
    }
  }
});

test("level cues describe actual new patterns and speed changes, including the speed floor", () => {
  expect(levelChanges(1, 2)).toEqual({ faster: true, morePatterns: true });
  expect(levelChanges(3, 4)).toEqual({ faster: true, morePatterns: true });
  expect(levelChanges(4, 5)).toEqual({ faster: true, morePatterns: true });
  expect(levelChanges(5, 6)).toEqual({ faster: true, morePatterns: false });
  expect(levelChanges(10, 11)).toEqual({ faster: true, morePatterns: false });
  expect(levelChanges(11, 12)).toEqual({ faster: false, morePatterns: false });
});
