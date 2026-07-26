import {
  answerCase,
  type ChoiceTask,
  choice,
  type DrillSection,
  emptyProgress,
  hint,
  loc,
  recordAttempt,
  revealNextHint,
  type ValueTask,
} from "@tenkacloud/crypto-drill";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DrillTaskCard, verdictColor, verdictKey } from "./DrillTaskCard";

/**
 * 課題カード: 入力 → 採点 → 判定表示 → 段階ヒント → AI プロンプト。
 * `t` は key をそのまま返す stub なので、 表示文言ではなく「どの状態でどの key を出すか」を pin する。
 */

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const valueTask: ValueTask = {
  id: "value-task",
  kind: "implementation",
  title: loc("題", "Title"),
  instruction: loc("説明", "Instruction"),
  starter: "const rotr = (x, n) => x;",
  hints: [hint(1, "ヒント1", "Hint 1"), hint(2, "ヒント2", "Hint 2")],
  cases: [
    answerCase({ id: "one", ja: "問 1", en: "Case 1", expected: "61626380", format: "hex" }),
    answerCase({ id: "two", ja: "問 2", en: "Case 2", expected: "64", format: "decimal" }),
  ],
};

const multiTask: ChoiceTask = {
  id: "multi-task",
  kind: "choice",
  multi: true,
  title: loc("題", "Title"),
  instruction: loc("説明", "Instruction"),
  hints: [hint(1, "ヒント", "Hint")],
  choices: [
    choice({
      id: "a",
      ja: "A",
      en: "A",
      correct: true,
      rationaleJa: "理由A",
      rationaleEn: "Why A",
    }),
    choice({
      id: "b",
      ja: "B",
      en: "B",
      correct: false,
      rationaleJa: "理由B",
      rationaleEn: "Why B",
    }),
  ],
};

const singleTask: ChoiceTask = { ...multiTask, id: "single-task", multi: false };

const section: DrillSection = {
  id: "section",
  order: 1,
  title: loc("節", "Section"),
  goal: loc("目標", "Goal"),
  reading: [loc("本文", "Body")],
  tasks: [valueTask],
  explanation: [loc("解説", "Explanation")],
  nextStep: loc("次", "Next"),
};

function renderCard(overrides: Partial<Parameters<typeof DrillTaskCard>[0]> = {}) {
  const onAttempt = vi.fn();
  const onRevealHint = vi.fn();
  render(
    <DrillTaskCard
      drillTitle="SHA-256"
      section={section}
      task={valueTask}
      progress={emptyProgress("sha256")}
      locale="ja"
      t={t}
      onAttempt={onAttempt}
      onRevealHint={onRevealHint}
      {...overrides}
    />,
  );
  return { onAttempt, onRevealHint };
}

describe("verdict presentation", () => {
  it("should map each verdict to its own message", () => {
    expect(verdictKey("correct")).toBe("crypto_drill.verdict_correct");
    expect(verdictKey("incorrect")).toBe("crypto_drill.verdict_incorrect");
    expect(verdictKey("malformed")).toBe("crypto_drill.verdict_malformed");
    expect(verdictKey("empty")).toBe("crypto_drill.verdict_empty");
  });

  it("should colour an unanswered case differently from a wrong one", () => {
    expect(verdictColor("correct")).toBe("green");
    expect(verdictColor("empty")).toBe("grey");
    expect(verdictColor("incorrect")).toBe("red");
    expect(verdictColor("malformed")).toBe("red");
  });
});

describe("DrillTaskCard value tasks", () => {
  it("should show the starter snippet behind an expander with a do-not-run note", async () => {
    renderCard();
    await userEvent.click(screen.getByText("crypto_drill.starter_header"));
    expect(screen.getByText("const rotr = (x, n) => x;")).toBeInTheDocument();
    expect(screen.getByText("crypto_drill.starter_note")).toBeInTheDocument();
  });

  it("should tell the learner the expected format and width of each answer", () => {
    renderCard();
    expect(
      screen.getByText(
        'crypto_drill.expected_format|{"format":"crypto_drill.format_hex","width":8}',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'crypto_drill.expected_format|{"format":"crypto_drill.format_decimal","width":2}',
      ),
    ).toBeInTheDocument();
  });

  it("should report the attempt as failed when the answers are empty", async () => {
    const { onAttempt } = renderCard();
    await userEvent.click(screen.getByTestId("grade-value-task"));
    expect(onAttempt).toHaveBeenCalledWith("value-task", false);
    expect(screen.getByText("crypto_drill.not_yet")).toBeInTheDocument();
    expect(screen.getByTestId("case-result-one").textContent).toContain(
      "crypto_drill.verdict_empty",
    );
  });

  it("should pass once every answer matches, tolerating separators", async () => {
    const { onAttempt } = renderCard();
    fireEvent.change(screen.getByLabelText("問 1"), { target: { value: "0x61_62_63_80" } });
    fireEvent.change(screen.getByLabelText("問 2"), { target: { value: "64" } });
    await userEvent.click(screen.getByTestId("grade-value-task"));
    expect(onAttempt).toHaveBeenCalledWith("value-task", true);
    expect(screen.getByText("crypto_drill.passed")).toBeInTheDocument();
  });

  it("should show how a malformed answer was interpreted", async () => {
    renderCard();
    fireEvent.change(screen.getByLabelText("問 1"), { target: { value: "zz" } });
    await userEvent.click(screen.getByTestId("grade-value-task"));
    expect(screen.getByTestId("case-result-one").textContent).toContain(
      "crypto_drill.verdict_malformed",
    );
    expect(screen.getByText('crypto_drill.read_as|{"value":"zz"}')).toBeInTheDocument();
  });

  it("should mark a task that is already complete", () => {
    renderCard({ progress: recordAttempt(emptyProgress("sha256"), "value-task", true) });
    expect(screen.getByText("crypto_drill.task_done")).toBeInTheDocument();
  });
});

