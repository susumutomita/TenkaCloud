import { expect, test } from "vitest";
import { assessableSource, skillDeclarations, skillScoringKind } from "./skill-evidence";

const entry = {
  skillId: "parameter.read",
  label: "取得",
  i18n: { en: { label: "Retrieve" } },
  rule: { source: "flag", result: "ok" },
};
test("accepts only the narrow schema and reconstructs public fields", () => {
  expect(skillDeclarations([entry])).toEqual([entry]);
  for (const extra of [
    { answer: "SECRET" },
    { individualId: "PERSON" },
    { hiddenChecks: ["hidden"] },
  ])
    expect(skillDeclarations([{ ...entry, ...extra }])).toBeUndefined();
  for (const rule of [
    { ...entry.rule, answer: "secret" },
    { source: "coordination", result: "ok" },
    { source: "flag", result: "wrong" },
  ])
    expect(skillDeclarations([{ ...entry, rule }])).toBeUndefined();
  for (const invalid of [
    null,
    [],
    [entry, entry],
    [{ ...entry, skillId: "" }],
    [{ ...entry, label: " " }],
  ])
    expect(skillDeclarations(invalid)).toBeUndefined();
});
test("unsupported kinds never infer evidence", () => {
  for (const kind of ["flag", "verify"]) expect(assessableSource(kind, "flag")).toBe(true);
  for (const kind of ["uptime", "uptime-flat", "uptime-multi"])
    expect(assessableSource(kind, "uptime")).toBe(true);
  for (const kind of ["multi-verify", "multi-flag", "coordination", "unknown"])
    expect(assessableSource(kind, "flag")).toBe(false);
  expect(assessableSource("flag", "uptime")).toBe(false);
});
test("uptime-multi attack scoring keeps a kind no uptime rule can assess", () => {
  expect(skillScoringKind({ kind: "uptime-flat", pointsPerSuccess: 1 })).toBe("uptime-flat");
  expect(skillScoringKind({ kind: "uptime-multi", pointsAllOk: 5 })).toBe("uptime-multi");
  // Attack bonuses and penalties are written as `uptime` rows that are not probe outcomes.
  for (const attack of [
    { attackBlocked: { slot: "web", path: "/blocked", pointsPerBlock: 5 } },
    { attackProbes: [{ slot: "web", path: "/attack", penalty: 10 }] },
  ]) {
    const kind = skillScoringKind({ kind: "uptime-multi", pointsAllOk: 5, ...attack });
    expect(kind).toBe("uptime-multi+attack-scoring");
    expect(assessableSource(kind, "uptime")).toBe(false);
  }
  for (const scoring of [undefined, {}, { kind: 3 }])
    expect(skillScoringKind(scoring)).toBe("unknown");
});

test("rejects malformed nested declarations and bounded labels instead of leaking fields", () => {
  for (const raw of [
    [],
    null,
    { ...entry, label: 42 },
    { ...entry, label: "x".repeat(121) },
    { ...entry, i18n: [] },
    { ...entry, i18n: { en: [] } },
    { ...entry, rule: [] },
    { ...entry, i18n: { en: { label: " " } } },
  ])
    expect(skillDeclarations([raw])).toBeUndefined();
  expect(skillDeclarations(Array.from({ length: 17 }, () => entry))).toBeUndefined();
  const probe = { ...entry, rule: { source: "uptime", result: "ok" } };
  expect(skillDeclarations([probe])?.[0]?.rule.source).toBe("uptime");
});
