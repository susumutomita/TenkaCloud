import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import { describe, expect, it } from "vitest";
import {
  type CliIO,
  LITE_STACK_NAMES,
  main,
  parseResolvedBucketName,
  parseStackOwnedCleanupResources,
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
  /** Issue 2992: Turso control-data 削除の結果を差し替える。 */
  readonly tursoPurgeExitCode?: number;
}): {
  readonly io: CliIO;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: SpawnCall[];
  readonly confirms: string[];
  readonly ensuredDirs: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: SpawnCall[] = [];
  const confirms: string[] = [];
  const ensuredDirs: string[] = [];
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
    purgeTursoControlData: async () => {
      calls.push({ cmd: "turso-reset", args: [], mode: "capture" });
      return opts.tursoPurgeExitCode ?? 0;
    },
    confirm: async (q) => {
      confirms.push(q);
      // unit test default: confirm pass-through (= 既存 down テストの flow を維持)。
      // confirmAnswer を明示指定したケースだけ override。
      return opts.confirmAnswer ?? true;
    },
    ensureDir: (dir) => {
      ensuredDirs.push(dir);
    },
  };
  return { io, stdout, stderr, calls, confirms, ensuredDirs };
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
    // bootstrap も deploy と同じ --app context を渡す。 これが無いと repo root に cdk.json が無く
    // "Specify an environment name ... or run in a directory with cdk.json" で失敗する
    // (= fresh-account Pipeline deploy を壊した regression の回帰防止)。
    expect(bootstrapCall.args).toContain("--app");
    expect(bootstrapCall.args.indexOf("--app")).toBeLessThan(
      bootstrapCall.args.indexOf("bootstrap"),
    );

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

  describe("parseStackOwnedCleanupResources (#2765)", () => {
    it("should return only exact table and log-group names derived from stack physical IDs", () => {
      const result = parseStackOwnedCleanupResources(
        JSON.stringify({
          StackResourceSummaries: [
            {
              LogicalResourceId: "EventsTable",
              PhysicalResourceId: "tenkacloud-lite-problem-deploy-Events-ABC",
              ResourceType: "AWS::DynamoDB::Table",
            },
            {
              LogicalResourceId: "DeployCodeBuildProject",
              PhysicalResourceId: "tenkacloud-lite-problem-deploy-DeployCodeBuild-XYZ",
              ResourceType: "AWS::CodeBuild::Project",
            },
            {
              LogicalResourceId: "DeployApiFunction",
              PhysicalResourceId: "tenkacloud-lite-problem-deploy-DeployApi-ABC",
              ResourceType: "AWS::Lambda::Function",
            },
            {
              LogicalResourceId: "DeployApiFunctionLogGroup",
              PhysicalResourceId: "/aws/lambda/tenkacloud-lite-explicit-log",
              ResourceType: "AWS::Logs::LogGroup",
            },
            {
              LogicalResourceId: "UnrelatedBucket",
              PhysicalResourceId: "tenkacloud-lite-assets",
              ResourceType: "AWS::S3::Bucket",
            },
          ],
        }),
      );

      expect(result).toEqual({
        tableNames: ["tenkacloud-lite-problem-deploy-Events-ABC"],
        logGroupNames: [
          "/aws/codebuild/tenkacloud-lite-problem-deploy-DeployCodeBuild-XYZ",
          "/aws/lambda/tenkacloud-lite-problem-deploy-DeployApi-ABC",
          "/aws/lambda/tenkacloud-lite-explicit-log",
        ],
      });
    });

    it("should fail closed when the CloudFormation response is malformed", () => {
      expect(parseStackOwnedCleanupResources("not-json")).toBeUndefined();
      expect(parseStackOwnedCleanupResources("{}")).toBeUndefined();
      expect(
        parseStackOwnedCleanupResources(
          JSON.stringify({
            StackResourceSummaries: [
              {
                LogicalResourceId: "EventsTable",
                ResourceType: "AWS::DynamoDB::Table",
              },
            ],
          }),
        ),
      ).toBeUndefined();
    });
  });

  it("up should early-return without calling cdk deploy when prepare-source-bundle.sh exits non-zero", async () => {
    // 1st spawn (= prepare-source-bundle.sh) で失敗させ、 2nd (= cdk deploy) は呼ばれないことを確認
    let firstCall = true;
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const io: CliIO = {
      stdout: () => undefined,
      stderr: () => undefined,
      purgeTursoControlData: async () => 0,
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

    it("up should print the onboarding drill deploy-complete checkpoint code (#2696)", async () => {
      const { io, stdout } = buildPostDeployIO();
      await main(["up"], io);
      const out = stdout.join("");
      expect(out).toContain("Onboarding drill");
      expect(out).toContain(LITE_DRILL_CHECKPOINTS.deployComplete.code);
      expect(out).toContain("自分の TenkaCloud Lite を立てる");
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

  // Issue #2444: 全 DDB テーブルは RemovalPolicy.RETAIN なので destroy 後も残存して
  // PROVISIONED 1/1 の standing cost を出し続ける。 down 完了時に残存テーブルを列挙して
  // 警告する (削除はしない)。
  it("down should warn about RETAIN-orphaned DynamoDB tables after teardown (#2444)", async () => {
    const { io, stdout } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) => {
        if (args.includes("list-tables")) {
          return {
            code: 0,
            stdout: '{"TableNames":["tenkacloud-lite-Deployments","unrelated-Table"]}',
            stderr: "",
          };
        }
        if (args.includes("describe-table")) {
          return {
            code: 0,
            stdout: '[{"IndexName":"GSI1"},{"IndexName":"GSI2"},{"IndexName":"GSI3"}]',
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const code = await main(["down"], io);
    expect(code).toBe(0);
    const out = stdout.join("");
    expect(out).toContain("RETAIN された DynamoDB テーブル");
    expect(out).toContain("tenkacloud-lite-Deployments (GSI 3 本)");
    expect(out).toContain("aws dynamodb delete-table --table-name tenkacloud-lite-Deployments");
  });

  it("down should stay silent about retained tables when none remain (#2444)", async () => {
    const { io, stdout } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) =>
        args.includes("list-tables")
          ? { code: 0, stdout: '{"TableNames":["unrelated-Table"]}', stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    const code = await main(["down"], io);
    expect(code).toBe(0);
    expect(stdout.join("")).not.toContain("RETAIN された DynamoDB");
  });

  it("down should not run the retained-table warning when a destroy fails (#2444)", async () => {
    const { io, calls } = buildIO({ inheritExitCode: 5 });
    const code = await main(["down"], io);
    // exit code は destroy の失敗コードのまま (warning が exit code を変えない)。
    expect(code).toBe(5);
    expect(calls.filter((c) => c.args.includes("list-tables"))).toHaveLength(0);
  });

  it("down --purge-retained-data should purge only stack-owned resources before destroying (#2765)", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) => {
        if (args.includes("list-stack-resources")) {
          const stackName = args[args.indexOf("--stack-name") + 1];
          return {
            code: 0,
            stdout: JSON.stringify({
              StackResourceSummaries:
                stackName === LITE_STACK_NAMES.app
                  ? [
                      {
                        PhysicalResourceId: "tenkacloud-lite-SamlIdps-APP",
                        ResourceType: "AWS::DynamoDB::Table",
                      },
                    ]
                  : [
                      {
                        PhysicalResourceId: "tenkacloud-lite-problem-deploy-Events-PROBLEM",
                        ResourceType: "AWS::DynamoDB::Table",
                      },
                      {
                        PhysicalResourceId: "tenkacloud-lite-problem-deploy-CodeBuild-PROJECT",
                        ResourceType: "AWS::CodeBuild::Project",
                      },
                      {
                        PhysicalResourceId: "tenkacloud-lite-problem-deploy-DeployApi-FUNCTION",
                        ResourceType: "AWS::Lambda::Function",
                      },
                      {
                        PhysicalResourceId: "/aws/vendedlogs/states/tenkacloud-lite-problem",
                        ResourceType: "AWS::Logs::LogGroup",
                      },
                    ],
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(0);
    const deleteTableCalls = calls.filter((call) => call.args.includes("delete-table"));
    expect(deleteTableCalls.map((call) => call.args.at(-1))).toEqual([
      "tenkacloud-lite-SamlIdps-APP",
      "tenkacloud-lite-problem-deploy-Events-PROBLEM",
    ]);
    const deleteLogGroupCall = calls.find((call) => call.args.includes("delete-log-group"));
    expect(deleteLogGroupCall?.args).toContain(
      "/aws/codebuild/tenkacloud-lite-problem-deploy-CodeBuild-PROJECT",
    );
    expect(
      calls.some(
        (call) =>
          call.args.includes("delete-log-group") &&
          call.args.includes("/aws/lambda/tenkacloud-lite-problem-deploy-DeployApi-FUNCTION"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args.includes("delete-log-group") &&
          call.args.includes("/aws/vendedlogs/states/tenkacloud-lite-problem"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.args.includes("list-tables"))).toBe(false);

    const lastPurgeAt = Math.max(
      ...calls
        .map((call, index) =>
          call.args.includes("table-not-exists") || call.args.includes("delete-log-group")
            ? index
            : -1,
        )
        .filter((index) => index >= 0),
    );
    const firstDestroyAt = calls.findIndex((call) => call.args.includes("destroy"));
    expect(lastPurgeAt).toBeLessThan(firstDestroyAt);
  });

  it("down --purge-retained-data should fail before mutation when ownership discovery fails (#2765)", async () => {
    const { io, calls, stderr } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) =>
        args.includes("list-stack-resources")
          ? { code: 4, stdout: "", stderr: "AccessDenied" }
          : { code: 0, stdout: "", stderr: "" },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(4);
    expect(calls.some((call) => call.args.includes("delete-table"))).toBe(false);
    expect(calls.some((call) => call.args.includes("delete-log-group"))).toBe(false);
    expect(calls.some((call) => call.args.includes("destroy"))).toBe(false);
    expect(stderr.join("")).toContain("ownership discovery failed");
  });

  it("down --purge-retained-data should stop before stack deletion when a table purge fails (#2765)", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) => {
        if (args.includes("list-stack-resources")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              StackResourceSummaries: [
                {
                  PhysicalResourceId: "tenkacloud-lite-Events-FAIL",
                  ResourceType: "AWS::DynamoDB::Table",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (args.includes("delete-table")) {
          return { code: 7, stdout: "", stderr: "AccessDeniedException" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(7);
    expect(calls.some((call) => call.args.includes("destroy"))).toBe(false);
  });

  it("down --purge-retained-data should treat already-missing captured resources as retry-safe (#2765)", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) => {
        if (args.includes("list-stack-resources")) {
          return {
            code: 0,
            stdout: JSON.stringify({
              StackResourceSummaries: [
                {
                  PhysicalResourceId: "tenkacloud-lite-Events-GONE",
                  ResourceType: "AWS::DynamoDB::Table",
                },
                {
                  PhysicalResourceId: "tenkacloud-lite-DeployProject-GONE",
                  ResourceType: "AWS::CodeBuild::Project",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (args.includes("delete-table") || args.includes("delete-log-group")) {
          return { code: 254, stdout: "", stderr: "ResourceNotFoundException" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(0);
    expect(calls.filter((call) => call.args.includes("destroy"))).toHaveLength(2);
  });

  it("down --purge-retained-data should retry safely when the first stack is already gone (#2765)", async () => {
    const { io, calls } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) => {
        if (args.includes("list-stack-resources")) {
          const stackName = args[args.indexOf("--stack-name") + 1];
          if (stackName === LITE_STACK_NAMES.app) {
            return {
              code: 255,
              stdout: "",
              stderr: `Stack with id ${stackName} does not exist`,
            };
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              StackResourceSummaries: [
                {
                  PhysicalResourceId: "tenkacloud-lite-Events-RETRY",
                  ResourceType: "AWS::DynamoDB::Table",
                },
              ],
            }),
            stderr: "",
          };
        }
        if (args.includes("delete-table")) {
          return { code: 254, stdout: "", stderr: "ResourceNotFoundException" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(0);
    expect(calls.some((call) => call.args.includes("delete-table"))).toBe(true);
    expect(calls.filter((call) => call.args.includes("destroy"))).toHaveLength(2);
  });

  it("down --purge-retained-data should fail closed when both ownership stacks are already absent (#2765)", async () => {
    const { io, calls, stderr } = buildIO({
      inheritExitCode: 0,
      capture: (_cmd, args) =>
        args.includes("list-stack-resources")
          ? { code: 255, stdout: "", stderr: "Stack does not exist" }
          : { code: 0, stdout: "", stderr: "" },
    });

    const code = await main(["down", "--purge-retained-data", "--yes"], io);

    expect(code).toBe(1);
    expect(calls.some((call) => call.args.includes("destroy"))).toBe(false);
    expect(stderr.join("")).toContain("ownership cannot be proven");
  });

  it("down --purge-retained-data should remove the exact legacy launcher log only after managed logging is enabled (#2765)", async () => {
    const previous = process.env.TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP;
    process.env.TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP = "1";
    try {
      const { io, calls } = buildIO({
        inheritExitCode: 0,
        capture: (_cmd, args) =>
          args.includes("list-stack-resources")
            ? {
                code: 0,
                stdout: JSON.stringify({ StackResourceSummaries: [] }),
                stderr: "",
              }
            : { code: 0, stdout: "", stderr: "" },
      });

      const code = await main(["down", "--purge-retained-data", "--yes"], io);

      expect(code).toBe(0);
      const logDelete = calls.find((call) => call.args.includes("delete-log-group"));
      expect(logDelete?.args).toContain("/aws/codebuild/tenkacloud-lite-development");
    } finally {
      if (previous === undefined) {
        delete process.env.TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP;
      } else {
        process.env.TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP = previous;
      }
    }
  });

  // Regression: `cdk destroy` synths the shared CDK app (bin/tenkacloud-lite.ts ->
  // requireSystemAdminEmail), so teardown needs CDK_PARAM_SYSTEM_ADMIN_EMAIL just like
  // deploy. With only TENANT_ADMIN_EMAIL set (the .env the CodeBuild launcher writes),
  // `down` must derive it; otherwise destroy throws "Please provide system admin email".
  it("down should derive CDK_PARAM_SYSTEM_ADMIN_EMAIL from TENANT_ADMIN_EMAIL so destroy can synth", async () => {
    const prev = {
      cdk: process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL,
      sys: process.env.SYSTEM_ADMIN_EMAIL,
      tenant: process.env.TENANT_ADMIN_EMAIL,
    };
    delete process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
    delete process.env.SYSTEM_ADMIN_EMAIL;
    process.env.TENANT_ADMIN_EMAIL = "organizer@example.com";
    try {
      const { io } = buildIO({ inheritExitCode: 0 });
      await main(["down"], io);
      expect(process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL).toBe("organizer@example.com");
    } finally {
      if (prev.cdk === undefined) delete process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
      else process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL = prev.cdk;
      if (prev.sys === undefined) delete process.env.SYSTEM_ADMIN_EMAIL;
      else process.env.SYSTEM_ADMIN_EMAIL = prev.sys;
      if (prev.tenant === undefined) delete process.env.TENANT_ADMIN_EMAIL;
      else process.env.TENANT_ADMIN_EMAIL = prev.tenant;
    }
  });

  it("down should not override an explicit CDK_PARAM_SYSTEM_ADMIN_EMAIL (SaaS-shared env)", async () => {
    const prev = {
      cdk: process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL,
      tenant: process.env.TENANT_ADMIN_EMAIL,
    };
    process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL = "admin@example.com";
    process.env.TENANT_ADMIN_EMAIL = "organizer@example.com";
    try {
      const { io } = buildIO({ inheritExitCode: 0 });
      await main(["down"], io);
      expect(process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL).toBe("admin@example.com");
    } finally {
      if (prev.cdk === undefined) delete process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL;
      else process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL = prev.cdk;
      if (prev.tenant === undefined) delete process.env.TENANT_ADMIN_EMAIL;
      else process.env.TENANT_ADMIN_EMAIL = prev.tenant;
    }
  });

  // Regression: cdk destroy synths the app, which stages apps/participant-portal/dist and
  // apps/application-admin-console/dist as BucketDeployment assets. Teardown never builds
  // the SPAs, so `down` must create the placeholder dirs or synth throws CannotFindAsset.
  it("down should ensure the SPA dist dirs exist before destroying (CannotFindAsset)", async () => {
    const { io, ensuredDirs } = buildIO({ inheritExitCode: 0 });
    await main(["down"], io);
    expect(ensuredDirs.some((d) => d.endsWith("apps/participant-portal/dist"))).toBe(true);
    expect(ensuredDirs.some((d) => d.endsWith("apps/application-admin-console/dist"))).toBe(true);
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

/**
 * Turso backend の control-data teardown (Issue 2992)。
 *
 * DynamoDB backend では table が stack の持ち物なので、 stack を消せば control-data も消える。
 * Turso backend は database が AWS の外にあるため、 stack を全部消しても event / team /
 * deployment の行がそのまま残る。 実測で destroy 完了後に残っていた。
 *
 * ここで固定するのは 2 点。 destroy-all では実際に消すこと。 通常の destroy では消さない
 * 代わりに黙らないこと。 後者が無いと、 運営は「全部消えた」と読んで気づけない。
 */
describe("down: Turso control-data (Issue 2992)", () => {
  const TURSO_ENV = {
    CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    TENKACLOUD_LITE_DOWN_YES: "1",
  } as const;

  /**
   * `--purge-retained-data` は先に stack-owned resource を列挙する。 stub が無いと
   * discovery が失敗して exit 1 になり、 Turso の検証がその手前で潰れる。 ここでは
   * Turso 側だけを見たいので、 AWS 資源は「無い」と答える。
   */
  const noStackResources = (_cmd: string, args: readonly string[]) =>
    args.includes("list-stack-resources")
      ? { code: 0, stdout: JSON.stringify({ StackResourceSummaries: [] }), stderr: "" }
      : { code: 0, stdout: "", stderr: "" };

  /** env を差し替えて down を走らせ、必ず元に戻す。 */
  async function runDown(args: readonly string[], env: Record<string, string>, io: CliIO) {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(env)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      return await main(["down", ...args], io);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("destroy-all should purge Turso control-data before deleting the stacks", async () => {
    const { io, calls } = buildIO({ confirmAnswer: true, capture: noStackResources });
    const code = await runDown(["--yes", "--purge-retained-data"], { ...TURSO_ENV }, io);
    expect(code).toBe(0);
    const purgeIndex = calls.findIndex((c) => c.cmd === "turso-reset");
    expect(purgeIndex).toBeGreaterThanOrEqual(0);
    // stack 削除より前であること。 auth token は stack が作る SSM parameter から読むので、
    // 先に stack を消すと認証手段ごと消えて削除できなくなる。
    const firstDestroy = calls.findIndex((c) => c.args.includes("destroy"));
    expect(firstDestroy).toBeGreaterThanOrEqual(0);
    expect(purgeIndex).toBeLessThan(firstDestroy);
  });

  it("destroy-all should abort when the Turso purge fails", async () => {
    // 消せていないのに成功扱いにすると、 運営は片付いたと信じて残骸に気づけない。
    const { io, calls } = buildIO({
      confirmAnswer: true,
      capture: noStackResources,
      tursoPurgeExitCode: 3,
    });
    const code = await runDown(["--yes", "--purge-retained-data"], { ...TURSO_ENV }, io);
    expect(code).toBe(3);
    expect(calls.some((c) => c.args.includes("destroy"))).toBe(false);
  });

  it("plain destroy should not purge, but must say the rows survive", async () => {
    const { io, calls, stdout } = buildIO({ confirmAnswer: true });
    const code = await runDown(["--yes"], { ...TURSO_ENV }, io);
    expect(code).toBe(0);
    expect(calls.some((c) => c.cmd === "turso-reset")).toBe(false);
    const text = stdout.join("");
    expect(text).toContain("turso-reset");
    expect(text).toContain("残ります");
  });

  it("should stay silent about Turso on a DynamoDB-backend teardown", async () => {
    const { io, calls, stdout } = buildIO({ confirmAnswer: true });
    const code = await runDown(
      ["--yes"],
      { CDK_PARAM_CONTROL_DATA_BACKEND: "dynamodb", TENKACLOUD_LITE_DOWN_YES: "1" },
      io,
    );
    expect(code).toBe(0);
    expect(calls.some((c) => c.cmd === "turso-reset")).toBe(false);
    expect(stdout.join("")).not.toContain("turso-reset");
  });
});
