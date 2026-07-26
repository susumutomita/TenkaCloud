import { describe, expect, it } from "vitest";
import { answerCase, choice, hint, loc } from "../src/drill/authoring";
import {
  gradeCase,
  gradeChoiceTask,
  gradeTask,
  gradeValueTask,
  normalizeAnswer,
} from "../src/drill/grade";
import type { ChoiceTask, ValueTask } from "../src/drill/types";

const hexTask: ValueTask = {
  id: "hex-task",
  kind: "value",
  title: loc("題", "Title"),
  instruction: loc("説明", "Instruction"),
  hints: [hint(1, "ヒント", "Hint")],
  cases: [
    answerCase({ id: "one", ja: "1", en: "1", expected: "61626380", format: "hex" }),
    answerCase({ id: "two", ja: "2", en: "2", expected: "00000018", format: "hex" }),
  ],
};

const choiceTask: ChoiceTask = {
  id: "choice-task",
  kind: "choice",
  multi: true,
  title: loc("題", "Title"),
  instruction: loc("説明", "Instruction"),
  hints: [],
  choices: [
    choice({ id: "a", ja: "A", en: "A", correct: true, rationaleJa: "根拠", rationaleEn: "Why" }),
    choice({ id: "b", ja: "B", en: "B", correct: true, rationaleJa: "根拠", rationaleEn: "Why" }),
    choice({ id: "c", ja: "C", en: "C", correct: false, rationaleJa: "根拠", rationaleEn: "Why" }),
  ],
};

describe("normalizeAnswer", () => {
  it("should accept a 0x prefix, separators and upper case for hex", () => {
    expect(normalizeAnswer("0x61 62_63:80", "hex")).toEqual({ ok: true, value: "61626380" });
    expect(normalizeAnswer("  61626380  ", "hex")).toEqual({ ok: true, value: "61626380" });
    expect(normalizeAnswer("BA7816BF", "hex")).toEqual({ ok: true, value: "ba7816bf" });
  });

  it("should keep leading zeros for hex and binary so digit width still matters", () => {
    expect(normalizeAnswer("00000018", "hex").value).toBe("00000018");
    expect(normalizeAnswer("00001000", "binary").value).toBe("00001000");
  });

  it("should accept a 0b prefix for binary", () => {
    expect(normalizeAnswer("0b0110 0001", "binary")).toEqual({ ok: true, value: "01100001" });
  });

  it("should strip leading zeros for decimal, where they carry no information", () => {
    expect(normalizeAnswer("007", "decimal").value).toBe("7");
    expect(normalizeAnswer("0", "decimal").value).toBe("0");
    expect(normalizeAnswer("000", "decimal").value).toBe("0");
    expect(normalizeAnswer("1_024", "decimal").value).toBe("1024");
  });

  it("should reject characters that do not belong to the format", () => {
    expect(normalizeAnswer("61g2", "hex").ok).toBe(false);
    expect(normalizeAnswer("0121", "binary").ok).toBe(false);
    expect(normalizeAnswer("12a", "decimal").ok).toBe(false);
  });

  it("should treat a hex answer that is only separators as empty rather than malformed", () => {
    expect(normalizeAnswer("   ", "hex")).toEqual({ ok: true, value: "" });
    expect(normalizeAnswer("0x", "hex")).toEqual({ ok: true, value: "" });
  });

  it("should only trim for free text", () => {
    expect(normalizeAnswer("  Big Endian  ", "text")).toEqual({ ok: true, value: "Big Endian" });
  });
});

describe("gradeCase", () => {
  const target = hexTask.cases[0];

  it("should report an absent or blank answer as empty", () => {
    expect(gradeCase(target, undefined).verdict).toBe("empty");
    expect(gradeCase(target, "   ").verdict).toBe("empty");
  });

  it("should distinguish a malformed answer from a wrong one", () => {
    expect(gradeCase(target, "61z26380").verdict).toBe("malformed");
    expect(gradeCase(target, "00000000").verdict).toBe("incorrect");
  });

  it("should accept the expected value with tolerated notation", () => {
    const result = gradeCase(target, "0x61_62_63_80");
    expect(result.verdict).toBe("correct");
    expect(result.normalized).toBe("61626380");
    expect(result.expected).toBe("61626380");
  });
});

describe("gradeValueTask", () => {
  it("should pass only when every case is correct", () => {
    expect(gradeValueTask(hexTask, { one: "61626380", two: "00000018" }).passed).toBe(true);
    expect(gradeValueTask(hexTask, { one: "61626380" }).passed).toBe(false);
    expect(gradeValueTask(hexTask, {}).passed).toBe(false);
  });

  it("should report one result per case, in declaration order", () => {
    const result = gradeValueTask(hexTask, { one: "61626380", two: "wrong" });
    expect(result.taskId).toBe("hex-task");
    expect(result.cases.map((entry) => entry.caseId)).toEqual(["one", "two"]);
    expect(result.cases.map((entry) => entry.verdict)).toEqual(["correct", "malformed"]);
  });
});

describe("gradeChoiceTask", () => {
  it("should require every correct choice and no incorrect one", () => {
    expect(gradeChoiceTask(choiceTask, ["a", "b"]).passed).toBe(true);
    expect(gradeChoiceTask(choiceTask, ["a"]).passed).toBe(false);
    expect(gradeChoiceTask(choiceTask, ["a", "b", "c"]).passed).toBe(false);
  });

  it("should not pass an empty selection even when nothing is marked correct", () => {
    const noCorrect: ChoiceTask = {
      ...choiceTask,
      choices: choiceTask.choices.map((entry) => ({ ...entry, correct: false })),
    };
    expect(gradeChoiceTask(noCorrect, []).passed).toBe(false);
  });

  it("should mark each choice against whether it should have been selected", () => {
    const result = gradeChoiceTask(choiceTask, ["a", "c"]);
    expect(result.cases.map((entry) => entry.verdict)).toEqual([
      "correct",
      "incorrect",
      "incorrect",
    ]);
    expect(result.cases[0]?.normalized).toBe("selected");
    expect(result.cases[1]?.normalized).toBe("");
  });
});

describe("gradeTask", () => {
  it("should dispatch on the task kind", () => {
    expect(gradeTask(choiceTask, { kind: "choice", selected: ["a", "b"] }).passed).toBe(true);
    expect(
      gradeTask(hexTask, { kind: "value", answers: { one: "61626380", two: "00000018" } }).passed,
    ).toBe(true);
  });

  it("should fail loudly when the submission kind does not match the task", () => {
    expect(() => gradeTask(choiceTask, { kind: "value", answers: {} })).toThrow(
      "expects a choice submission",
    );
    expect(() => gradeTask(hexTask, { kind: "choice", selected: [] })).toThrow(
      "expects a value submission",
    );
  });
});
