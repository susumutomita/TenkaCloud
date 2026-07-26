/**
 * 公開入口 (`src/index.ts`) の疎通確認。
 *
 * SPA は必ずこの barrel 経由で import するので、re-export の書き落としは
 * 「portal の build だけが落ちる」形で現れる。ここで実際に呼んで止める。
 */

import { describe, expect, it } from "vitest";
import {
  buildCoachPrompt,
  digestDiff,
  emptyProgress,
  gradeTask,
  INITIAL_HASH,
  isValueTask,
  listTasks,
  localize,
  nibbleDiffFlags,
  normalizeAnswer,
  padMessage,
  ROUND_CONSTANTS,
  recordAttempt,
  renderProgressBar,
  SHA256_DRILL,
  sha256Hex,
  toHex32,
  traceSha256,
  utf8Encode,
  visibleHints,
} from "../src/index";

describe("package entry point", () => {
  it("should expose the SHA-256 drill with its 15 sections", () => {
    expect(SHA256_DRILL.sections).toHaveLength(15);
    expect(localize(SHA256_DRILL.title, "en")).toContain("SHA-256");
    expect(listTasks(SHA256_DRILL).length).toBeGreaterThan(15);
  });

  it("should expose the reference implementation and its constants", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(traceSha256("abc").blocks).toHaveLength(1);
    expect(ROUND_CONSTANTS).toHaveLength(64);
    expect(toHex32(INITIAL_HASH[0])).toBe("6a09e667");
    expect(padMessage(utf8Encode("abc"))).toHaveLength(64);
  });

  it("should expose grading, progress, coaching and diffing", () => {
    const task = SHA256_DRILL.sections[0].tasks[0];
    expect(isValueTask(task)).toBe(true);
    expect(normalizeAnswer("0x61_62_63", "hex").value).toBe("616263");
    expect(gradeTask(task, { kind: "value", answers: {} }).passed).toBe(false);
    expect(recordAttempt(emptyProgress("sha256"), task.id, true).tasks[task.id]?.completed).toBe(
      true,
    );
    expect(renderProgressBar(1, 3)).toBe("█□□");
    expect(visibleHints(task, 1)).toHaveLength(1);
    expect(
      buildCoachPrompt({
        drillTitle: "SHA-256",
        section: SHA256_DRILL.sections[0],
        task,
        locale: "en",
        mode: "hint",
        attempts: 0,
      }),
    ).toContain("SHA-256");
    expect(digestDiff(sha256Hex("abc"), sha256Hex("abd")).differingBits).toBe(122);
    expect(nibbleDiffFlags("ab", "ab")).toEqual([false, false]);
  });
});
