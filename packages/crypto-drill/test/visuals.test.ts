import { describe, expect, it } from "vitest";
import { PRIMARY_BLOCK } from "../src/sha256/fixtures";
import { ch, maj } from "../src/sha256/functions";
import {
  bitLane,
  maskTruthOutputs,
  roundRows,
  roundsVisual,
  scheduleStepRows,
  singleBitTruthRows,
  truthOutputColumn,
  wordRow,
} from "../src/sha256/visuals";

describe("visual builders", () => {
  it("should render a word in both hex and binary", () => {
    const row = wordRow("W[0]", 0x61626380);
    expect(row).toEqual({
      label: "W[0]",
      hex: "61626380",
      binary: "01100001011000100110001110000000",
      note: undefined,
    });
  });

  it("should carry an optional note on a word row and a bit lane", () => {
    const note = { ja: "注", en: "Note" };
    expect(wordRow("x", 0, note).note).toBe(note);
    expect(bitLane("x", "0101", note)).toEqual({ label: "x", bits: "0101", note });
    expect(bitLane("x", "0101").note).toBeUndefined();
  });

  it("should build the eight-row truth table with z varying fastest", () => {
    const rows = singleBitTruthRows(ch);
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.inputs.join(""))).toEqual([
      "000",
      "001",
      "010",
      "011",
      "100",
      "101",
      "110",
      "111",
    ]);
  });

  it("should produce the published truth tables for Ch and Maj", () => {
    expect(truthOutputColumn(singleBitTruthRows(ch))).toBe("01010011");
    expect(truthOutputColumn(singleBitTruthRows(maj))).toBe("00010111");
  });

  it("should hide the output column when the learner has to fill it in", () => {
    const masked = maskTruthOutputs(singleBitTruthRows(ch));
    expect(masked.every((row) => row.output === "?")).toBe(true);
    expect(masked.map((row) => row.inputs.join(""))[0]).toBe("000");
  });

  it("should build one round row per round with eight words each", () => {
    const rows = roundRows(PRIMARY_BLOCK.rounds);
    expect(rows).toHaveLength(64);
    expect(rows[0]?.index).toBe(0);
    expect(rows[0]?.words).toHaveLength(8);
    expect(rows[0]?.words[0]).toBe("5d6aebcd");
  });

  it("should label the rounds visual with the eight state registers", () => {
    const visual = roundsVisual(PRIMARY_BLOCK.rounds);
    expect(visual.kind).toBe("rounds");
    if (visual.kind === "rounds") {
      expect(visual.labels).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
      expect(visual.rows).toHaveLength(64);
    }
  });

  it("should lay out a schedule step as its four inputs plus the result", () => {
    const step = PRIMARY_BLOCK.scheduleSteps[0];
    const rows = scheduleStepRows(step);
    expect(rows.map((row) => row.label)).toEqual([
      "W[0]",
      "σ0(W[1])",
      "W[9]",
      "σ1(W[14])",
      "W[16]",
    ]);
    expect(rows[4]?.hex).toBe("61626380");
  });
});
