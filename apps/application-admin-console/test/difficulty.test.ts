import { expect, it } from "vitest";
import { _testInternals } from "../src/i18n";

it.each([
  ["en", ["Intro", "Beginner", "Intermediate", "Advanced", "Expert"]],
  ["ja", ["入門", "初級", "中級", "上級", "エキスパート"]],
] as const)("uses the catalog difficulty levels in list and detail in %s", (locale, labels) => {
  const dict = _testInternals.LOCALE_DICTIONARIES[locale];
  for (const namespace of ["problems", "problem_detail"]) {
    expect(
      [1, 2, 3, 4, 5].map((level) =>
        _testInternals.resolveKey(dict, `${namespace}.difficulty_${level}`),
      ),
    ).toEqual(labels);
  }
});
