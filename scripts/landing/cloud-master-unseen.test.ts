import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import { createGame, pause, resume, start, tickFrame } from "../../landing/cloud-master/engine.js";
import {
  availableAtLevel,
  availableScenarios,
  nextQuestion,
  scenarioType,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog(),
  all = availableScenarios(catalog),
  byId = new Map(all.map((s) => [s.id, s]));
function learned(seed = 37, level = 7) {
  const s = createGame(catalog, seed);
  Object.assign(s, {
    taughtLevel: level,
    scenarioTier: level,
    lessonStats: { normal: 1, danger: 1 },
  });
  return s;
}
function operation(s, danger) {
  const r = !danger && s.normalRequest ? s.normalRequest : s;
  return s.family
    ? `${s.family}:${s.title}`
    : `${r.serviceId ?? s.serviceId}:${r.operation ?? s.operation}`;
}
function viableUnseen(s, q, priorTypes, lastId, lastOperation) {
  const blocked = new Set(
    s.history
      .filter((h) => s.elapsed - h.at < 8000)
      .map((h) => `${h.question.scenarioId}:${h.question.danger}`),
  );
  return availableAtLevel(catalog, s.taughtLevel).filter(
    (x) =>
      x.id !== lastId &&
      operation(x, q.danger) !== lastOperation &&
      !blocked.has(`${x.id}:${q.danger}`) &&
      !priorTypes.has(scenarioType(x)),
  );
}
function sample(seed) {
  const s = learned(seed),
    seen = new Set();
  let allTypesAt = 0;
  for (let i = 0; i < 600; i++) {
    const before = new Set(s.seenTypes),
      last = s.lastScenario,
      lastOp = s.lastOperation;
    const q = nextQuestion(s);
    expect(q).toBeTruthy();
    const type = scenarioType(byId.get(q.scenarioId));
    if (viableUnseen(s, q, before, last, lastOp).length) expect(before.has(type)).toBe(false);
    seen.add(type);
    if (!allTypesAt && seen.size === 143) allTypesAt = i + 1;
    s.history.push({ at: s.elapsed, question: q });
    s.elapsed += 1000;
  }
  expect(seen.size).toBe(143);
  expect(allTypesAt).toBeLessThanOrEqual(160);
  expect(s.seenScenarios.size).toBe(260);
  return allTypesAt;
}
test("unseen judgment structures are preferred among fresh varied candidates,then unseen cases,without a fixed order", () => {
  const firstOrders = new Set();
  for (let seed = 0; seed < 12; seed++) {
    sample(seed);
    const s = learned(seed);
    firstOrders.add(Array.from({ length: 12 }, () => nextQuestion(s).scenarioId).join());
  }
  expect(firstOrders.size).toBeGreaterThan(8);
});
test("exhausted seen sets and cooldowns recycle the introduced pool without stopping or losing balance", () => {
  const s = learned();
  s.seenScenarios = new Set(all.map((x) => x.id));
  s.seenTypes = new Set(all.map(scenarioType));
  for (const row of all)
    for (const danger of [false, true])
      s.history.push({ at: 0, question: { scenarioId: row.id, danger } });
  expect(nextQuestion(s)).toBeTruthy();
  s.history = [];
  s.outcomes = [];
  const outcomes = [];
  for (let i = 0; i < 1200; i++) outcomes.push(nextQuestion(s).danger);
  expect(outcomes.filter(Boolean)).toHaveLength(600);
});
test("pause and resume preserve seen learning history while a new game resets it", () => {
  const s = createGame(catalog, 19);
  start(s);
  tickFrame(s, 300);
  const seenTypes = new Set(s.seenTypes),
    seenCases = new Set(s.seenScenarios);
  pause(s);
  resume(s);
  expect(s.seenTypes).toEqual(seenTypes);
  expect(s.seenScenarios).toEqual(seenCases);
  const fresh = createGame(catalog, 19);
  expect(fresh.seenTypes?.size ?? 0).toBe(0);
  start(fresh);
  expect(fresh.active[0].question).toEqual(s.active[0].question);
});
test("every existing type is eligible byLv7 and no future type is drawn atLv1–6", () => {
  expect(LESSONS).toHaveLength(7);
  expect(availableAtLevel(catalog, 7)).toHaveLength(260);
  for (let level = 1; level <= 7; level++) {
    const s = learned(31, level);
    for (let i = 0; i < 600; i++) expect(nextQuestion(s).lessonLevel).toBeLessThanOrEqual(level);
  }
});
