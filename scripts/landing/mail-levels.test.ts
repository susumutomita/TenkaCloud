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

function assertShareScore(run, mistakes) {
  expect(totals(run).mistakes).toBe(mistakes);
  for (const lang of ["ja", "en"]) {
    const text = buildMailShare(run, totals(run), lang).text;
    expect(text).toContain(`${lang === "ja" ? "ミス" : "Mistakes:"} ${mistakes}`);
    expect(text).toContain(`${lang === "ja" ? "得点" : "Score:"} ${totals(run).score}`);
  }
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
  test("one game traverses five lessons and timeouts never end the game early", () => {
    let run = createRun(() => 0);
    const visited = [];
    while (run.phase !== "results") {
      visited.push(currentLevel(run));
      const snapshot = expire(run);
      expect(snapshot.phase).toBe("round-complete");
      expect(expire(snapshot)).toBe(snapshot);
      expect(tap(snapshot, risks(snapshot)[0].id)).toBe(snapshot);
      run = next(snapshot);
    }
    expect(visited).toEqual([1, 2, 3, 4, 5]);
    expect(totals(run)).toMatchObject({ score: 0, maxScore: 100, timeouts: 5, target: 11 });
    expect(next(run)).toBe(run);
  });
  test.each([1, 2, 3, 4, 5])("terminal Lv%i shares only visited targets", (level) => {
    const run = createRun(() => 0, level),
      target = risks(run).length;
    const phaseRun = end(run);
    expect(totals(phaseRun).target).toBe(target);
    expect(next(phaseRun)).toBe(phaseRun);
    for (const lang of ["ja", "en"])
      expect(buildMailShare(phaseRun, totals(phaseRun), lang).text).toContain(`/${target}`);
    expect(buildMailShare(expire(run), totals(run), "ja")).toBeNull();
    const reviewed = next(reveal(run));
    expect(totals(reviewed).found).toBe(0);
  });
  test.each([1, 2, 3, 4, 5])(
    "Lv%i brute force cannot equal a clean run, and retry resets mistakes",
    (level) => {
      let clean = createRun(() => 0, level),
        brute = createRun(() => 0, level);
      const item = currentCase(brute);
      const normal = [
        ...item.mailRows.filter((row) => row.kind !== "risk").map((row) => row.id),
        "greeting",
        "opening",
        "signature",
        "display-name",
        "to",
      ];
      for (const id of normal) {
        brute = tap(brute, id);
        const snapshot = totals(brute);
        for (let n = 0; n < 100; n++) brute = tap(brute, id);
        expect(totals(brute)).toEqual(snapshot);
      }
      assertShareScore(end(expire(brute)), normal.length);
      for (const row of risks(clean)) {
        clean = tap(clean, row.id);
        brute = tap(brute, row.id);
        const snapshot = totals(brute);
        brute = tap(brute, row.id);
        expect(totals(brute)).toEqual(snapshot);
      }
      expect(totals(clean).score).toBe(20);
      expect(totals(clean).mistakes).toBe(0);
      expect(totals(brute).mistakes).toBe(normal.length);
      expect(totals(brute).score).toBeLessThan(totals(clean).score);
      assertShareScore(end(brute), normal.length);
      expect(totals(createRun(() => 0, level)).mistakes).toBe(0);
    },
  );
  test("twenty-point round scoring floors fractions, deducts five once, and freezes after completion", () => {
    let run = createRun(() => 0, 5);
    const answers = risks(run).map((row) => row.id);
    run = tap(run, answers[0]);
    expect(totals(run).score).toBe(6);
    run = tap(run, "greeting");
    expect(totals(run).score).toBe(1);
    expect(totals(tap(run, "greeting"))).toEqual(totals(run));
    run = tap(run, answers[1]);
    expect(totals(run).score).toBe(8);
    run = tap(run, answers[2]);
    expect(totals(run).score).toBe(15);
    expect(tap(run, "subject")).toBe(run);
    expect(totals(next(run))).toMatchObject({ score: 15, maxScore: 20, mistakes: 1 });
  });
  test("mixed email languages are fixed per run and independent of later UI locale changes", () => {
    for (const locale of ["ja", "en"]) {
      const run = createRun(() => 0, 1, {}, locale);
      expect(run.emailLanguages).toEqual(
        locale === "ja" ? ["ja", "en", "ja", "en", "ja"] : ["en", "ja", "en", "ja", "en"],
      );
      const languages = [...run.emailLanguages];
      const changed = next(expire(tap(run, "greeting")));
      expect(changed.emailLanguages).toEqual(languages);
      expect(totals(changed)).toMatchObject({ mistakes: 1, score: 0, timeouts: 1, maxScore: 100 });
    }
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
