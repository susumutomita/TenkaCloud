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
  expect(LESSONS.slice(2).flatMap((l) => l.scenarios)).not.toContain(
    "Discovery:IAMUser/AnomalousBehavior",
  );
});
function verifyPracticeRelease(level, seed) {
  const s = stream(level, seed, false),
    early = [];
  for (let i = 0; i < 8; i++) {
    const q = nextQuestion(s);
    expect(q).toBeTruthy();
    early.push(q);
    if (q.lessonLevel === level) s.lessonStats[q.danger ? "danger" : "normal"]++;
    s.history.push({ at: s.elapsed, question: q });
    s.elapsed += 1000;
  }
  expect(early.some((q) => q.lessonLevel === level && q.danger)).toBe(true);
  expect(early.some((q) => q.lessonLevel === level && !q.danger)).toBe(true);
  const practiceBag = s.lessonBag.map((x) => x.id);
  for (let i = 0; i < 240; i++) {
    const q = nextQuestion(s);
    expect(q).toBeTruthy();
    expect(q.lessonLevel).toBeLessThanOrEqual(level);
    s.history.push({ at: s.elapsed, question: q });
    s.elapsed += 1000;
  }
  expect(s.lessonBag.map((x) => x.id)).toEqual(practiceBag);
}
test("each introduced group gets both contrasts early, then its dedicated practice bag stops being used", () => {
  for (const level of [2, 3, 4, 5, 6, 7])
    for (let seed = 0; seed < 8; seed++) verifyPracticeRelease(level, seed);
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
test("beginner fall time keeps the existing three-level bands through level 28", () => {
  const bands = [10000, 9000, 8000, 7000, 6000, 5500, 5000, 4700, 4400, 4200];
  for (let level = 1; level <= 28; level++) {
    expect(difficulty(level).fallMs).toBe(
      bands[Math.min(bands.length - 1, Math.floor((level - 1) / 3))],
    );
    expect(difficulty(level).fallMs).toBeGreaterThanOrEqual(4200);
  }
});
