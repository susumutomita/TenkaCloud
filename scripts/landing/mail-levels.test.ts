import { describe, expect, test } from "bun:test";
import { CASES } from "../../landing/mail-detective/cases.js";
import { idnDifference } from "../../landing/mail-detective/idn-explanation.js";
import {
  chooseVariant,
  LEVELS,
  levelCase,
  VARIANT_COUNT,
} from "../../landing/mail-detective/levels.js";
import {
  createRun,
  currentCase,
  currentLevel,
  end,
  expire,
  next,
  nextStartLevel,
  reveal,
  risks,
  tap,
  totals,
} from "../../landing/mail-detective/model.js";
import { buildMailShare } from "../../landing/mail-detective/next-step.js";

function checkBilingualRow(row) {
  for (const lang of ["ja", "en"]) {
    expect(row.before[lang]).not.toBeEmpty();
    expect(row.after[lang]).not.toBeEmpty();
    if (row.kind === "same") expect(row.after[lang]).toBe(row.before[lang]);
    if (row.kind === "risk") {
      expect(row.after[lang]).not.toBe(row.before[lang]);
      expect(row.detail[lang]).not.toBeEmpty();
    }
  }
}

function completeLesson(run) {
  const initial = totals(run);
  expect(initial.target).toBeGreaterThan(0);
  for (const row of currentCase(run).mailRows.filter((candidate) => candidate.kind !== "risk")) {
    run = tap(run, row.id);
    expect(totals(run).found).toBe(initial.found);
  }
  for (const row of risks(run)) {
    run = tap(run, row.id);
    const found = totals(run).found;
    run = tap(run, row.id);
    expect(totals(run).found).toBe(found);
  }
  return next(run);
}

