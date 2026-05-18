#!/usr/bin/env bun
/**
 * Issue #778 ADR-016 Phase 4: TenkaCloud Lite mode の CLI runner。
 *
 * SBT / Pipeline / 動的 tenant 作成のフル機能を持ち込まずに、 「TenkaCloud を試したい」
 * 開発者が 1 コマンドで AWS account に最小 stack を deploy できる体験を提供する。
 *
 * 使い方:
 *   bun run scripts/tenkacloud-lite.ts up          — Lite stack を deploy + URL を表示
 *   bun run scripts/tenkacloud-lite.ts down        — Lite stack を destroy
 *   bun run scripts/tenkacloud-lite.ts portal-url  — Participant Portal URL を表示
 *   bun run scripts/tenkacloud-lite.ts console-url — Application Admin Console URL を表示
 *   bun run scripts/tenkacloud-lite.ts status      — 両 stack の状態を表示
 *
 * 設計判断:
 *   - `cdk deploy` / `cdk destroy` を spawn する形 (= AWS SDK で自前実装しない)。
 *     CDK の deploy 進捗 UI を そのまま見せた方が初見者に親切。
 *   - CFn outputs の読み取りは AWS CLI を spawn する (= bun の依存に
 *     `@aws-sdk/client-cloudformation` を増やさない、 操作が単純な read のみ)。
 *   - stack 名は固定 (`tenkacloud-lite` + `tenkacloud-lite-problem-deploy`)。
 *     Lite は 1 deploy = 1 stack 集合の前提なので環境別の suffix は持たない。
 *   - bin/infrastructure.ts は touch しない。 Lite stack の wiring は別 bin entry
 *     (`infrastructure/bin/tenkacloud-lite.ts`、 Phase 5 で追加) が担う想定。
 *     本 PR では CLI 単体の scaffold + Makefile target のみ。
 *
 * テスト容易性のため `main` を export し、 spawn 系を injectable にしている (= unit test
 * から AWS や CDK を実行せずに subcommand dispatch / help / unknown を観測する)。
 */

import { spawn } from "node:child_process";

export const LITE_STACK_NAMES = {
  app: "tenkacloud-lite",
  problemDeploy: "tenkacloud-lite-problem-deploy",
} as const;

// cdk.json と同じ tsx loader を使う。 ts-node は `./foo.js` → `./foo.ts` の
// extension rewrite を CommonJS 文脈で解決できず、 `endpoints-metadata.ts` 等の
// ESM-style import (`./env-encoding.js`) で MODULE_NOT_FOUND になる。
const CDK_OPTS = ["--app", "bunx tsx infrastructure/bin/tenkacloud-lite.ts"];

export interface SpawnCaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly spawnInherit: (cmd: string, args: readonly string[]) => Promise<number>;
  readonly spawnCapture: (cmd: string, args: readonly string[]) => Promise<SpawnCaptureResult>;
}

interface CommandSpec {
  readonly help: string;
  readonly run: (args: readonly string[], io: CliIO) => Promise<number>;
}

const COMMANDS: Record<string, CommandSpec> = {
  up: {
    help: "Lite stack 2 個 (= AppPlane + ProblemDeploy) を deploy し、 完了時に Console / Portal URL を表示する。",
    run: cmdUp,
  },
  down: {
    help: "Lite stack 2 個を destroy する。 RemovalPolicy=DESTROY が効いていれば S3 / DDB 含めて削除される。",
    run: cmdDown,
  },
  "portal-url": {
    help: "Participant Portal の CloudFront URL を CFn output から取得して標準出力する。",
    run: (_args, io) =>
      readOutput(LITE_STACK_NAMES.problemDeploy, "ParticipantPortalApiUrl", "", io),
  },
  "console-url": {
    help: "Application Admin Console の CloudFront URL を CFn output から取得して標準出力する。",
    run: (_args, io) => readOutput(LITE_STACK_NAMES.app, "ApplicationAdminConsoleUrl", "", io),
  },
  status: {
    help: "両 stack の CFn StackStatus を 1 行で表示する。",
    run: cmdStatus,
  },
};

export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "-h" || subcommand === "--help" || subcommand === "help") {
    printHelp(io);
    return 0;
  }
  const spec = COMMANDS[subcommand];
  if (!spec) {
    io.stderr(`Unknown subcommand: ${subcommand}\n\n`);
    printHelp(io);
    return 1;
  }
  return spec.run(argv.slice(1), io);
}

function printHelp(io: CliIO): void {
  io.stdout("tenkacloud lite — TenkaCloud Lite mode の CLI runner (Issue #778 Phase 4)\n\n");
  io.stdout("使い方:\n");
  io.stdout("  bun run scripts/tenkacloud-lite.ts <subcommand>\n");
  io.stdout("  make lite-<subcommand>\n\n");
  io.stdout("subcommand:\n");
  for (const [name, spec] of Object.entries(COMMANDS)) {
    io.stdout(`  ${name.padEnd(14)} ${spec.help}\n`);
  }
  io.stdout("\n");
  io.stdout(
    "Phase 4 scope (本 PR): CLI scaffold + Makefile target。 実 AWS deploy 経路は\n" +
      "Phase 5 で追加する `infrastructure/bin/tenkacloud-lite.ts` (= bin entry) と組み合わせて完成する。\n",
  );
}

