import { describe, expect, it } from "vitest";
import {
  isGateCompleted,
  selectGateCompletionRow,
} from "../../lib/problem-deploy/handlers/shared/progression-gate";

describe("selectGateCompletionRow", () => {
  const GATE = "hello-world-battle";

  it("should return undefined when no row matches the gate problem", () => {
    expect(selectGateCompletionRow([{ problemId: "other", score: 100 }], GATE)).toBeUndefined();
    expect(selectGateCompletionRow([], GATE)).toBeUndefined();
  });

  it("should return the live gate row when no latched row exists", () => {
    const rows = [
      { problemId: GATE, status: "COMPLETE", score: 50 },
      { problemId: "other", score: 999 },
    ];
    expect(selectGateCompletionRow(rows, GATE)).toEqual({
      problemId: GATE,
      status: "COMPLETE",
      score: 50,
    });
  });

  it("should ignore a stale DELETED gate row without a latch (live row wins)", () => {
    const rows = [
      { problemId: GATE, status: "DELETED", score: 999 },
      { problemId: GATE, status: "PENDING", score: 0 },
    ];
    // latch なし → live 行 (未完了) を返す。 stale DELETED の raw score には委ねない。
    expect(isGateCompleted(selectGateCompletionRow(rows, GATE))).toBe(false);
  });

  it("should keep a torn-down completed gate via the gateCompletedAt latch (durable)", () => {
    const rows = [
      { problemId: GATE, status: "DELETED", score: 0, gateCompletedAt: "2026-07-02T00:00:00.000Z" },
    ];
    // 完了済 Gate を teardown しても latch 行を拾う → 完了扱いを維持 (再 lock しない)。
    expect(isGateCompleted(selectGateCompletionRow(rows, GATE))).toBe(true);
  });

  it("should prefer the latched row even when an un-latched live re-deploy exists", () => {
    const rows = [
      { problemId: GATE, status: "DELETED", gateCompletedAt: "2026-07-02T00:00:00.000Z" },
      { problemId: GATE, status: "PENDING", score: 0 },
    ];
    // 完了 latch は sticky。 teardown → 再 deploy の未完了 live 行があっても完了を維持する。
    expect(isGateCompleted(selectGateCompletionRow(rows, GATE))).toBe(true);
  });
});
