import { describe, expect, it } from "vitest";
import { buildCoachPrompt, hasMoreHints, visibleHints } from "../src/drill/coach";
import type { DrillSection, ValueTask } from "../src/drill/types";
import { isValueTask, localize } from "../src/drill/types";
import { SHA256_DRILL } from "../src/sha256/sections";

const section = SHA256_DRILL.sections[0] as DrillSection;
const task = section.tasks[0] as ValueTask;
const choiceSection = SHA256_DRILL.sections[13] as DrillSection;

describe("staged hints", () => {
  it("should reveal nothing before the learner asks", () => {
    expect(visibleHints(task, 0)).toEqual([]);
    expect(hasMoreHints(task, 0)).toBe(true);
  });

  it("should reveal hints in ascending level order", () => {
    const shown = visibleHints(task, 1);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.level).toBe(1);
  });

  it("should report no more hints once all are revealed", () => {
    expect(hasMoreHints(task, task.hints.length)).toBe(false);
    expect(visibleHints(task, task.hints.length + 5)).toHaveLength(task.hints.length);
  });

  it("should sort out-of-order hint declarations by level", () => {
    const shuffled: ValueTask = {
      ...task,
      hints: [
        { level: 3, text: { ja: "3", en: "3" } },
        { level: 1, text: { ja: "1", en: "1" } },
        { level: 2, text: { ja: "2", en: "2" } },
      ],
    };
    expect(visibleHints(shuffled, 2).map((entry) => entry.level)).toEqual([1, 2]);
  });
});

describe("buildCoachPrompt", () => {
  it("should carry the section and task context into the prompt", () => {
    const prompt = buildCoachPrompt({
      drillTitle: localize(SHA256_DRILL.title, "ja"),
      section,
      task,
      locale: "ja",
      mode: "hint",
      attempts: 2,
    });
    expect(prompt).toContain(localize(SHA256_DRILL.title, "ja"));
    expect(prompt).toContain(localize(section.title, "ja"));
    expect(prompt).toContain(localize(task.title, "ja"));
    expect(prompt).toContain("これまでの提出回数: 2");
    expect(prompt).toContain("節 1:");
  });

  it("should never include the expected answer, so the hint stays a hint", () => {
    const prompt = buildCoachPrompt({
      drillTitle: "SHA-256",
      section,
      task,
      locale: "ja",
      mode: "hint",
      attempts: 0,
    });
    for (const drillCase of task.cases) {
      expect(prompt).not.toContain(drillCase.expected);
    }
  });

  it("should never include which choices are correct", () => {
    const quiz = choiceSection.tasks[0];
    const prompt = buildCoachPrompt({
      drillTitle: "SHA-256",
      section: choiceSection,
      task: quiz,
      locale: "ja",
      mode: "hint",
      attempts: 1,
    });
    expect(isValueTask(quiz)).toBe(false);
    expect(prompt).not.toContain("correct");
    if (!isValueTask(quiz)) {
      for (const option of quiz.choices) {
        expect(prompt).toContain(localize(option.label, "ja"));
        expect(prompt).not.toContain(localize(option.rationale, "ja"));
      }
    }
  });

  it("should ask for a single next step in hint mode and for reasons in explain mode", () => {
    const base = {
      drillTitle: "SHA-256",
      section,
      task,
      locale: "ja" as const,
      attempts: 0,
    };
    expect(buildCoachPrompt({ ...base, mode: "hint" })).toContain("答えの値は書かずに");
    expect(buildCoachPrompt({ ...base, mode: "explain" })).toContain("なぜこの処理が");
  });

  it("should build an English prompt for the en locale", () => {
    const prompt = buildCoachPrompt({
      drillTitle: "Understand SHA-256 step by step",
      section,
      task,
      locale: "en",
      mode: "explain",
      attempts: 3,
    });
    expect(prompt).toContain("I am working through the TenkaCloud learning drill");
    expect(prompt).toContain("Attempts so far: 3");
    expect(prompt).toContain("Section 1:");
    expect(prompt).toContain("Task:");
  });
});
