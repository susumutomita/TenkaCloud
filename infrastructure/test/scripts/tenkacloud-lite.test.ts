import { describe, expect, it } from "vitest";
import {
  type CliIO,
  LITE_STACK_NAMES,
  main,
  type SpawnCaptureResult,
} from "../../../scripts/tenkacloud-lite";

/**
 * Issue #778 ADR-016 Phase 4: TenkaCloud Lite CLI runner の挙動 pin。
 *
 * spawn 系を injectable にしてあるので、 AWS / CDK を実行せずに subcommand dispatch /
 * help / unknown subcommand / output 読み取りを観測する。
 */

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly mode: "inherit" | "capture";
}

function buildIO(opts: {
  readonly inheritExitCode?: number;
  readonly capture?: (cmd: string, args: readonly string[]) => SpawnCaptureResult;
}): {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: SpawnCall[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: SpawnCall[] = [];
  const io: CliIO = {
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    spawnInherit: async (cmd, args) => {
      calls.push({ cmd, args: [...args], mode: "inherit" });
      return opts.inheritExitCode ?? 0;
    },
    spawnCapture: async (cmd, args) => {
      calls.push({ cmd, args: [...args], mode: "capture" });
      return opts.capture ? opts.capture(cmd, [...args]) : { code: 0, stdout: "", stderr: "" };
    },
  };
  return { io, stdout, stderr, calls };
}

describe("tenkacloud-lite CLI (#778 ADR-016 Phase 4)", () => {
  it("引数なし / help / -h / --help でヘルプを出して exit 0 を返すべき", async () => {
    for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
      const { io, stdout } = buildIO({});
      const code = await main(argv, io);
      expect(code).toBe(0);
      const text = stdout.join("");
      expect(text).toContain("tenkacloud lite");
      expect(text).toContain("up");
      expect(text).toContain("down");
      expect(text).toContain("portal-url");
      expect(text).toContain("console-url");
      expect(text).toContain("status");
    }
  });

  it("未知の subcommand では exit 1 + stderr にメッセージ + help を出すべき", async () => {
    const { io, stdout, stderr } = buildIO({});
    const code = await main(["frobnicate"], io);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Unknown subcommand: frobnicate");
    expect(stdout.join("")).toContain("使い方:");
  });

  it("up は cdk deploy を 1 回 inherit で呼び、 両 stack 名と --require-approval never を渡すべき", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: () => ({ code: 0, stdout: "https://example.cloudfront.net", stderr: "" }),
    });
    const code = await main(["up"], io);
    expect(code).toBe(0);
    const inheritCalls = calls.filter((c) => c.mode === "inherit");
    expect(inheritCalls).toHaveLength(1);
    const deployCall = inheritCalls[0];
    expect(deployCall.cmd).toBe("bunx");
    expect(deployCall.args).toContain("cdk");
    expect(deployCall.args).toContain("deploy");
    expect(deployCall.args).toContain(LITE_STACK_NAMES.app);
    expect(deployCall.args).toContain(LITE_STACK_NAMES.problemDeploy);
    expect(deployCall.args).toContain("--require-approval");
    expect(deployCall.args).toContain("never");
  });

  it("up は cdk deploy が non-zero で落ちたら早期 return し AWS CLI を呼ばないべき", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 2 });
    const code = await main(["up"], io);
    expect(code).toBe(2);
    expect(calls.filter((c) => c.cmd === "aws")).toHaveLength(0);
  });

  it("down は app stack を先に destroy → problem-deploy stack の順で呼ぶべき", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 0 });
    const code = await main(["down"], io);
    expect(code).toBe(0);
    const destroyCalls = calls.filter((c) => c.args.includes("destroy"));
    expect(destroyCalls).toHaveLength(2);
    // 1 回目は app stack、 2 回目は problem-deploy stack の cross-stack 依存方向に合わせる。
    expect(destroyCalls[0].args).toContain(LITE_STACK_NAMES.app);
    expect(destroyCalls[1].args).toContain(LITE_STACK_NAMES.problemDeploy);
    for (const call of destroyCalls) {
      expect(call.args).toContain("--force");
    }
  });

  it("down は 1 回目の destroy が落ちたら 2 回目を呼ばずに同じ exit code を返すべき", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 3 });
    const code = await main(["down"], io);
    expect(code).toBe(3);
    expect(calls.filter((c) => c.args.includes("destroy"))).toHaveLength(1);
  });

  it("portal-url は問題 deploy stack の ParticipantPortalApiUrl output を describe-stacks で問い合わせるべき", async () => {
    const { io, calls, stdout } = buildIO({
      capture: () => ({ code: 0, stdout: "https://portal.example.com\n", stderr: "" }),
    });
    const code = await main(["portal-url"], io);
    expect(code).toBe(0);
    const awsCall = calls.find((c) => c.cmd === "aws");
    expect(awsCall).toBeDefined();
    expect(awsCall?.args).toContain("describe-stacks");
    expect(awsCall?.args).toContain("--stack-name");
    expect(awsCall?.args).toContain(LITE_STACK_NAMES.problemDeploy);
    expect(awsCall?.args.join(" ")).toContain("ParticipantPortalApiUrl");
    expect(stdout.join("")).toContain("https://portal.example.com");
  });

  it("console-url は AppPlane stack の ApplicationAdminConsoleUrl output を問い合わせるべき", async () => {
    const { io, calls, stdout } = buildIO({
      capture: () => ({ code: 0, stdout: "https://console.example.com\n", stderr: "" }),
    });
    const code = await main(["console-url"], io);
    expect(code).toBe(0);
    const awsCall = calls.find((c) => c.cmd === "aws");
    expect(awsCall?.args).toContain(LITE_STACK_NAMES.app);
    expect(awsCall?.args.join(" ")).toContain("ApplicationAdminConsoleUrl");
    expect(stdout.join("")).toContain("https://console.example.com");
  });

  it("output が空文字なら not found を stderr に出して exit 1 を返すべき", async () => {
    const { io, stderr } = buildIO({
      capture: () => ({ code: 0, stdout: "  \n", stderr: "" }),
    });
    const code = await main(["portal-url"], io);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not found");
  });

  it("describe-stacks が non-zero で落ちたら NOT_DEPLOYED として status に出すべき", async () => {
    const { io, stdout } = buildIO({
      capture: () => ({ code: 255, stdout: "", stderr: "Stack does not exist" }),
    });
    const code = await main(["status"], io);
    expect(code).toBe(0);
    const text = stdout.join("");
    expect(text).toContain(LITE_STACK_NAMES.app);
    expect(text).toContain(LITE_STACK_NAMES.problemDeploy);
    // どちらの stack も NOT_DEPLOYED と報告される。
    expect(text.match(/NOT_DEPLOYED/g)?.length).toBe(2);
  });

  it("status は describe-stacks 結果を 1 行ずつ標準出力に出すべき", async () => {
    const { io, stdout } = buildIO({
      capture: (_cmd, args) => {
        const stackName = args[args.indexOf("--stack-name") + 1];
        const status =
          stackName === LITE_STACK_NAMES.app ? "CREATE_COMPLETE" : "UPDATE_IN_PROGRESS";
        return { code: 0, stdout: `${status}\n`, stderr: "" };
      },
    });
    const code = await main(["status"], io);
    expect(code).toBe(0);
    const text = stdout.join("");
    expect(text).toContain("CREATE_COMPLETE");
    expect(text).toContain("UPDATE_IN_PROGRESS");
  });
});
