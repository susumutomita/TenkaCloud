import { describe, expect, it } from "vitest";
import {
  type CliIO,
  main,
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