describe("DrillTaskCard hints", () => {
  it("should ask the caller to reveal the next hint", async () => {
    const { onRevealHint } = renderCard();
    await userEvent.click(screen.getByTestId("hint-value-task"));
    expect(onRevealHint).toHaveBeenCalledWith("value-task", 2);
  });

  it("should show only the hints already revealed", () => {
    renderCard({ progress: revealNextHint(emptyProgress("sha256"), "value-task", 2) });
    expect(screen.getByText("ヒント1")).toBeInTheDocument();
    expect(screen.queryByText("ヒント2")).not.toBeInTheDocument();
  });

  it("should hide the reveal button once every hint is shown", () => {
    let progress = revealNextHint(emptyProgress("sha256"), "value-task", 2);
    progress = revealNextHint(progress, "value-task", 2);
    renderCard({ progress });
    expect(screen.queryByTestId("hint-value-task")).not.toBeInTheDocument();
    expect(screen.getByText("ヒント2")).toBeInTheDocument();
  });
});

describe("DrillTaskCard AI support", () => {
  it("should build a hint prompt that carries no expected answer", async () => {
    renderCard();
    await userEvent.click(screen.getByTestId("coach-hint-value-task"));
    const prompt = screen.getByLabelText("crypto_drill.coach_prompt_label") as HTMLTextAreaElement;
    expect(prompt.value).toContain("答えの値は書かずに");
    expect(prompt.value).not.toContain("61626380");
    expect(prompt.readOnly).toBe(true);
  });

  it("should build an explain prompt on the other button", async () => {
    renderCard();
    await userEvent.click(screen.getByTestId("coach-explain-value-task"));
    expect(
      (screen.getByLabelText("crypto_drill.coach_prompt_label") as HTMLTextAreaElement).value,
    ).toContain("なぜこの処理が");
  });
});

describe("DrillTaskCard choice tasks", () => {
  it("should require every correct option in a multi-select task", async () => {
    const { onAttempt } = renderCard({ task: multiTask });
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    await userEvent.click(screen.getByTestId("grade-multi-task"));
    expect(onAttempt).toHaveBeenLastCalledWith("multi-task", true);
  });

  it("should fail when an incorrect option is also selected", async () => {
    const { onAttempt } = renderCard({ task: multiTask });
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "B" }));
    await userEvent.click(screen.getByTestId("grade-multi-task"));
    expect(onAttempt).toHaveBeenLastCalledWith("multi-task", false);
  });

  it("should let a selected option be unselected again", async () => {
    const { onAttempt } = renderCard({ task: multiTask });
    await userEvent.click(screen.getByRole("checkbox", { name: "B" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "B" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    await userEvent.click(screen.getByTestId("grade-multi-task"));
    expect(onAttempt).toHaveBeenLastCalledWith("multi-task", true);
  });

  it("should show every rationale after grading, right and wrong alike", async () => {
    renderCard({ task: multiTask });
    expect(screen.queryByText(/理由A/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    await userEvent.click(screen.getByTestId("grade-multi-task"));
    expect(screen.getByText(/理由A/)).toBeInTheDocument();
    expect(screen.getByText(/理由B/)).toBeInTheDocument();
  });

  it("should offer radio buttons for a single-answer task", async () => {
    const { onAttempt } = renderCard({ task: singleTask });
    await userEvent.click(screen.getByRole("radio", { name: "A" }));
    await userEvent.click(screen.getByTestId("grade-single-task"));
    expect(onAttempt).toHaveBeenLastCalledWith("single-task", true);
  });

  it("should fail a single-answer task when the wrong option is picked", async () => {
    const { onAttempt } = renderCard({ task: singleTask });
    await userEvent.click(screen.getByRole("radio", { name: "B" }));
    await userEvent.click(screen.getByTestId("grade-single-task"));
    expect(onAttempt).toHaveBeenLastCalledWith("single-task", false);
  });

  it("should not offer a starter expander for a choice task", () => {
    renderCard({ task: multiTask });
    expect(screen.queryByText("crypto_drill.starter_header")).not.toBeInTheDocument();
  });
});
