/**
 * 教材そのものの不変条件を検査する。
 *
 * 15 節ぶんの本文と期待値は人が書き足していく資産なので、「ja だけ書いて en を忘れた」
 * 「期待値の桁が足りない」「選択式の正解が 1 つも無い」といった欠落は必ず起こる。ここで
 * 全節を走査して落とすことで、教材の破損が学習者へ届く前に止まる。
 */

import { describe, expect, it } from "vitest";
import { gradeTask, normalizeAnswer, type TaskSubmission } from "../src/drill/grade";
import { emptyProgress, isSectionComplete, recordAttempt } from "../src/drill/progress";
import type { Drill, DrillTask, Localized } from "../src/drill/types";
import { isValueTask, listTasks } from "../src/drill/types";
import { SHA256_DRILL, SHA256_SECTIONS } from "../src/sha256/sections";

/** 課題に対する「全問正解」の submission を組む。 */
function correctSubmission(task: DrillTask): TaskSubmission {
  if (isValueTask(task)) {
    return {
      kind: "value",
      answers: Object.fromEntries(task.cases.map((entry) => [entry.id, entry.expected])),
    };
  }
  return {
    kind: "choice",
    selected: task.choices.filter((entry) => entry.correct).map((entry) => entry.id),
  };
}

interface ProseEntry {
  readonly path: string;
  readonly text: Localized;
}

/** 課題 1 つが持つ本文 (課題文 / ヒント / 解答欄の問い / 選択肢と根拠)。 */
function taskProse(base: string, task: DrillTask): readonly ProseEntry[] {
  const path = `${base}.task[${task.id}]`;
  const shared: ProseEntry[] = [
    { path: `${path}.title`, text: task.title },
    { path: `${path}.instruction`, text: task.instruction },
    ...task.hints.map((entry) => ({ path: `${path}.hint[${entry.level}]`, text: entry.text })),
  ];
  if (isValueTask(task)) {
    return [
      ...shared,
      ...task.cases.map((entry) => ({ path: `${path}.case[${entry.id}]`, text: entry.label })),
    ];
  }
  return [
    ...shared,
    ...task.choices.flatMap((option) => [
      { path: `${path}.choice[${option.id}].label`, text: option.label },
      { path: `${path}.choice[${option.id}].rationale`, text: option.rationale },
    ]),
  ];
}

/** ドリル内のあらゆる `Localized` を集める (節本文 / 課題文 / ヒント / 選択肢)。 */
function collectLocalized(drill: Drill): readonly ProseEntry[] {
  return [
    { path: "drill.title", text: drill.title },
    { path: "drill.summary", text: drill.summary },
    ...drill.sections.flatMap((section) => {
      const base = `section[${section.id}]`;
      return [
        { path: `${base}.title`, text: section.title },
        { path: `${base}.goal`, text: section.goal },
        { path: `${base}.nextStep`, text: section.nextStep },
        ...section.reading.map((text, i) => ({ path: `${base}.reading[${i}]`, text })),
        ...section.explanation.map((text, i) => ({ path: `${base}.explanation[${i}]`, text })),
        ...section.tasks.flatMap((task) => taskProse(base, task)),
      ];
    }),
  ];
}

