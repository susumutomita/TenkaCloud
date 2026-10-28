import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { CORRECT_PER_LEVEL, LESSONS } from "../../landing/cloud-master/curriculum.js";
import {
  collect,
  createGame,
  showLesson,
  start,
  tickFrame,
} from "../../landing/cloud-master/engine.js";
import coverage from "../../landing/cloud-master/guardduty-coverage.json";
import { cardHeightBudget, fieldCapacity } from "../../landing/cloud-master/layout.js";
import { flowPositions } from "../../landing/cloud-master/motion.js";
import { availableAtLevel, availableScenarios } from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
const guardIds = new Set([
  ...coverage.active.map((x) => x.findingType),
  ...coverage.customSignals.map((x) => x.signalName),
  ...coverage.runtimeCustomSignals.map((x) => x.signalName),
]);
const structuralKey = (s) =>
  JSON.stringify(
    s.family
      ? [s.family, s.focusLabel, s.operator, typeof s.normal, typeof s.flag]
      : [
          s.serviceId,
          s.operation,
          s.field,
          s.normalRequest?.serviceId ?? s.serviceId,
          s.normalRequest?.operation ?? s.operation,
          typeof s.risk,
        ],
  );
const structures = new Map(availableScenarios(catalog).map((s) => [s.id, structuralKey(s)]));

test("existing GuardDuty topics expand early pools without adding rules or removing any of the260 cases", () => {
  expect(CORRECT_PER_LEVEL).toBe(5);
  expect(availableScenarios(catalog)).toHaveLength(260);
  expect(availableScenarios(catalog).filter((s) => guardIds.has(s.id))).toHaveLength(253);
  expect(new Set(structures.values()).size).toBe(143);
  const general = [2, 2, 3, 4, 6, 7, 7];
  const guard = [1, 7, 24, 56, 82, 195, 253];
  expect(LESSONS).toHaveLength(7);
  for (let level = 1; level <= LESSONS.length; level++) {
    const pool = availableAtLevel(catalog, level);
    expect(pool.filter((s) => guardIds.has(s.id))).toHaveLength(guard[level - 1]);
    expect(pool.filter((s) => !guardIds.has(s.id))).toHaveLength(general[level - 1]);
  }
  expect(LESSONS[0].scenarios).toEqual([
    "EC2ApprovedStop",
    "Impact:IAMUser/AnomalousBehavior",
    "EC2ProductionTerminationProtection",
  ]);
  expect(LESSONS[2].scenarios).toContain("CredentialAccess:RDS/AnomalousBehavior.FailedLogin");
  expect(LESSONS[3].scenarios).toContain("Execution:Runtime/NewBinaryExecuted");
  expect(LESSONS[4].scenarios).toContain("CurlWgetExfiltrateData");
  expect(LESSONS[5].cue).toContain("注意指標");
});

// Visibility and correct taps are a deterministic exposure model, not human-play telemetry.
function observe(s, config, ledger) {
  const positions = flowPositions(
    s.active.map((x) => ({ ...x, height: cardHeightBudget(config.width) })),
    ledger.cache,
    s.elapsed,
    config.fieldHeight,
    config.columns,
  );
  for (const p of positions) {
    if (p.y < 0 || p.y + p.height > config.fieldHeight + 1) continue;
    if (!ledger.visibleAt.has(p.uid)) {
      ledger.visibleAt.set(p.uid, s.elapsed);
      ledger.exposures.push({ at: s.elapsed, id: p.question.scenarioId });
    }
    expect(p.question.lessonLevel).toBeLessThanOrEqual(s.taughtLevel);
    ledger.seen.add(p.question.scenarioId);
  }
}
function respond(s, reaction, ledger) {
  for (const item of [...s.active].sort((a, b) => a.born - b.born)) {
    if (!item.question.danger || !ledger.visibleAt.has(item.uid)) continue;
    if (s.elapsed - ledger.visibleAt.get(item.uid) < reaction || s.elapsed - ledger.lastTap < 250)
      continue;
    if (collect(s, item.uid)) ledger.lastTap = s.elapsed;
  }
}
function verifyExposure(seen, minGuard, minStructure) {
  expect([...seen].filter((id) => guardIds.has(id)).length).toBeGreaterThanOrEqual(minGuard);
  expect(new Set([...seen].map((id) => structures.get(id))).size).toBeGreaterThanOrEqual(
    minStructure,
  );
}
function repeatRate(exposures) {
  const settled = exposures.filter((x) => x.at >= 15000 && x.at <= 180000);
  const repeats = settled.filter((x) => {
    const i = exposures.indexOf(x);
    return exposures.slice(Math.max(0, i - 8), i).some((y) => y.id === x.id);
  });
  return repeats.length / settled.length;
}
function simulate(config, reaction, seed) {
  const s = createGame(catalog, seed);
  s.maxCards = fieldCapacity(config.fieldHeight, config.columns, config.width);
  start(s);
  const ledger = {
    cache: new Map(),
    visibleAt: new Map(),
    seen: new Set(),
    exposures: [],
    lastTap: -Infinity,
  };
  let checked3 = false;
  while (s.elapsed < 300000 && s.phase === "playing") {
    if (s.lessonNotice?.shownAt === null) showLesson(s);
    observe(s, config, ledger);
    respond(s, reaction, ledger);
    tickFrame(s, 50);
    if (!checked3 && s.elapsed >= 180000) {
      verifyExposure(ledger.seen, config.guard3, config.structure3);
      checked3 = true;
    }
  }
  expect(checked3).toBe(true);
  expect(s.phase).toBe("playing");
  verifyExposure(ledger.seen, config.guard5, config.structure5);
  return repeatRate(ledger.exposures);
}
test("correct-only0–300s visible-play models reach varied GuardDuty topics and avoid short-cycle repetition without leaking rules", () => {
  const configs = [
    {
      width: 375,
      fieldHeight: 555,
      columns: 1,
      guard3: 20,
      guard5: 50,
      structure3: 24,
      structure5: 48,
    },
    {
      width: 390,
      fieldHeight: 732,
      columns: 1,
      guard3: 30,
      guard5: 75,
      structure3: 30,
      structure5: 62,
    },
    {
      width: 1440,
      fieldHeight: 784,
      columns: 2,
      guard3: 50,
      guard5: 140,
      structure3: 48,
      structure5: 88,
    },
  ];
  for (const config of configs) {
    const repeats = [];
    for (const reaction of [400, 900, 1800])
      for (let seed = 0; seed < 8; seed++) repeats.push(simulate(config, reaction, seed));
    expect(repeats.reduce((a, b) => a + b, 0) / repeats.length).toBeLessThan(0.25);
  }
});
