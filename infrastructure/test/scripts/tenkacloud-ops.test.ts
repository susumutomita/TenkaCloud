import { describe, expect, it } from "vitest";
import {
  buildListStacksArgs,
  type CfnStackSummary,
  type CliIO,
  classifyStacks,
  computeHealthExitCode,
  filterTenkaCloudStacks,
  main,
  parseStackSummariesJson,
  runHealth,
  type SpawnCaptureResult,
} from "../../../scripts/tenkacloud-ops";

/**
 * Issue #952: tenkacloud-ops CLI の健全性 / 異常検出を pin する。
 *
 * AI 無人運用の足場として、 「全 stack 健全 / in-progress / failed」 の 3 状態を
 * exit code で区別できることを確認する (= 0 / 1 / 2)。 これにより外部 cron / agent が
 * stack 状態を 1 度の spawn で判断できる。
 */

function makeIO(spawnResults: SpawnCaptureResult[]): {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let idx = 0;
  const io: CliIO = {
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    spawnCapture: async () => spawnResults[idx++] ?? { code: 1, stdout: "", stderr: "no more" },
  };
  return { io, stdout, stderr };
}

describe("tenkacloud-ops (#952 AI ops scaffold)", () => {
  it("ヘルプ表示は exit 0 で usage を返すべき", async () => {
    const { io, stdout } = makeIO([]);
    const code = await main(["help"], io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("tenkacloud ops");
    expect(stdout.join("")).toContain("Usage:");
  });

  it("引数なしは help を表示するべき", async () => {
    const { io, stdout } = makeIO([]);
    const code = await main([], io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("Usage:");
  });

  it("未知 subcommand は exit 1 でエラーメッセージを stderr に出すべき", async () => {
    const { io, stderr } = makeIO([]);
    const code = await main(["bogus-cmd"], io);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("unknown command");
  });

  it("health: 全 stack 健全なら exit 0 すべき", async () => {
    const { io, stdout } = makeIO([
      {
        code: 0,
        stdout: JSON.stringify({
          StackSummaries: [
            { StackName: "tenkacloud-control-plane", StackStatus: "CREATE_COMPLETE" },
            { StackName: "tenkacloud-lite", StackStatus: "UPDATE_COMPLETE" },
            { StackName: "tc-hello-world-demo-team", StackStatus: "CREATE_COMPLETE" },
            { StackName: "other-stack", StackStatus: "CREATE_COMPLETE" },
          ],
        }),
        stderr: "",
      },
    ]);
    const code = await runHealth(io);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("3 total");
    expect(out).toContain("HEALTHY (3)");
    expect(out).not.toContain("other-stack"); // prefix 違いは除外
  });

  it("health: in_progress の stack があれば exit 1 (= soft warning)", async () => {
    const { io } = makeIO([
      {
        code: 0,
        stdout: JSON.stringify({
          StackSummaries: [
            { StackName: "tenkacloud-control-plane", StackStatus: "CREATE_COMPLETE" },
            { StackName: "tenkacloud-lite", StackStatus: "UPDATE_IN_PROGRESS" },
          ],
        }),
        stderr: "",
      },
    ]);
    const code = await runHealth(io);
    expect(code).toBe(1);
  });

  it("health: ROLLBACK / FAILED があれば exit 2 (= hard fail)", async () => {
    const { io } = makeIO([
      {
        code: 0,
        stdout: JSON.stringify({
          StackSummaries: [
            { StackName: "tenkacloud-control-plane", StackStatus: "CREATE_COMPLETE" },
            { StackName: "tenkacloud-lite", StackStatus: "ROLLBACK_COMPLETE" },
          ],
        }),
        stderr: "",
      },
    ]);
    const code = await runHealth(io);
    expect(code).toBe(2);
  });

  it("health: TenkaCloud stack 0 件なら exit 0 でその旨表示", async () => {
    const { io, stdout } = makeIO([
      { code: 0, stdout: JSON.stringify({ StackSummaries: [] }), stderr: "" },
    ]);
    const code = await runHealth(io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("no TenkaCloud stacks");
  });

  it("health: aws CLI が失敗したら non-zero で stderr に message", async () => {
    const { io, stderr } = makeIO([{ code: 254, stdout: "", stderr: "credentials expired" }]);
    const code = await runHealth(io);
    expect(code).toBe(254);
    expect(stderr.join("")).toContain("credentials expired");
  });

  it("health --region us-east-1 が aws CLI 引数に渡るべき", async () => {
    let capturedArgs: readonly string[] | null = null;
    const io: CliIO = {
      stdout: () => {},
      stderr: () => {},
      spawnCapture: async (_cmd, args) => {
        capturedArgs = args;
        return { code: 0, stdout: JSON.stringify({ StackSummaries: [] }), stderr: "" };
      },
    };
    await runHealth(io, "us-east-1");
    expect(capturedArgs).not.toBeNull();
    const argsString = (capturedArgs ?? []).join(" ");
    expect(argsString).toContain("--region us-east-1");
  });
});

describe("runHealth helpers", () => {
  it("buildListStacksArgs: region 未指定なら --region を付けず status filter は完全に揃うべき", () => {
    const args = buildListStacksArgs();
    expect(args).toContain("cloudformation");
    expect(args).toContain("list-stacks");
    expect(args).toContain("--stack-status-filter");
    expect(args).toContain("CREATE_COMPLETE");
    expect(args).toContain("ROLLBACK_FAILED");
    expect(args).toContain("UPDATE_ROLLBACK_COMPLETE");
    expect(args).toContain("IMPORT_ROLLBACK_COMPLETE");
    expect(args).toContain("--output");
    expect(args).toContain("json");
    expect(args).not.toContain("--region");
  });

  it("buildListStacksArgs: region 指定で --region <r> を末尾に追加すべき", () => {
    const args = buildListStacksArgs("ap-northeast-1");
    expect(args[args.length - 2]).toBe("--region");
    expect(args[args.length - 1]).toBe("ap-northeast-1");
  });

  it("parseStackSummariesJson: 正常 JSON は StackSummaries を返すべき", () => {
    const out = parseStackSummariesJson(
      JSON.stringify({
        StackSummaries: [{ StackName: "tenkacloud-x", StackStatus: "CREATE_COMPLETE" }],
      }),
    );
    expect(out).toEqual({
      ok: true,
      stacks: [{ StackName: "tenkacloud-x", StackStatus: "CREATE_COMPLETE" }],
    });
  });

  it("parseStackSummariesJson: StackSummaries 不在は空配列を返すべき", () => {
    expect(parseStackSummariesJson("{}")).toEqual({ ok: true, stacks: [] });
  });

  it("parseStackSummariesJson: 壊れた JSON は error を返すべき", () => {
    const out = parseStackSummariesJson("not json");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/.+/);
  });

  it("filterTenkaCloudStacks: 既知 prefix の stack だけを残すべき", () => {
    const all: readonly CfnStackSummary[] = [
      { StackName: "tenkacloud-control-plane", StackStatus: "CREATE_COMPLETE" },
      { StackName: "serverless-saas-ref-arch-pooled", StackStatus: "CREATE_COMPLETE" },
      { StackName: "tc-stackstack-team1", StackStatus: "CREATE_COMPLETE" },
      { StackName: "unrelated-stack", StackStatus: "CREATE_COMPLETE" },
    ];
    const ours = filterTenkaCloudStacks(all);
    expect(ours.map((s) => s.StackName)).toEqual([
      "tenkacloud-control-plane",
      "serverless-saas-ref-arch-pooled",
      "tc-stackstack-team1",
    ]);
  });

  it("classifyStacks: FAILED / ROLLBACK / IN_PROGRESS / その他で 3 bucket に振り分けるべき", () => {
    const buckets = classifyStacks([
      { StackName: "a", StackStatus: "CREATE_COMPLETE" },
      { StackName: "b", StackStatus: "CREATE_FAILED" },
      { StackName: "c", StackStatus: "UPDATE_ROLLBACK_COMPLETE" },
      { StackName: "d", StackStatus: "UPDATE_IN_PROGRESS" },
      { StackName: "e", StackStatus: "UPDATE_COMPLETE" },
    ]);
    expect(buckets.healthy.map((s) => s.StackName)).toEqual(["a", "e"]);
    expect(buckets.inProgress.map((s) => s.StackName)).toEqual(["d"]);
    expect(buckets.failed.map((s) => s.StackName)).toEqual(["b", "c"]);
  });

  it("computeHealthExitCode: failed>0 で 2、 in_progress のみで 1、 healthy のみで 0", () => {
    expect(computeHealthExitCode({ healthy: [], inProgress: [], failed: [] })).toBe(0);
    expect(
      computeHealthExitCode({
        healthy: [{ StackName: "a", StackStatus: "CREATE_COMPLETE" }],
        inProgress: [],
        failed: [],
      }),
    ).toBe(0);
    expect(
      computeHealthExitCode({
        healthy: [],
        inProgress: [{ StackName: "a", StackStatus: "CREATE_IN_PROGRESS" }],
        failed: [],
      }),
    ).toBe(1);
    expect(
      computeHealthExitCode({
        healthy: [],
        inProgress: [{ StackName: "a", StackStatus: "CREATE_IN_PROGRESS" }],
        failed: [{ StackName: "b", StackStatus: "CREATE_FAILED" }],
      }),
    ).toBe(2);
  });
});
