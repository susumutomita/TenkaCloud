import {
  answerCase,
  type DrillSection,
  emptyProgress,
  hint,
  loc,
  recordAttempt,
} from "@tenkacloud/crypto-drill";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrillSectionView } from "./DrillSectionView";

/**
 * 節ビュー: 問題説明 → 図解 → 課題 → 解説 の順序と、 「解説は達成後に開く」挙動を pin する。
 */

const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const section: DrillSection = {
  id: "padding",
  order: 2,
  title: loc("パディング", "Padding"),
  goal: loc("目標文", "The goal"),
  reading: [loc("段落 1", "Paragraph one"), loc("段落 2", "Paragraph two")],
  visual: {
    kind: "bit-lanes",
    groupSize: 8,
    lanes: [{ label: "abc", bits: "01100001" }],
  },
  tasks: [
    {
      id: "task-1",
      kind: "value",
      title: loc("課題", "Task"),
      instruction: loc("課題文", "Task instruction"),
      hints: [hint(1, "ヒント", "Hint")],
      cases: [answerCase({ id: "c1", ja: "問", en: "Case", expected: "40", format: "hex" })],
    },
  ],
  explanation: [loc("解説文", "The explanation")],
  nextStep: loc("次にやること", "What comes next"),
};

function renderSection(progress = emptyProgress("sha256")) {
  render(
    <DrillSectionView
      drillTitle="SHA-256"
      section={section}
      progress={progress}
      locale="ja"
      t={t}
      onAttempt={vi.fn()}
      onRevealHint={vi.fn()}
    />,
  );
}

describe("DrillSectionView", () => {
  it("should title the section with its number", () => {
    renderSection();
    expect(
      screen.getByText('crypto_drill.section_heading|{"order":2,"title":"パディング"}'),
    ).toBeInTheDocument();
    expect(screen.getByText("目標文")).toBeInTheDocument();
  });

  it("should render every reading paragraph in the active locale", () => {
    renderSection();
    expect(screen.getByText("段落 1")).toBeInTheDocument();
    expect(screen.getByText("段落 2")).toBeInTheDocument();
    expect(screen.queryByText("Paragraph one")).not.toBeInTheDocument();
  });

  it("should render the figure and the section's tasks", () => {
    renderSection();
    expect(screen.getByText("crypto_drill.figure_header")).toBeInTheDocument();
    expect(screen.getByTestId("bit-lane-abc")).toBeInTheDocument();
    expect(screen.getByTestId("drill-task-task-1")).toBeInTheDocument();
  });

  it("should omit the figure block for a section that declares no visual", () => {
    render(
      <DrillSectionView
        drillTitle="SHA-256"
        section={{ ...section, visual: undefined }}
        progress={emptyProgress("sha256")}
        locale="ja"
        t={t}
        onAttempt={vi.fn()}
        onRevealHint={vi.fn()}
      />,
    );
    expect(screen.queryByText("crypto_drill.figure_header")).not.toBeInTheDocument();
  });

  it("should keep the explanation collapsed before the section is complete", () => {
    renderSection();
    expect(screen.getByText("crypto_drill.explanation_header")).toBeInTheDocument();
    // Cloudscape の ExpandableSection は畳んだ内容も DOM に残し、 隠すのは CSS class なので
    // jsdom 上の可視性では判定できない。 aria の展開状態を見る (= 支援技術に見える状態と同じ)。
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("should open the explanation and next step once the section is complete", () => {
    renderSection(recordAttempt(emptyProgress("sha256"), "task-1", true));
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    expect(screen.getByText("解説文")).toBeInTheDocument();
    expect(screen.getByText("次にやること")).toBeInTheDocument();
    expect(screen.getByText("crypto_drill.next_step_label")).toBeInTheDocument();
  });
});
