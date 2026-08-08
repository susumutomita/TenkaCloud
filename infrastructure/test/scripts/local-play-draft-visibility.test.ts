import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLocalPlayProblems } from "../../../scripts/local-play/manifest";

/**
 * Issue #2965: local play が `status: "draft"` の問題を出すことを **決定として固定する**。
 *
 * 起票時点ではここが「決めていない」状態だった — `listLocalPlayProblems` は `status` を一切
 * 参照せず、draft が出るのが意図なのか漏れなのかコードから読み取れなかった。
 *
 * 決定は「出す」。理由は 2 つあり、どちらも実測に基づく。
 *
 *  1. カタログは ready 23 / draft 44。絞ると 67 問中 44 問が消える。
 *  2. platform が pin している入門ドリル `sqli-demo` 自身が draft。絞ると最初の 1 問すら出ない。
 *
 * local play は出題者が手元で確認する場でもあるので、draft が見えるのが正しい。participant 向けの
 * 公開範囲は `visibility` という別の軸が担う。
 *
 * この test は「draft が出ること」と「その前提が今も成り立っていること」の両方を見る。前提
 * (= 入門ドリルが draft) が変わったらここが落ち、決定を見直す機会になる。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const CHALLENGES = join(REPO_ROOT, "problems", "challenges");
const INTRO_DRILL_ID = "sqli-demo";

function statusOf(problemId: string): string | undefined {
  try {
    const raw = readFileSync(join(CHALLENGES, problemId, "metadata.json"), "utf8");
    return (JSON.parse(raw) as { status?: string }).status;
  } catch {
    return undefined;
  }
}

describe("#2965: local play deliberately lists draft problems", () => {
  it("should still have a draft pinned intro drill, which is why filtering is not an option", () => {
    // ここが "ready" に変わったら、draft を絞る選択肢が現実的になる。そのとき決定を見直す。
    expect(statusOf(INTRO_DRILL_ID)).toBe("draft");
  });

  it("should list the draft intro drill rather than filtering it out", () => {
    const listed = listLocalPlayProblems([CHALLENGES]);
    expect(listed.map((p) => p.problemId)).toContain(INTRO_DRILL_ID);
  });

  it("should list substantially more problems than the ready-only subset", () => {
    // 「絞ったら大半が消える」ことを数で示す。1 件でも draft が出れば通る test にはしない。
    const listed = listLocalPlayProblems([CHALLENGES]);
    const drafts = listed.filter((p) => statusOf(p.problemId) === "draft");
    expect(listed.length).toBeGreaterThan(0);
    expect(drafts.length).toBeGreaterThan(listed.length / 2);
  });
});