const original = JSON.stringify(CASES);
describe("five comparison lessons", () => {
  test.each(
    LEVELS.flatMap((definition) =>
      Array.from({ length: VARIANT_COUNT }, (_, variant) => [definition, variant]),
    ),
  )("lesson %j variant %i exposes only taught hazards", (definition, variant) => {
    const item = levelCase(definition.level, variant);
    expect(item.mailRows).toHaveLength(7);
    expect(item.rows.filter((row) => row.kind === "risk").map((row) => row.id)).toEqual(
      definition.targets,
    );
    for (const row of item.mailRows) checkBilingualRow(row);
    const source = CASES.find((candidate) => candidate.id === item.id);
    for (const row of source.mailRows.filter(
      (candidate) => candidate.kind === "risk" && !definition.targets.includes(candidate.id),
    )) {
      const projected = item.mailRows.find((candidate) => candidate.id === row.id);
      expect(projected.kind).toBe("same");
      expect(projected.after).toEqual(projected.before);
    }
    const visible = JSON.stringify([
      item.context,
      item.mailRows.map((row) => [row.before, row.after]),
    ]);
    if (definition.level < 5) expect(visible).not.toMatch(/[\u0400-\u04FF]/u);
    if (definition.level === 1) {
      expect(visible).not.toMatch(/MFA|DKIM|DMARC|SPF|\.exe|実行形式/);
      expect(item.rows.filter((row) => row.kind === "risk")).toHaveLength(1);
    }
    expect(item.rows.some((row) => row.kind === "benign")).toBe(true);
    expect(JSON.stringify(CASES)).toBe(original);
  });
  test("normal sender, URL and expected attachment differences do not universally imply danger", () => {
    expect(levelCase(3).mailRows.find((row) => row.id === "from").kind).toBe("benign");
    expect(levelCase(4).mailRows.find((row) => row.id === "link").kind).toBe("benign");
    for (let variant = 0; variant < 3; variant++) {
      const attachment = levelCase(2, variant).mailRows.find((row) => row.id === "attachment");
      expect(attachment.before).toEqual(attachment.after);
      expect(attachment.kind).toBe("same");
      expect(attachment.after.en).toEndWith(".pdf");
      expect(levelCase(2, variant).context.en).toContain("PDF");
    }
  });
  test("each attachment/tool explanation teaches the requested behavior and a safe next step", () => {
    for (const level of [1, 3, 4])
      for (let variant = 0; variant < 3; variant++) {
        const row = levelCase(level, variant).mailRows.find(
          (candidate) => candidate.id === "attachment",
        );
        expect(row.detail.ja).toContain("手口");
        expect(row.detail.ja).toContain("既知の別経路");
        expect(row.detail.ja).toContain("報告");
        expect(row.detail.en).toContain("Method:");
        expect(row.detail.en).toContain("report");
        if (level > 1) {
          expect(row.after.en).toContain("Run");
          expect(row.detail.en).toContain("do not download or run");
        }
      }
  });
  test.each(LEVELS)(
    "lesson %j has reproducible variants without an immediate repeat",
    (definition) => {
      const texts = new Set(
        [0, 1, 2].map((variant) => JSON.stringify(levelCase(definition.level, variant).mailRows)),
      );
      expect(texts.size).toBe(3);
      for (const previous of [0, 1, 2])
        for (const value of [0, 0.49, 0.999999])
          expect(chooseVariant(() => value, previous)).not.toBe(previous);
      const a = createRun(() => 0.4, definition.level),
        b = createRun(() => 0.4, definition.level);
      expect(a.variants).toEqual(b.variants);
      const replay = createRun(() => 0.4, definition.level, a.variants);
      for (const key of Object.keys(a.variants))
        expect(replay.variants[key]).not.toBe(a.variants[key]);
      for (const invalid of [NaN, Infinity, -1, 1])
        expect(() => chooseVariant(() => invalid, 0)).toThrow();
      for (const invalid of [0, 6, -1, 1.5, Infinity])
        expect(() => createRun(() => 0.1, invalid)).toThrow();
    },
  );
  test("short sessions reach all five lessons, with only visited targets in results and no later-level jump on timeout", () => {
    const visited = [],
      targets = [];
    for (const start of [1, 3, 5]) {
      let run = createRun(() => 0, start);
      expect(run.rounds.length).toBeLessThanOrEqual(2);
      expect(nextStartLevel(run)).toBeNull();
      while (run.phase !== "results") {
        visited.push(currentLevel(run));
        targets.push(risks(run).length);
        run = completeLesson(run);
      }
      expect(nextStartLevel(run)).toBe(start === 5 ? null : start + 2);
      expect(totals(run).found).toBe(totals(run).target);
    }
    expect(visited).toEqual([1, 2, 3, 4, 5]);
    expect(targets).toEqual([1, 2, 2, 3, 3]);
  });
  test.each([1, 2, 3, 4, 5])("terminal Lv%i shares only visited targets", (level) => {
    const run = createRun(() => 0, level),
      target = risks(run).length;
    for (const phaseRun of [end(run), expire(run)]) {
      expect(totals(phaseRun).target).toBe(target);
      expect(nextStartLevel(phaseRun)).toBeNull();
      for (const lang of ["ja", "en"])
        expect(buildMailShare(phaseRun, totals(phaseRun), lang).text).toContain(`/${target}`);
    }
    const reviewed = next(reveal(run));
    expect(totals(reviewed).found).toBe(0);
  });
  test("IDN comparison inspects actual characters, positions and Punycode in all variants", () => {
    const expected = ["xn--minmo-6ve.example", "xn--ngisa-4ve.example", "xn--hrumi-4ve.example"];
    for (let variant = 0; variant < 3; variant++) {
      const data = idnDifference(levelCase(5, variant));
      expect(data.differences).toHaveLength(1);
      const changed = data.differences[0];
      expect(changed.position).toBe(variant === 0 ? 4 : 2);
      expect(changed.before).toEqual({ value: "a", name: "LATIN SMALL LETTER A", code: "U+0061" });
      expect(changed.after).toEqual({
        value: "а",
        name: "CYRILLIC SMALL LETTER A",
        code: "U+0430",
      });
      expect(data.asciiAfter).toBe(expected[variant]);
      expect(data.asciiBefore).toBe(data.before);
    }
  });
});