async function cmdUp(_args: readonly string[], io: CliIO): Promise<number> {
  // Issue #955 follow-up: Lite mode は SBT ControlPlane と provision-tenant.sh を持たないため、
  // tenant admin user を別経路で作る必要がある。 deploy 後に Cognito UserPool ID を
  // domain output から逆引き → admin-create-user 1 回で済ませる (idempotent)。
  // TENANT_ADMIN_EMAIL は env-check-lite で必須化されているので process.env から拾える。
  // TENANT_ADMIN_EMAIL を優先、 未設定なら SYSTEM_ADMIN_EMAIL に fallback (= SaaS mode と
  // env 共用したい運用向け)。 どちらも空なら警告して deploy 自体は続行する。
  const tenantAdminEmail = (
    process.env.TENANT_ADMIN_EMAIL ??
    process.env.SYSTEM_ADMIN_EMAIL ??
    ""
  ).trim();
  if (!tenantAdminEmail) {
    io.stderr(
      "[lite] TENANT_ADMIN_EMAIL / SYSTEM_ADMIN_EMAIL is not set. Set it in infrastructure/environments/<env>/.env\n" +
        "[lite] (deploy はしますが、 完了後に手動で admin-create-user する必要があります)\n",
    );
  }

  // ProblemDeployBackendStack 内の DeployCodeBuildProject が `<bucket>/source.zip` を参照
  // するため、 cdk deploy 前に source bundle を upload する。 SaaS install.sh と同じ shared
  // shell (prepare-source-bundle.sh) を呼ぶ (= bash 1 source of truth、 SBT 制約下で host /
  // CodeBuild 双方が読める形を維持)。 OO refactor (= TypeScript SourceBundle class 化) は
  // 別 follow-up issue で扱う。
  io.stdout("[lite] preparing source bundle (= bucket + source.zip)...\n");
  const prepCode = await io.spawnInherit("bash", ["scripts/prepare-source-bundle.sh"]);
  if (prepCode !== 0) {
    io.stderr(`[lite] prepare-source-bundle.sh failed with exit code ${prepCode}\n`);
    return prepCode;
  }

  io.stdout("[lite] deploying 2 stacks (= AppPlane + ProblemDeploy)...\n");
  const code = await io.spawnInherit("bunx", [
    "cdk",
    ...CDK_OPTS,
    "deploy",
    LITE_STACK_NAMES.problemDeploy,
    LITE_STACK_NAMES.app,
    "--require-approval",
    "never",
  ]);
  if (code !== 0) {
    io.stderr(`[lite] cdk deploy failed with exit code ${code}\n`);
    return code;
  }
  io.stdout("\n[lite] deploy complete. URLs:\n");
  await readOutput(
    LITE_STACK_NAMES.app,
    "ApplicationAdminConsoleUrl",
    "  Application Admin Console: ",
    io,
  );
  await readOutput(
    LITE_STACK_NAMES.problemDeploy,
    "ParticipantPortalApiUrl",
    "  Participant Portal:        ",
    io,
  );

  // Tenant Admin user を Cognito に作る (= 初回 sign-in のため)。
  if (tenantAdminEmail) {
    const created = await ensureTenantAdminUser(tenantAdminEmail, io);
    if (created !== 0) {
      io.stderr(
        "[lite] admin-create-user failed. CognitoDomainUrl output が見えない / IAM 権限不足が原因の可能性があります。\n" +
          "[lite] 手動で以下を実行してください:\n" +
          "[lite]   aws cognito-idp list-user-pools --max-results 60\n" +
          "[lite]   aws cognito-idp admin-create-user --user-pool-id <id> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=True --desired-delivery-mediums EMAIL\n",
      );
    }
  }
  return 0;
}

/**
 * Lite mode の Tenant Admin user を Cognito に登録する。 idempotent:
 *   1. CognitoDomainUrl output から domain prefix を抜き出す
 *   2. describe-user-pool-domain で UserPool ID を解決
 *   3. admin-get-user で重複 check → 既存なら skip、 無ければ admin-create-user
 *
 * 失敗時は 0 以外を返し、 呼び出し側で手動手順を案内する。
 */
