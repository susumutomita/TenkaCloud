import type { DrillVisual } from "@tenkacloud/crypto-drill";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DrillVisualView, groupBits } from "./DrillVisualView";

/**
 * 図解の描画。 5 種類の `kind` すべてと、 差分ハイライト・note の有無を pin する。
 * 値そのものは `@tenkacloud/crypto-drill` の責務なので、 ここでは「宣言した通りに描くか」だけ見る。
 */

describe("groupBits", () => {
  it("should split a bit string into fixed-size groups", () => {
    expect(groupBits("0110000101100010", 8)).toEqual(["01100001", "01100010"]);
    expect(groupBits("0110", 8)).toEqual(["0110"]);
  });

  it("should return the whole string when the group size is not positive", () => {
    expect(groupBits("0110", 0)).toEqual(["0110"]);
    expect(groupBits("0110", -4)).toEqual(["0110"]);
  });
});

describe("DrillVisualView", () => {
  it("should render bit lanes with their labels and notes", () => {
    const visual: DrillVisual = {
      kind: "bit-lanes",
      groupSize: 8,
      lanes: [
        { label: "abc", bits: "0110000101100010", note: { ja: "3 byte", en: "3 bytes" } },
        { label: "pad", bits: "10000000" },
      ],
    };
    render(<DrillVisualView visual={visual} locale="en" />);
    expect(screen.getByTestId("bit-lane-abc").textContent).toBe("0110000101100010");
    expect(screen.getByText("3 bytes")).toBeInTheDocument();
    expect(screen.getByTestId("bit-lane-pad")).toBeInTheDocument();
    expect(screen.queryByText("3 byte")).not.toBeInTheDocument();
  });

  it("should render word rows in hex and binary", () => {
    const visual: DrillVisual = {
      kind: "words",
      rows: [
        {
          label: "W[0]",
          hex: "61626380",
          binary: "01100001011000100110001110000000",
          note: { ja: "先頭語", en: "first word" },
        },
      ],
    };
    render(<DrillVisualView visual={visual} locale="ja" />);
    expect(screen.getByText("61626380")).toBeInTheDocument();
    expect(screen.getByText("01100001011000100110001110000000")).toBeInTheDocument();
    expect(screen.getByText("先頭語")).toBeInTheDocument();
  });

  it("should render a truth table with the output column last", () => {
    const visual: DrillVisual = {
      kind: "truth-table",
      headers: ["x", "y", "z", "Ch"],
      rows: [
        { inputs: ["0", "0", "0"], output: "?" },
        { inputs: ["1", "1", "0"], output: "?" },
      ],
    };
    render(<DrillVisualView visual={visual} locale="en" />);
    expect(screen.getByText("Ch")).toBeInTheDocument();
    expect(screen.getAllByText("?")).toHaveLength(2);
  });

  it("should render a rounds table with one row per round", () => {
    const visual: DrillVisual = {
      kind: "rounds",
      labels: ["a", "b"],
      rows: [
        { index: 0, words: ["5d6aebcd", "6a09e667"] },
        { index: 1, words: ["fa2a4622", "5d6aebcd"] },
      ],
    };
    render(<DrillVisualView visual={visual} locale="en" />);
    expect(screen.getByText("fa2a4622")).toBeInTheDocument();
    expect(screen.getAllByText("5d6aebcd")).toHaveLength(2);
  });

  it("should highlight only the hex digits that differ from the first row", () => {
    const visual: DrillVisual = {
      kind: "hash-diff",
      rows: [
        { label: "abc", hex: "abcd" },
        { label: "abd", hex: "abce" },
      ],
    };
    render(<DrillVisualView visual={visual} locale="en" />);
    const changed = screen.getByTestId("hash-diff-abd").querySelectorAll(".tc-drill-diff-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.textContent).toBe("e");
    expect(
      screen.getByTestId("hash-diff-abc").querySelectorAll(".tc-drill-diff-changed"),
    ).toHaveLength(0);
  });

  it("should skip highlighting when the rows are not comparable", () => {
    const visual: DrillVisual = {
      kind: "hash-diff",
      rows: [
        { label: "short", hex: "ab" },
        { label: "long", hex: "abcd" },
      ],
    };
    render(<DrillVisualView visual={visual} locale="en" />);
    expect(
      screen.getByTestId("hash-diff-long").querySelectorAll(".tc-drill-diff-changed"),
    ).toHaveLength(0);
  });

  it("should render nothing highlighted when the diff has no first row", () => {
    render(<DrillVisualView visual={{ kind: "hash-diff", rows: [] }} locale="en" />);
    expect(document.querySelectorAll(".tc-drill-diff-changed")).toHaveLength(0);
  });
});
