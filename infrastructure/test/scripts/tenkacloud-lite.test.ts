import { describe, expect, it } from "vitest";
import {
  type CliIO,
  LITE_STACK_NAMES,
  main,
  parseResolvedBucketName,
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
  readonly confirmAnswer?: boolean;
}): {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: SpawnCall[];
  readonly confirms: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: SpawnCall[] = [];
  const confirms: string[] = [];
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
    confirm: async (q) => {
      confirms.push(q);
      // unit test default: confirm pass-through (= 既存 down テストの flow を維持)。
      // confirmAnswer を明示指定したケースだけ override。
      return opts.confirmAnswer ?? true;
    },
  };
  return { io, stdout, stderr, calls, confirms };
}

function tenantAdminUpCapture(opts: {
  readonly adminGetUserCode: number;
  readonly onDomain?: (domain: string | undefined) => void;
}): (_cmd: string, args: readonly string[]) => SpawnCaptureResult {
  return (_cmd, args) => {
    if (args.includes("describe-stacks")) return describeStackCapture(args);
    if (args.includes("describe-user-pool-domain")) {
      opts.onDomain?.(args[args.indexOf("--domain") + 1]);
      return { code: 0, stdout: "ap-northeast-1_AbCdEf\n", stderr: "" };
    }
    if (args.includes("admin-get-user")) {
      return opts.adminGetUserCode === 0
        ? { code: 0, stdout: '{"Username":"admin@example.com"}', stderr: "" }
        : { code: 1, stdout: "", stderr: "UserNotFoundException" };
    }
    if (args.includes("admin-create-user")) return { code: 0, stdout: "{}", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

function describeStackCapture(args: readonly string[]): SpawnCaptureResult {
  if (args.join(" ").includes("CognitoDomainUrl")) {
    return {
      code: 0,
      stdout: "https://tc-app-prefix.auth.ap-northeast-1.amazoncognito.com\n",
      stderr: "",
    };
  }
  return { code: 0, stdout: "https://example.cloudfront.net\n", stderr: "" };
}

describe("tenkacloud-lite CLI (#778 ADR-016 Phase 4)", () => {
  it("should print help and exit 0 on no-arg / help / -h / --help", async () => {
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

  it("should exit 1 + print a message to stderr + show help on unknown subcommand", async () => {
    const { io, stdout, stderr } = buildIO({});
    const code = await main(["frobnicate"], io);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Unknown subcommand: frobnicate");
    expect(stdout.join("")).toContain("使い方:");
  });

  it("up should invoke prepare-source-bundle.sh, cdk bootstrap, then cdk deploy in order via inherit", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: () => ({ code: 0, stdout: "https://example.cloudfront.net", stderr: "" }),
    });
    const code = await main(["up"], io);
    expect(code).toBe(0);
    const inheritCalls = calls.filter((c) => c.mode === "inherit");
    // prepare-source-bundle.sh (= source.zip prep) → cdk bootstrap (= まっさらアカウント
    // 対応、 冪等) → cdk deploy の 3 call
    expect(inheritCalls).toHaveLength(3);

    const prepCall = inheritCalls[0];
    expect(prepCall.cmd).toBe("bash");
    expect(prepCall.args).toContain("scripts/prepare-source-bundle.sh");

    // deploy 前に必ず cdk bootstrap (冪等) を回し、 fresh account でも make deploy が通るようにする。
    const bootstrapCall = inheritCalls[1];
    expect(bootstrapCall.cmd).toBe("./node_modules/aws-cdk/bin/cdk");
    expect(bootstrapCall.args).toContain("bootstrap");

    const deployCall = inheritCalls[2];
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

  // Issue #1789: source bucket 取り違え修正。 cmdUp は prepare-source-bundle.sh の
  // RESOLVE_ONLY 出力から account-scoped bucket を解決し、 bundle upload + cdk deploy より
  // 前に CDK_PARAM_S3_BUCKET_NAME へ固定して upload 先 / read 先を一致させる。
  it("up should pin CDK_PARAM_S3_BUCKET_NAME from RESOLVE_ONLY before cdk deploy (#1789)", async () => {
    const bucket = "tenkacloud-source-111122223333-ap-northeast-1";
    const prevBucket = process.env.CDK_PARAM_S3_BUCKET_NAME;
    const prevToggle = process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
    delete process.env.CDK_PARAM_S3_BUCKET_NAME;
    delete process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;

    let toggleDuringResolve: string | undefined;
    const { io } = buildIO({
      inheritExitCode: 0,
      capture: (cmd, args) => {
        if (cmd === "bash" && args.includes("scripts/prepare-source-bundle.sh")) {
          // RESOLVE_ONLY toggle はこの capture 実行中だけ立っているはず。
          toggleDuringResolve = process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
          return {
            code: 0,
            stdout:
              `REGION=ap-northeast-1\nACCOUNT_ID=111122223333\n` +
              `CDK_PARAM_S3_BUCKET_NAME=${bucket}\nCDK_SOURCE_NAME=source.zip\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "https://example.cloudfront.net", stderr: "" };
      },
    });

    try {
      const code = await main(["up"], io);
      expect(code).toBe(0);
      expect(toggleDuringResolve).toBe("1");
      // 本番 prepare + cdk deploy が読む env が account-scoped bucket に固定される。
      expect(process.env.CDK_PARAM_S3_BUCKET_NAME).toBe(bucket);
      // RESOLVE_ONLY toggle は後始末されて漏れない。
      expect(process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBeUndefined();
    } finally {
      if (prevBucket === undefined) delete process.env.CDK_PARAM_S3_BUCKET_NAME;
      else process.env.CDK_PARAM_S3_BUCKET_NAME = prevBucket;
      if (prevToggle === undefined) delete process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
      else process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY = prevToggle;
    }
  });

  describe("parseResolvedBucketName (#1789)", () => {
    it("extracts CDK_PARAM_S3_BUCKET_NAME from RESOLVE_ONLY output", () => {
      const out =
        "REGION=ap-northeast-1\nACCOUNT_ID=111122223333\n" +
        "CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-111122223333-ap-northeast-1\nCDK_SOURCE_NAME=source.zip\n";
      expect(parseResolvedBucketName(out)).toBe("tenkacloud-source-111122223333-ap-northeast-1");
    });

    it("returns undefined when the key is absent or empty", () => {
      expect(parseResolvedBucketName("REGION=ap-northeast-1\nACCOUNT_ID=1\n")).toBeUndefined();
      expect(parseResolvedBucketName("CDK_PARAM_S3_BUCKET_NAME=\n")).toBeUndefined();
      expect(parseResolvedBucketName("")).toBeUndefined();
    });
  });

  it("up should early-return without calling cdk deploy when prepare-source-bundle.sh exits non-zero", async () => {
    // 1st spawn (= prepare-source-bundle.sh) で失敗させ、 2nd (= cdk deploy) は呼ばれないことを確認
    let firstCall = true;
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const io: CliIO = {
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
      confirm: async () => true,
    };
    const code = await main(["up"], io);
    expect(code).toBe(1);
    // prepare 呼び出しだけで cdk deploy は呼ばない
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("bash");
  });

  it("up should early-return without calling AWS CLI when cdk deploy exits non-zero", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 2 });
    const code = await main(["up"], io);
    expect(code).toBe(2);
    expect(calls.filter((c) => c.cmd === "aws")).toHaveLength(0);
  });

  // Issue #1345: deploy 失敗時は「次のステップ」 を stderr に出して user の次の動作を導く。
  it("up should print a failure guide to stderr when prepare-source-bundle.sh fails (#1345)", async () => {
    let firstCall = true;
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const stderrChunks: string[] = [];
    const io: CliIO = {
      stdout: () => undefined,
      stderr: (text) => stderrChunks.push(text),
      spawnInherit: async (cmd, args) => {
        calls.push({ cmd, args });
        if (firstCall) {
          firstCall = false;
          return 1;
        }
        return 0;
      },
      spawnCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
      confirm: async () => true,
    };
    const code = await main(["up"], io);
    expect(code).toBe(1);
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("次のステップ");
    expect(stderr).toContain("make destroy");
    expect(stderr).toContain("再実行");
  });

  // Issue #1345: deploy 成功時は post-deploy guide を stdout に出して 30-min 体験を完結させる。
  // 3 つの観測 (banner / URLs / next-steps + progress 表記) に it を分割して assertion roulette を避ける。
  describe("up post-deploy guide (#1345)", () => {
    function buildPostDeployIO(): ReturnType<typeof buildIO> {
      return buildIO({
        inheritExitCode: 0,
        capture: (_cmd, args) => {
          if (args.join(" ").includes("ApplicationAdminConsoleUrl")) {
            return { code: 0, stdout: "https://console.example.cloudfront.net\n", stderr: "" };
          }
          if (args.join(" ").includes("ParticipantPortalApiUrl")) {
            return { code: 0, stdout: "https://portal.example.cloudfront.net\n", stderr: "" };
          }
          if (args.includes("describe-user-pool-domain")) {
            return { code: 0, stdout: "ap-northeast-1_AbCdEf\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      });
    }

    it("up should print a success banner and resolved access URLs", async () => {
      const { io, stdout } = buildPostDeployIO();
      const code = await main(["up"], io);
      expect(code).toBe(0);
      const out = stdout.join("");
      expect(out).toContain("Lite mode deploy complete");
      expect(out).toContain("https://console.example.cloudfront.net");
      expect(out).toContain("https://portal.example.cloudfront.net");
    });

    it("up should print next-steps + teardown guidance after deploy", async () => {
      const { io, stdout } = buildPostDeployIO();
      await main(["up"], io);
      const out = stdout.join("");
      expect(out).toContain("Next steps");
      expect(out).toContain("hello-world");
      expect(out).toContain("Teardown");
    });

    it("up should number each phase as [i/4] progress markers", async () => {
      const { io, stdout } = buildPostDeployIO();
      await main(["up"], io);
      const out = stdout.join("");
      expect(out).toContain("[1/4]");
      expect(out).toContain("[2/4]");
      expect(out).toContain("[3/4]");
      expect(out).toContain("[4/4]");
    });
  });

  it("down should destroy the app stack first and then the problem-deploy stack", async () => {
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

  // Issue #1345: destroy 前に y/N 確認 prompt を入れる。 first-run user が誤爆して
  // DB データを消すのを防ぐ。 `--yes` で bypass 可能。
  it("down should ask for confirmation before destroying (#1345)", async () => {
    const { io, calls, confirms } = buildIO({
      inheritExitCode: 0,
      confirmAnswer: true,
    });
    const code = await main(["down"], io);
    expect(code).toBe(0);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("続行しますか");
    const destroyCalls = calls.filter((c) => c.args.includes("destroy"));
    expect(destroyCalls).toHaveLength(2);
  });

  it("down should abort without calling destroy when user answers N (#1345)", async () => {
    const { io, calls, stdout, confirms } = buildIO({
      inheritExitCode: 0,
      confirmAnswer: false,
    });
    const code = await main(["down"], io);
    expect(code).toBe(0);
    expect(confirms).toHaveLength(1);
    const destroyCalls = calls.filter((c) => c.args.includes("destroy"));
    expect(destroyCalls).toHaveLength(0);
    expect(stdout.join("")).toContain("aborted");
  });

  it("down --yes should bypass the confirmation prompt (#1345)", async () => {
    const { io, calls, confirms } = buildIO({
      inheritExitCode: 0,
      confirmAnswer: false,
    });
    const code = await main(["down", "--yes"], io);
    expect(code).toBe(0);
    expect(confirms).toHaveLength(0);
    const destroyCalls = calls.filter((c) => c.args.includes("destroy"));
    expect(destroyCalls).toHaveLength(2);
  });

  it("down should return the same exit code without calling the second destroy when the first one fails", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 3 });
    const code = await main(["down"], io);
    expect(code).toBe(3);
    expect(calls.filter((c) => c.args.includes("destroy"))).toHaveLength(1);
  });

  it("portal-url should query the problem-deploy stack's ParticipantPortalApiUrl output via describe-stacks", async () => {
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

  it("console-url should query the AppPlane stack's ApplicationAdminConsoleUrl output", async () => {
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

  it("should print not found to stderr and return exit 1 when output is empty", async () => {
    const { io, stderr } = buildIO({
      capture: () => ({ code: 0, stdout: "  \n", stderr: "" }),
    });
    const code = await main(["portal-url"], io);
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not found");
  });

  it("should surface status as NOT_DEPLOYED when describe-stacks exits non-zero", async () => {
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

  it("status should print describe-stacks results one line at a time to stdout", async () => {
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

    it("should let deploy pass without calling admin-create-user when TENANT_ADMIN_EMAIL is empty", async () => {
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

    it("should call describe-user-pool-domain → admin-get-user → admin-create-user in order when TENANT_ADMIN_EMAIL is set", async () => {
      process.env.TENANT_ADMIN_EMAIL = "admin@example.com";
      try {
        let capturedDomain: string | undefined;
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: tenantAdminUpCapture({
            adminGetUserCode: 1,
            onDomain: (domain) => {
              capturedDomain = domain;
            },
          }),
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

    it("should not call admin-create-user when admin-get-user succeeds (idempotent)", async () => {
      process.env.TENANT_ADMIN_EMAIL = "admin@example.com";
      try {
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: tenantAdminUpCapture({ adminGetUserCode: 0 }),
        });
        await main(["up"], io);
        const createCall = calls.find((c) => c.args.includes("admin-create-user"));
        expect(createCall).toBeUndefined();
      } finally {
        restoreEnv();
      }
    });

    it("should fall back to SYSTEM_ADMIN_EMAIL when TENANT_ADMIN_EMAIL is unset", async () => {
      delete process.env.TENANT_ADMIN_EMAIL;
      process.env.SYSTEM_ADMIN_EMAIL = "system@example.com";
      try {
        const { io, calls } = buildIO({
          inheritExitCode: 0,
          capture: tenantAdminUpCapture({ adminGetUserCode: 1 }),
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

  // The shared CDK app (bin/tenkacloud-lite.ts -> resolveAppConfig ->
  // requireSystemAdminEmail) requires CDK_PARAM_SYSTEM_ADMIN_EMAIL. Lite mode must
  // derive it from the tenant admin email so `make deploy` works with only
  // TENANT_ADMIN_EMAIL set; otherwise cdk deploy throws "Please provide system
  // admin email" (the CodeBuild Lite-pipeline failure).
  describe("up should wire CDK_PARAM_SYSTEM_ADMIN_EMAIL for cdk deploy", () => {
    const original = {
      tenant: process.env.TENANT_ADMIN_EMAIL,
      system: process.env.SYSTEM_ADMIN_EMAIL,
      cdkSystem: process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL,
    };

    function restore(): void {
      const entries: ReadonlyArray<readonly [string, string | undefined]> = [
        ["TENANT_ADMIN_EMAIL", original.tenant],
        ["SYSTEM_ADMIN_EMAIL", original.system],
        ["CDK_PARAM_SYSTEM_ADMIN_EMAIL", original.cdkSystem],
      ];
      for (const [key, value] of entries) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    function captureSystemEmailAtCdkSpawn(): {
      readonly io: CliIO;
      seen: () => string | undefined;
    } {
      let seenAtCdk: string | undefined;
      const { io } = buildIO({
        inheritExitCode: 0,
        capture: tenantAdminUpCapture({ adminGetUserCode: 0 }),
      });
      const wrapped: CliIO = {
        ...io,
        spawnInherit: async (cmd, args) => {
          if (cmd.includes("cdk")) seenAtCdk = process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
          return io.spawnInherit(cmd, args);
        },
      };
      return { io: wrapped, seen: () => seenAtCdk };
    }

    it("should derive it from TENANT_ADMIN_EMAIL when unset", async () => {
      process.env.TENANT_ADMIN_EMAIL = "organizer@example.com";
      delete process.env.SYSTEM_ADMIN_EMAIL;
      delete process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
      try {
        const { io, seen } = captureSystemEmailAtCdkSpawn();
        const code = await main(["up"], io);
        expect(code).toBe(0);
        expect(seen()).toBe("organizer@example.com");
      } finally {
        restore();
      }
    });

    it("should not override an explicit CDK_PARAM_SYSTEM_ADMIN_EMAIL (SaaS-shared env)", async () => {
      process.env.TENANT_ADMIN_EMAIL = "organizer@example.com";
      process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL = "sysadmin@example.com";
      try {
        const { io, seen } = captureSystemEmailAtCdkSpawn();
        await main(["up"], io);
        expect(seen()).toBe("sysadmin@example.com");
      } finally {
        restore();
      }
    });
  });
});
