import { describe, expect, it } from "bun:test";
import { explainGenericPrTitle, GENERIC_PR_TITLES } from "./check-pr-title";

describe("generic PR title gate", () => {
  it.each([...GENERIC_PR_TITLES])("rejects the bare generic word %s", (word) => {
    expect(explainGenericPrTitle(word)).toContain("generic word");
  });

  it.each([
    "Fix",
    "UPDATE",
    "fix.",
    "update!",
    "[WIP]",
    "wip:",
    " fix ",
    "更新。",
    "【修正】",
    "変更 ",
    "misc-",
    "work_",
  ])("rejects the effectively-exact variant %j", (title) => {
    expect(explainGenericPrTitle(title)).toContain("generic word");
  });

  it.each(["", "!!!", "。。。", " - "])("rejects wordless title %j", (title) => {
    expect(explainGenericPrTitle(title)).toContain("no words at all");
  });

  it.each([
    "fix(local-play): handle EPIPE from the simulator proxy",
    "fix: handle EPIPE from the simulator proxy",
    "feat(release): manifest schema v2 with a tag-derived platform identity",
    "chore(problems): advance the catalog pin to cs-dst-daily-rollup",
    "LPの問題追加導線にProblem Pack(非公開追加)を追記",
    "update the launcher defaults from the release identity",
    "修正: simulator proxy の EPIPE を処理する",
    "wip cleanup of the release scripts",
  ])("allows the specific title %j", (title) => {
    expect(explainGenericPrTitle(title)).toBeNull();
  });
});
