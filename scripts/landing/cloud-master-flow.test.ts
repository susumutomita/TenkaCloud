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
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
test("bounded geometry fits full-height cards and keeps maximum six keyboard targets", () => {
  for (const [height, columns, width, capacity] of [
    [772, 1, 390, 5],
    [595, 1, 375, 4],
    [496, 1, 320, 3],
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
  for (let i = 0; i < 850; i++) {
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
test("Lv1 and Lv8 arrivals stay regular at real viewport capacities without changing fall or stage clocks", () => {
  for (const at of [0, 180000])
    for (const capacity of [3, 4, 5, 6]) {
      const { s, births } = flow(at, capacity),
        gaps = births.slice(1).map((t, i) => t - births[i]);
      expect(births.length).toBeGreaterThan(2);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(arrivalInterval(s) + 16);
      expect(s.active.every((x) => x.deadline - x.born === (at ? 5000 : 12000))).toBe(true);
    }
});
test("pause, first mistake and resume cannot dump arrivals or resurrect a resolved identity", () => {
  const s = createGame(catalog, 28);
  s.maxCards = 5;
  start(s);
  tickFrame(s, 2500);
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
