import { expect, test } from "bun:test";
import { loadCatalog } from "../../landing/cloud-master/api-catalog.js";
import { LESSONS, scenarioLevel } from "../../landing/cloud-master/curriculum.js";
import { createGame } from "../../landing/cloud-master/engine.js";
import {
  availableAtLevel,
  difficulty,
  nextQuestion,
} from "../../landing/cloud-master/recognition.js";

const catalog = await loadCatalog();
function stream(level, seed, learned) {
  const s = createGame(catalog, seed);
  Object.assign(s, { level, taughtLevel: level, correct: (level - 1) * 5 });
  if (learned) s.lessonStats = { normal: 1, danger: 1 };
  return s;
}
function sample(level, seed, learned, count = 240) {
  const s = stream(level, seed, learned),
    rows = [];
  for (let i = 0; i < count; i++) {
    const q = nextQuestion(s);
    expect(q).toBeTruthy();
    expect(q.lessonLevel).toBeLessThanOrEqual(level);
    rows.push(q);
    s.history.push({ at: s.elapsed, question: q });
    s.elapsed += 1000;
    if (q.lessonLevel === level) s.lessonStats[q.danger ? "danger" : "normal"]++;
  }
  return { rows, s };
}
test("Lv1 stays three EC2 cases;Lv2 adds existing query-scope contrast without early networking", () => {
  expect(LESSONS[0].scenarios).toEqual([
    "EC2ApprovedStop",
    "Impact:IAMUser/AnomalousBehavior",
    "EC2ProductionTerminationProtection",
  ]);
  expect(availableAtLevel(catalog, 1)).toHaveLength(3);
  expect(availableAtLevel(catalog, 2)).toHaveLength(9);
  expect(scenarioLevel("Discovery:IAMUser/AnomalousBehavior")).toBe(2);
  expect(LESSONS[1].cue).toContain("照会範囲");
  expect(LESSONS[1].enCue).toContain("scope");
  expect(LESSONS[12].scenarios).not.toContain("Discovery:IAMUser/AnomalousBehavior");
});
test("new singleton rule gets both contrasts early,then stops dominating the cumulative pool", () => {
  for (const level of [5])
    for (let seed = 0; seed < 8; seed++) {
      const { rows, s } = sample(level, seed, false);
      const early = rows.slice(0, 8).filter((q) => q.lessonLevel === level);
      expect(early.some((q) => q.danger)).toBe(true);
      expect(early.some((q) => !q.danger)).toBe(true);
      expect(s.lessonStats.normal).toBeGreaterThan(0);
      expect(s.lessonStats.danger).toBeGreaterThan(0);
      expect(rows.filter((q) => q.lessonLevel === level).length / rows.length).toBeLessThan(0.25);
      expect(new Set(rows.map((q) => q.operation)).size).toBeGreaterThanOrEqual(
        level === 3 ? 8 : 9,
      );
    }
});
test("learned pools stay seeded,balanced and prefer varied actual operations including normal alternatives", () => {
  for (const level of [2, 3, 4, 11, 13, 18]) {
    const a = sample(level, 91, true),
      b = sample(level, 91, true);
    expect(a.rows).toEqual(b.rows);
    expect(a.rows.filter((q) => q.danger)).toHaveLength(120);
    let repeats = 0;
    for (let i = 1; i < a.rows.length; i++)
      if (
        a.rows[i].serviceId === a.rows[i - 1].serviceId &&
        a.rows[i].operation === a.rows[i - 1].operation
      )
        repeats++;
    expect(repeats).toBe(0);
  }
});
test("fall time changes only at three-level boundaries and reaches a readable floor", () => {
  const bands = [10000, 9000, 8000, 7000, 6000, 5500, 5000, 4700, 4400, 4200];
  for (let level = 1; level <= 45; level++) {
    expect(difficulty(level).fallMs).toBe(
      bands[Math.min(bands.length - 1, Math.floor((level - 1) / 3))],
    );
    expect(difficulty(level).fallMs).toBeGreaterThanOrEqual(4200);
  }
});