async function ensureTenantAdminUser(email: string, io: CliIO): Promise<number> {
  const domainUrl = await readStackOutput(LITE_STACK_NAMES.app, "CognitoDomainUrl", io);
  if (!domainUrl) {
    io.stderr("[lite] CognitoDomainUrl output not found\n");
    return 1;
  }
  // `https://<prefix>.auth.<region>.amazoncognito.com` から prefix を抽出。
  const match = domainUrl.match(/^https?:\/\/([^.]+)\.auth\./);
  if (!match || !match[1]) {
    io.stderr(`[lite] failed to parse CognitoDomainUrl: ${domainUrl}\n`);
    return 1;
  }
  const domainPrefix = match[1];

  const describeOut = await io.spawnCapture("aws", [
    "cognito-idp",
    "describe-user-pool-domain",
    "--domain",
    domainPrefix,
    "--query",
    "DomainDescription.UserPoolId",
    "--output",
    "text",
  ]);
  const userPoolId = describeOut.stdout.trim();
  if (describeOut.code !== 0 || !userPoolId || userPoolId === "None") {
    io.stderr(`[lite] describe-user-pool-domain failed: ${describeOut.stderr}\n`);
    return describeOut.code === 0 ? 1 : describeOut.code;
  }

  // 既存 user の有無を check (= 重複作成で UsernameExistsException にならないよう)。
  const checkOut = await io.spawnCapture("aws", [
    "cognito-idp",
    "admin-get-user",
    "--user-pool-id",
    userPoolId,
    "--username",
    email,
  ]);
  if (checkOut.code === 0) {
    io.stdout(`\n[lite] Tenant Admin already exists: ${email} (skip)\n`);
    return 0;
  }

  io.stdout(`\n[lite] creating Tenant Admin: ${email}\n`);
  const createOut = await io.spawnCapture("aws", [
    "cognito-idp",
    "admin-create-user",
    "--user-pool-id",
    userPoolId,
    "--username",
    email,
    "--user-attributes",
    `Name=email,Value=${email}`,
    "Name=email_verified,Value=True",
    "Name=custom:userRole,Value=TenantAdmin",
    "Name=custom:tenantId,Value=local",
    "Name=custom:tenantName,Value=TenkaCloud Lite",
    "--desired-delivery-mediums",
    "EMAIL",
  ]);
  if (createOut.code !== 0) {
    io.stderr(`[lite] admin-create-user failed: ${createOut.stderr}\n`);
    return createOut.code === 0 ? 1 : createOut.code;
  }
  io.stdout(`[lite] invite email sent to ${email}\n`);
  return 0;
}

async function cmdDown(_args: readonly string[], io: CliIO): Promise<number> {
  io.stdout("[lite] destroying 2 stacks...\n");
  // app stack を先に destroy (= cross-stack 参照 (DeployApi Lambda 等) の依存方向に合わせる)。
  const code1 = await io.spawnInherit("bunx", [
    "cdk",
    ...CDK_OPTS,
    "destroy",
    LITE_STACK_NAMES.app,
    "--force",
  ]);
  if (code1 !== 0) return code1;
  return io.spawnInherit("bunx", [
    "cdk",
    ...CDK_OPTS,
    "destroy",
    LITE_STACK_NAMES.problemDeploy,
    "--force",
  ]);
}

async function cmdStatus(_args: readonly string[], io: CliIO): Promise<number> {
  for (const stackName of [LITE_STACK_NAMES.app, LITE_STACK_NAMES.problemDeploy]) {
    const status = await readStackStatus(stackName, io);
    io.stdout(`${stackName.padEnd(40)} ${status}\n`);
  }
  return 0;
}

async function readOutput(
  stackName: string,
  outputKey: string,
  prefix: string,
  io: CliIO,
): Promise<number> {
  const value = await readStackOutput(stackName, outputKey, io);
  if (value === undefined) {
    io.stderr(`[lite] output ${outputKey} not found on stack ${stackName}\n`);
    return 1;
  }
  io.stdout(`${prefix}${value}\n`);
  return 0;
}

async function readStackOutput(
  stackName: string,
  outputKey: string,
  io: CliIO,
): Promise<string | undefined> {
  const out = await io.spawnCapture("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--query",
    `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue`,
    "--output",
    "text",
  ]);
  if (out.code !== 0) return undefined;
  const trimmed = out.stdout.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readStackStatus(stackName: string, io: CliIO): Promise<string> {
  const out = await io.spawnCapture("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--query",
    "Stacks[0].StackStatus",
    "--output",
    "text",
  ]);
  if (out.code !== 0) return "NOT_DEPLOYED";
  return out.stdout.trim() || "UNKNOWN";
}

export function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    spawnInherit: (cmd, args) =>
      new Promise((resolveFn) => {
        const proc = spawn(cmd, [...args], { stdio: "inherit" });
        proc.on("close", (code) => resolveFn(code ?? 0));
        proc.on("error", () => resolveFn(127));
      }),
    spawnCapture: (cmd, args) =>
      new Promise((resolveFn) => {
        const proc = spawn(cmd, [...args]);
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        proc.on("close", (code) => resolveFn({ code: code ?? 0, stdout, stderr }));
        proc.on("error", () => resolveFn({ code: 127, stdout, stderr }));
      }),
  };
}

// Bun: import.meta.main === true のとき本ファイルが CLI として直接実行されている。
// vitest 等から import された場合は main を呼ばない (= side effect-free entry)。
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2), defaultIO());
  process.exit(exitCode);
}
