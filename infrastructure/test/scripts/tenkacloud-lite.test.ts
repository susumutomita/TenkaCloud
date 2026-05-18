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

  it("up は prepare-source-bundle.sh と cdk deploy を順に inherit 呼びすべき", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: () => ({ code: 0, stdout: "https://example.cloudfront.net", stderr: "" }),
    });
    const code = await main(["up"], io);
    expect(code).toBe(0);
    const inheritCalls = calls.filter((c) => c.mode === "inherit");
    // prepare-source-bundle.sh (= source.zip prep) → cdk deploy の 2 call
    expect(inheritCalls).toHaveLength(2);

    const prepCall = inheritCalls[0];
    expect(prepCall.cmd).toBe("bash");
    expect(prepCall.args).toContain("scripts/prepare-source-bundle.sh");

    const deployCall = inheritCalls[1];
    // 2026-05-18 user feedback「bunx 禁止」 + 「Script not found 'cdk'」 regression
    // (= PR-#1030 で bunx → bun に置換した結果、 repo root に "cdk" script が無く Bun
    // が fail) 対策: cdk binary を repo root の hoist 先から直接 spawn する。
    // `./infrastructure/node_modules/.bin/cdk` は workspace の hoist で broken symlink
    // になっており exit 127 で fail する (= user 観測)。
    expect(deployCall.cmd).toBe("./node_modules/aws-cdk/bin/cdk");
    expect(deployCall.args).toContain("deploy");
    expect(deployCall.args).toContain(LITE_STACK_NAMES.app);
    expect(deployCall.args).toContain(LITE_STACK_NAMES.problemDeploy);
    expect(deployCall.args).toContain("--require-approval");
    expect(deployCall.args).toContain("never");
  });

  it("up は prepare-source-bundle.sh が non-zero で落ちたら cdk deploy を呼ばずに早期 return すべき", async () => {
    // 1st spawn (= prepare-source-bundle.sh) で失敗させ、 2nd (= cdk deploy) は呼ばれないことを確認
    let firstCall = true;
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const io = {
      stdout: () => undefined,
      stderr: () => undefined,
      spawnInherit: async (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        if (firstCall) {
          firstCall = false;
          return 1; // prepare-source-bundle.sh fail
        }
        return 0;
      },
      spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const code = await main(["up"], io);
    expect(code).toBe(1);
    // prepare 呼び出しだけで cdk deploy は呼ばない
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("bash");
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

  // Issue #955 follow-up (= PR-959 CodeRabbit / user feedback): Lite mode は SBT を
  // 持たないため tenant admin user を自前で起こす必要がある (= 無いと console にログイン
  // できない)。 cmdUp の post-deploy 段階で describe-user-pool-domain → admin-create-user
  // を idempotent に呼ぶ。
  describe("up post-deploy: tenant admin user 作成 (#955 follow-up)", () => {
    const originalEmail = process.env.TENANT_ADMIN_EMAIL;
    const originalSystem = process.env.SYSTEM_ADMIN_EMAIL;

    function restoreEnv(): void {
      if (originalEmail === undefined) {
        delete process.env.TENANT_ADMIN_EMAIL;
      } else {
        process.env.TENANT_ADMIN_EMAIL = originalEmail;
      }
      if (originalSystem === undefined) {
        delete process.env.SYSTEM_ADMIN_EMAIL;
      } else {
        process.env.SYSTEM_ADMIN_EMAIL = originalSystem;
      }
    }

    it("TENANT_ADMIN_EMAIL が空でも deploy は通り、 admin-create-user は呼ばないべき", async () => {
      delete process.env.TENANT_ADMIN_EMAIL;
      delete process.env.SYSTEM_ADMIN_EMAIL;
      try {
        const { io, calls, stderr } = buildIO({
          inheritExitCode: 0,
          capture: () => ({ code: 0, stdout: "https://abc.cloudfront.net", stderr: "" }),
        });
        const code = await main(["up"], io);
        expect(code).toBe(0);
        expect(stderr.join("")).toContain("TENANT_ADMIN_EMAIL");
        const createCall = calls.find((c) => c.args.includes("admin-create-user"));
        expect(createCall).toBeUndefined();
      } finally {
        restoreEnv();
      }
    });

    it("TENANT_ADMIN_EMAIL が設定されているとき、 describe-user-pool-domain → admin-get-user → admin-create-user の順で呼ぶべき", async () => {
      process.env.TENANT_ADMIN_EMAIL = "admin@example.com";
      try {
        let capturedDomain: string | undefined;
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: (_cmd, args) => {
            if (args.includes("describe-stacks")) {
              if (args.join(" ").includes("CognitoDomainUrl")) {
                return {
                  code: 0,
                  stdout: "https://tc-app-prefix.auth.ap-northeast-1.amazoncognito.com\n",
                  stderr: "",
                };
              }
              return { code: 0, stdout: "https://example.cloudfront.net\n", stderr: "" };
            }
            if (args.includes("describe-user-pool-domain")) {
              capturedDomain = args[args.indexOf("--domain") + 1];
              return { code: 0, stdout: "ap-northeast-1_AbCdEf\n", stderr: "" };
            }
            if (args.includes("admin-get-user")) {
              // 未存在 → admin-create-user に進む
              return { code: 1, stdout: "", stderr: "UserNotFoundException" };
            }
            if (args.includes("admin-create-user")) {
              return { code: 0, stdout: "{}", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        const code = await main(["up"], io);
        expect(code).toBe(0);
        expect(capturedDomain).toBe("tc-app-prefix");
        const createCall = calls.find((c) => c.args.includes("admin-create-user"));
        expect(createCall).toBeDefined();
        const createArgs = createCall?.args.join(" ") ?? "";
        expect(createArgs).toContain("admin@example.com");
        expect(createArgs).toContain("Name=custom:userRole,Value=TenantAdmin");
        expect(createArgs).toContain("--user-pool-id");
        expect(createArgs).toContain("ap-northeast-1_AbCdEf");
      } finally {
        restoreEnv();
      }
    });

    it("admin-get-user が成功すれば既存 user として admin-create-user を呼ばないべき (idempotent)", async () => {
      process.env.TENANT_ADMIN_EMAIL = "admin@example.com";
      try {
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: (_cmd, args) => {
            if (args.includes("describe-stacks") && args.join(" ").includes("CognitoDomainUrl")) {
              return {
                code: 0,
                stdout: "https://tc-app-prefix.auth.ap-northeast-1.amazoncognito.com",
                stderr: "",
              };
            }
            if (args.includes("describe-stacks")) {
              return { code: 0, stdout: "https://example.cloudfront.net", stderr: "" };
            }
            if (args.includes("describe-user-pool-domain")) {
              return { code: 0, stdout: "ap-northeast-1_AbCdEf", stderr: "" };
            }
            if (args.includes("admin-get-user")) {
              // 既存 user
              return { code: 0, stdout: '{"Username":"admin@example.com"}', stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        await main(["up"], io);
        const createCall = calls.find((c) => c.args.includes("admin-create-user"));
        expect(createCall).toBeUndefined();
      } finally {
        restoreEnv();
      }
    });

    it("TENANT_ADMIN_EMAIL 未設定でも SYSTEM_ADMIN_EMAIL があれば fallback すべき", async () => {
      delete process.env.TENANT_ADMIN_EMAIL;
      process.env.SYSTEM_ADMIN_EMAIL = "system@example.com";
      try {
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: (_cmd, args) => {
            if (args.includes("describe-stacks") && args.join(" ").includes("CognitoDomainUrl")) {
              return {
                code: 0,
                stdout: "https://tc-app-prefix.auth.ap-northeast-1.amazoncognito.com",
                stderr: "",
              };
            }
            if (args.includes("describe-stacks")) {
              return { code: 0, stdout: "https://example.cloudfront.net", stderr: "" };
            }
            if (args.includes("describe-user-pool-domain")) {
              return { code: 0, stdout: "ap-northeast-1_AbCdEf", stderr: "" };
            }
            if (args.includes("admin-get-user")) {
              return { code: 1, stdout: "", stderr: "UserNotFoundException" };
            }
            if (args.includes("admin-create-user")) {
              return { code: 0, stdout: "{}", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        await main(["up"], io);
        const createCall = calls.find((c) => c.args.includes("admin-create-user"));
        expect(createCall).toBeDefined();
        expect(createCall?.args.join(" ")).toContain("system@example.com");
      } finally {
        restoreEnv();
      }
    });
  });
});
