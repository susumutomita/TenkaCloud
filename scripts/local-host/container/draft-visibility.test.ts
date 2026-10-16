import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerProblemPaths } from "../tests/problem-tree";
import { listLocalPlayProblems } from "./manifest";

/**
 * Issue #2965: local play が `status: "draft"` の問題を出すことを **決定として固定する**。
 *
 * 起票時点ではここが「決めていない」状態だった — `listLocalPlayProblems` は `status` を一切
 * 参照せず、draft が出るのが意図なのか漏れなのかコードから読み取れなかった。
 *
 * 決定は「出す」。理由は 2 つあり、どちらも実測に基づく。
 *
 *  1. カタログには draft の問題が ready と並んで入っている。絞ると、その分だけ local で試せる問題が消える。
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

  it("should list every Docker problem on disk, drafts included, rather than only the ready subset", () => {
    // 件数の literal は持たない。ディスク上の Docker 問題と過不足なく一致し、draft が含まれることを見る。
    const onDisk = dockerProblemPaths(REPO_ROOT)
      .filter((path) => path.startsWith("challenges/"))
      .map((path) => path.slice("challenges/".length))
      .sort();
    const listed = listLocalPlayProblems([CHALLENGES]).map((p) => p.problemId);
    expect([...listed].sort()).toEqual(onDisk);
    expect(listed.filter((id) => statusOf(id) === "draft").length).toBeGreaterThan(0);
  });
});