describe("SHA-256 drill content", () => {
  it("should ship the 15 sections the curriculum declares", () => {
    expect(SHA256_DRILL.id).toBe("sha256");
    expect(SHA256_SECTIONS).toHaveLength(15);
    expect(SHA256_DRILL.sections).toBe(SHA256_SECTIONS);
  });

  it("should number the sections 1 to 15 in array order", () => {
    expect(SHA256_SECTIONS.map((section) => section.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("should keep section ids and task ids unique", () => {
    const sectionIds = SHA256_SECTIONS.map((section) => section.id);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    const taskIds = listTasks(SHA256_DRILL).map((task) => task.id);
    expect(new Set(taskIds).size).toBe(taskIds.length);
  });

  it("should keep case and choice ids unique inside each task", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      const ids = isValueTask(task)
        ? task.cases.map((entry) => entry.id)
        : task.choices.map((entry) => entry.id);
      expect(new Set(ids).size, `duplicate ids in ${task.id}`).toBe(ids.length);
    }
  });

  it("should provide both locales for every piece of prose", () => {
    for (const { path, text } of collectLocalized(SHA256_DRILL)) {
      expect(text.ja.trim(), `${path}.ja is empty`).not.toBe("");
      expect(text.en.trim(), `${path}.en is empty`).not.toBe("");
    }
  });

  it("should not leave a Japanese sentence in the English field", () => {
    const japanese = /[぀-ヿ一-龯]/;
    for (const { path, text } of collectLocalized(SHA256_DRILL)) {
      // 一部の en 本文は `天下クラウド` のような日本語の入力例を引用するため、
      // 「en が ja とまったく同じ」だけを未翻訳として落とす。
      expect(text.en === text.ja && japanese.test(text.en), `${path}.en is untranslated`).toBe(
        false,
      );
    }
  });

  it("should give every section reading material, an explanation and a next step", () => {
    for (const section of SHA256_SECTIONS) {
      expect(section.reading.length, `${section.id} has no reading`).toBeGreaterThan(0);
      expect(section.explanation.length, `${section.id} has no explanation`).toBeGreaterThan(0);
      expect(section.tasks.length, `${section.id} has no task`).toBeGreaterThan(0);
    }
  });

  it("should give every task at least one hint", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      expect(task.hints.length, `${task.id} has no hint`).toBeGreaterThan(0);
    }
  });

  it("should number hints from 1 upwards without gaps or repeats", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      const levels = task.hints.map((entry) => entry.level);
      expect(levels, `${task.id} hint levels`).toEqual(
        Array.from({ length: levels.length }, (_, i) => i + 1),
      );
    }
  });

  it("should store every expected answer in already-normalized form", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      if (!isValueTask(task)) continue;
      for (const drillCase of task.cases) {
        const normalized = normalizeAnswer(drillCase.expected, drillCase.format);
        expect(normalized.ok, `${task.id}/${drillCase.id} is malformed`).toBe(true);
        expect(normalized.value, `${task.id}/${drillCase.id} is not canonical`).toBe(
          drillCase.expected,
        );
        expect(drillCase.expected.length, `${task.id}/${drillCase.id} is empty`).toBeGreaterThan(0);
        expect(drillCase.width).toBe(drillCase.expected.length);
      }
    }
  });

  it("should give every choice task both correct and incorrect options", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      if (isValueTask(task)) continue;
      const correct = task.choices.filter((entry) => entry.correct);
      expect(correct.length, `${task.id} has no correct choice`).toBeGreaterThan(0);
      expect(
        task.choices.length - correct.length,
        `${task.id} has no incorrect choice`,
      ).toBeGreaterThan(0);
      if (!task.multi) expect(correct, `${task.id} is single-choice`).toHaveLength(1);
    }
  });

  it("should give every implementation task a starter snippet to run locally", () => {
    const implementations = listTasks(SHA256_DRILL).filter(
      (task) => task.kind === "implementation",
    );
    expect(implementations.length).toBeGreaterThan(0);
    for (const task of implementations) {
      if (!isValueTask(task)) continue;
      expect(task.starter?.trim(), `${task.id} has no starter`).toBeTruthy();
      expect(
        task.cases.length,
        `${task.id} has too few cases to prove an implementation`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("should pass every task when the expected answers are submitted", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      const result = gradeTask(task, correctSubmission(task));
      expect(result.passed, `${task.id} does not accept its own expected answers`).toBe(true);
    }
  });

  it("should fail every value task on an empty submission", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      if (!isValueTask(task)) continue;
      expect(gradeTask(task, { kind: "value", answers: {} }).passed).toBe(false);
    }
  });

  it("should fail every choice task when nothing is selected", () => {
    for (const task of listTasks(SHA256_DRILL)) {
      if (isValueTask(task)) continue;
      expect(gradeTask(task, { kind: "choice", selected: [] }).passed).toBe(false);
    }
  });

  it("should complete every section once its tasks are answered correctly", () => {
    let progress = emptyProgress(SHA256_DRILL.id);
    for (const task of listTasks(SHA256_DRILL)) {
      progress = recordAttempt(progress, task.id, gradeTask(task, correctSubmission(task)).passed);
    }
    for (const section of SHA256_SECTIONS) {
      expect(isSectionComplete(section, progress), `${section.id} stays incomplete`).toBe(true);
    }
  });

  it("should attach a figure to every section that has an intermediate state to show", () => {
    // 節 14 / 15 は概念とクイズだけなので図解を持たない。それ以外は必ず持つ。
    const withoutVisual = SHA256_SECTIONS.filter((section) => section.visual === undefined);
    expect(withoutVisual.map((section) => section.id)).toEqual([
      "what-is-a-hash",
      "password-storage",
    ]);
  });

  it("should cover the boundary and multi-block test vectors in the digest section", () => {
    const digestSection = SHA256_SECTIONS.find((section) => section.id === "final-digest");
    const vectors = digestSection?.tasks.find((task) => task.id === "test-vectors");
    expect(vectors && isValueTask(vectors)).toBe(true);
    if (!vectors || !isValueTask(vectors)) return;
    expect(vectors.cases.map((entry) => entry.id)).toEqual([
      "empty",
      "hello",
      "boundary-55",
      "boundary-56",
      "two-blocks",
      "utf8",
    ]);
    for (const drillCase of vectors.cases) {
      expect(drillCase.expected).toHaveLength(64);
    }
  });
});
