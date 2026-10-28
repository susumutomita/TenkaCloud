import { expect, test } from "bun:test";
import { LESSONS } from "../../landing/cloud-master/curriculum.js";
import { lessonNotice, pressureNotice } from "../../landing/cloud-master/notices.js";
import { PRESSURE_STAGES } from "../../landing/cloud-master/recognition.js";

test("every taught group has a concise bilingual level-up notice with its actual rule", () => {
  for (const [index, lesson] of LESSONS.entries()) {
    for (const locale of ["ja", "en"]) {
      const cue = lessonNotice(index + 1, locale);
      expect(cue.title).toContain(String(index + 1));
      expect(cue.title).toContain(locale === "ja" ? "レベルアップ" : "Level up");
      expect(cue.detail).toBe(locale === "ja" ? lesson.cue : lesson.enCue);
      expect(cue.detail.length).toBeGreaterThan(10);
      expect(cue.detail.length).toBeLessThanOrEqual(locale === "ja" ? 40 : 60);
    }
  }
});

test("pressure notices report actual speed, effective capacity and available comparisons", () => {
  for (let i = 1; i < PRESSURE_STAGES.length; i++) {
    const before = PRESSURE_STAGES[i - 1],
      after = PRESSURE_STAGES[i];
    const wide = pressureNotice(i - 1, i, { capacity: 6, numeric: true }, "en");
    expect(wide.detail.includes("Faster")).toBe(after.fallMs < before.fallMs);
    expect(wide.detail.includes("More cards")).toBe(after.limit > before.limit);
    expect(wide.detail.includes("Closer comparisons")).toBe(after.tier > before.tier);
    const narrow = pressureNotice(i - 1, i, { capacity: 1, numeric: false }, "en");
    expect(narrow.detail).toBe(after.fallMs < before.fallMs ? "Faster" : "");
  }
  expect(pressureNotice(0, 1, {}, "ja").detail).toBe("枚数↑");
  expect(pressureNotice(1, 1, {}, "en").detail).toBe("");
});
