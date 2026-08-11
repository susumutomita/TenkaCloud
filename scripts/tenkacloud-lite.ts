#!/usr/bin/env bun
/**
 * Issue #778: TenkaCloud Lite mode の CLI runner。
 *
 * SBT / Pipeline / 動的 tenant 作成のフル機能を持ち込まずに、 「TenkaCloud を試したい」
 * 開発者が 1 コマンドで AWS account に最小 stack を deploy できる体験を提供する。
 *
 * 使い方:
 *   bun run scripts/tenkacloud-lite.ts up          — Lite stack を deploy + URL を表示
 *   bun run scripts/tenkacloud-lite.ts down        — Lite stack を destroy
 *   bun run scripts/tenkacloud-lite.ts down --purge-retained-data
 *                                                — stack 所有 DDB / CloudWatch logs も完全削除
 *   bun run scripts/tenkacloud-lite.ts portal-url  — Participant Portal URL を表示
 *   bun run scripts/tenkacloud-lite.ts console-url — Application Admin Console URL を表示
 *   bun run scripts/tenkacloud-lite.ts status      — 両 stack の状態を表示
 *
 * 設計判断:
 *   - `cdk deploy` / `cdk destroy` を spawn する形 (= AWS SDK で自前実装しない)。
 *     CDK の deploy 進捗 UI を そのまま見せた方が初見者に親切。
 *   - CFn outputs の読み取りは AWS CLI を spawn する (= bun の依存に
 *     `@aws-sdk/client-cloudformation` を増やさない、 操作が単純な read のみ)。
 *   - stack 名は `infrastructure/lib/tenkacloud-lite/stack-names.ts` が単一 source of
 *     truth (Issue #2193)。 CDK app と同じ規則で env suffix を解決する (development は
 *     suffix なし、 staging / production 等は `-<env>`) ので、 deploy / status / destroy が
 *     常に同じ stack を指す。
 *   - bin/infrastructure.ts は touch しない。 Lite stack の wiring は別 bin entry
 *     (`infrastructure/bin/tenkacloud-lite.ts`) が担う。
 *
 * テスト容易性のため `main` を export し、 spawn 系を injectable にしている (= unit test
 * から AWS や CDK を実行せずに subcommand dispatch / help / unknown を観測する)。
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LITE_DRILL_CHECKPOINTS } from "@tenkacloud/portal-contracts";
import {
  resolveLiteEnvironment,
  resolveLiteStackNames,
} from "../infrastructure/lib/tenkacloud-lite/stack-names";
import { systemProcessRunner } from "./cli/process";
import {
  parseStackOwnedCleanupResources,
  purgeLiteStackOwnedResources,
} from "./lib/lite-complete-teardown";
import { planTursoTeardown } from "./lib/lite-turso-teardown";
import { reportRetainedTables } from "./lib/retained-tables";
import { runTursoReset, tursoPipelinePost } from "./ops/turso-reset";

export { parseStackOwnedCleanupResources };

// Issue #2193: CDK app (bin/tenkacloud-lite.ts) と同じ規則で env suffix を解決する。
// Makefile が `infrastructure/environments/<env>/.env` を load してから本 CLI を起動する
// ため、 process 起動時点の CDK_PARAM_ENVIRONMENT で確定する。
const LITE_ENVIRONMENT = resolveLiteEnvironment(process.env);
export const LITE_STACK_NAMES = resolveLiteStackNames(LITE_ENVIRONMENT);

// cdk + tsx を repo root から呼ぶ。 monorepo workspace で aws-cdk / tsx は **repo root**
// の node_modules に hoist されるため、 `infrastructure/node_modules/.bin/cdk` は broken
// symlink (= 2026-05-18 user 観測、 exit 127)。 実 binary path:
//   - aws-cdk: `./node_modules/aws-cdk/bin/cdk`  (= shebang `#!/usr/bin/env node`、 直接実行可能)
//   - tsx:     `./node_modules/.bin/tsx`         (= root .bin に symlink あり)
//
// `bun cdk ...` は Bun の script lookup が repo root package.json に "cdk" が無いと
// `Script not found "cdk"` で fail (= PR-#1030 で bunx → bun 置換した regression)。
// `bunx cdk` は user 方針「bunx 禁止」 で使えない。 binary を直 spawn することで Bun の
// script lookup を経由せず、 PATH / cwd 依存も無い。
const CDK_BIN = "./node_modules/aws-cdk/bin/cdk";
const TSX_BIN = "./node_modules/.bin/tsx";
const CDK_OPTS = ["--app", `${TSX_BIN} infrastructure/bin/tenkacloud-lite.ts`];

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
  /**
   * Issue #1345: destroy 前の y/N 確認 prompt。 非 TTY (= CI / pipe) では false を返す
   * default を採用 (= make destroy --yes で bypass する経路を用意する)。 unit test では
   * scripted answer を返す stub に差し替える。
   */
  readonly confirm: (question: string) => Promise<boolean>;
  /**
   * Issue #2992: Turso backend の control-data を全行削除する (スキーマは維持)。 実体は
   * `make turso-reset` と同じ `runTursoReset` で、 destroy 側にロジックを複製しない。
   * 非 turso 環境では呼ばれない (`planTursoTeardown` が判定する)。
   */
  readonly purgeTursoControlData: () => Promise<number>;
  /**
   * `cdk destroy` synths the app, which stages the SPA dist dirs as BucketDeployment
   * assets even though teardown never builds the SPAs. Ensure each dir exists (empty is
   * fine -- content is irrelevant for delete) so synth does not throw CannotFindAsset.
   * unit test では stub に差し替える (= 実 fs を触らない)。
   */
  readonly ensureDir: (dir: string) => void;
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
    help: "Lite stack 2 個を destroy する。DDB もdefault削除。--purge-retained-data で保持分も削除。",
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
    `対象 stack: ${LITE_STACK_NAMES.app} / ${LITE_STACK_NAMES.problemDeploy}\n` +
      "(環境は CDK_PARAM_ENVIRONMENT で切替。 development 以外は stack 名に -<env> が付く)\n",
  );
}

/**
 * Issue #1789: prepare-source-bundle.sh の RESOLVE_ONLY seam を使い、 source.zip の
 * upload 先となる account-scoped bucket 名 (= tenkacloud-source-<account>-<region>) を
 * 解決する。 これは cdk deploy が CodeBuild の source bucket に焼く CDK_PARAM_S3_BUCKET_NAME と
 * 一致させるための単一 source of truth。 creds 不在等で解決できなければ undefined を返し、
 * 後段の本番 prepare 実行に通常のエラー表示を委ねる (= ここでは fail-fast しない)。
 */
async function resolveSourceBucketName(io: CliIO): Promise<string | undefined> {
  const previous = process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
  process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY = "1";
  try {
    const result = await io.spawnCapture("bash", ["scripts/prepare-source-bundle.sh"]);
    if (result.code !== 0) return undefined;
    return parseResolvedBucketName(result.stdout);
  } finally {
    // RESOLVE_ONLY toggle は後始末する (= 本番 prepare 実行が resolve-and-exit しないよう)。
    if (previous === undefined) delete process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
    else process.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY = previous;
  }
}

/**
 * RESOLVE_ONLY 出力 (= `KEY=value` 行の列挙) から CDK_PARAM_S3_BUCKET_NAME を取り出す。
 * 取れなければ undefined。 unit test から直接 pin するため export している。
 */
export function parseResolvedBucketName(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = /^CDK_PARAM_S3_BUCKET_NAME=(.*)$/.exec(line.trim());
    if (match) {
      const value = match[1].trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

/**
 * SPA dist dirs the Lite CDK app stages as BucketDeployment assets at synth time
 * (participant-portal-hosting.ts + application-admin-console-hosting.ts). `cdk destroy`
 * synths too, so these must exist even though teardown never builds the SPAs.
 */
const SYNTH_ASSET_DIRS = ["participant-portal", "application-admin-console"].map((appName) =>
  path.join(import.meta.dirname, "..", "apps", appName, "dist"),
);

/**
 * Lite mode has no SBT Control Plane / system admin, but the shared CDK app
 * (bin/tenkacloud-lite.ts -> resolveAppConfig -> requireSystemAdminEmail) still
 * requires CDK_PARAM_SYSTEM_ADMIN_EMAIL to **synth** -- which both `up` (cdk deploy)
 * and `down` (cdk destroy) do. Derive it from the Lite tenant admin email so
 * `make deploy` / `make destroy` work with only TENANT_ADMIN_EMAIL set (the Lite .env /
 * pipeline case). Never override an explicit value (SaaS-shared env).
 */
export function ensureSystemAdminEmailForSynth(): void {
  const tenantAdminEmail = (
    process.env.TENANT_ADMIN_EMAIL ??
    process.env.SYSTEM_ADMIN_EMAIL ??
    ""
  ).trim();
  if (tenantAdminEmail && !process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL) {
    process.env.CDK_PARAM_SYSTEM_ADMIN_EMAIL = tenantAdminEmail;
  }
}

/**
 * `cdk destroy` synths the app the same way `cdk deploy` does, so resolveAppConfig's
 * unconditional reads of CDK_PARAM_S3_BUCKET_NAME / CDK_SOURCE_NAME / CDK_PARAM_COMMIT_ID
 * (see requireSystemAdminEmail's siblings in lib/app-config/resolve.ts) apply to `down` too
 * -- even though teardown never reads the source bundle. `up` resolves all three via
 * scripts/prepare-source-bundle.sh before synth; `down` previously only derived
 * CDK_PARAM_SYSTEM_ADMIN_EMAIL (ensureSystemAdminEmailForSynth above), so a shell that never
 * ran `up` in the same session -- only TENANT_ADMIN_EMAIL set, the Lite launcher .env case --
 * failed synth one variable at a time: "CDK_PARAM_S3_BUCKET_NAME is empty", then
 * "CDK_SOURCE_NAME is empty", then "CDK_PARAM_COMMIT_ID is empty".
 *
 * The bucket name is resolved the exact same way `up` resolves it (account+region scoped,
 * via resolveSourceBucketName's prepare-source-bundle.sh RESOLVE_ONLY seam) so destroy never
 * invents a second source of truth for it. CDK_SOURCE_NAME / CDK_PARAM_COMMIT_ID are cosmetic
 * for destroy -- `cdk destroy <stack> --force` deletes by stack name via CloudFormation, so
 * neither value affects which physical resources go away -- so a fixed placeholder is safe.
 * Never override an explicit value (SaaS-shared env, or a caller pinning a specific bucket).
 */
async function ensureSourceParamsForSynth(io: CliIO): Promise<void> {
  if (!process.env.CDK_PARAM_S3_BUCKET_NAME) {
    const bucket = await resolveSourceBucketName(io);
    if (bucket) process.env.CDK_PARAM_S3_BUCKET_NAME = bucket;
  }
  process.env.CDK_SOURCE_NAME ??= "source.zip";
  process.env.CDK_PARAM_COMMIT_ID ??= "teardown";
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

  // Deploy synth needs CDK_PARAM_SYSTEM_ADMIN_EMAIL; derive it from the tenant admin email.
  ensureSystemAdminEmailForSynth();

  // Issue #1345: 30-min first-run UX — 各 phase を「[i/N] ...」 で示す。
  const totalSteps = 4;
  io.stdout(`\n[lite] [1/${totalSteps}] preparing source bundle (= S3 bucket + source.zip)...\n`);

  // Issue #1789: source bucket 取り違えで「直したはずの problem template が deploy に
  // 反映されない」事故の修正。 prepare-source-bundle.sh は account-scoped bucket
  // (= tenkacloud-source-<account>-<region>) を自前で解決して source.zip を upload するが、
  // subshell 実行なので resolved bucket 名はこの process に伝わらない。 後段の cdk deploy が
  // CDK_PARAM_S3_BUCKET_NAME を未設定のまま読むと Makefile 既定値 (= creds 不在時に
  // tenkacloud-source-placeholder へフォールバック) が CodeBuild の source bucket に焼かれ、
  // upload 先と read 先が食い違う。 CodeBuild source は version 無指定の Source.s3 で「最新」を
  // 引くため、 placeholder bucket の古い source.zip がそのまま deploy され続ける。 同じ
  // resolution (= 単一 source of truth) を RESOLVE_ONLY で先に解決し process.env に固定して、
  // bundle upload と cdk deploy を必ず同じ bucket に揃える。
  const sourceBucket = await resolveSourceBucketName(io);
  if (sourceBucket) {
    process.env.CDK_PARAM_S3_BUCKET_NAME = sourceBucket;
    io.stdout(`[lite]       source bucket = ${sourceBucket}\n`);
  }

  const prepCode = await io.spawnInherit("bash", ["scripts/prepare-source-bundle.sh"]);
  if (prepCode !== 0) {
    io.stderr(`[lite] prepare-source-bundle.sh failed with exit code ${prepCode}\n`);
    printFailureGuide(io, "source bundle 準備");
    return prepCode;
  }

  io.stdout(
    `\n[lite] [2/${totalSteps}] bootstrapping the AWS environment (= CDKToolkit; idempotent)...\n`,
  );
  // まっさらなアカウントでも `make deploy` がそのまま通るよう、 deploy 前に必ず cdk bootstrap を
  // 実行する (= 冪等。 済んでいれば数秒の no-op)。 install.sh (SaaS) と lite-pipeline.yaml
  // (Pipeline) は既に bootstrap 内蔵で、 ローカル Path B だけ抜けていたのを揃える。
  //
  // CDK_OPTS (= --app) を必ず渡す。 これが無いと bare `cdk bootstrap` は repo root に cdk.json が
  // 無いため "Specify an environment name like 'aws://account/region', or run in a directory with
  // 'cdk.json'" で失敗する (= deploy と同じ --app context から環境を解決させる)。 deploy 呼び出しと
  // 同形にすることで Path A (Pipeline) / Path B (local) のどちらでも環境が解決できる。
  const bootstrapCode = await io.spawnInherit(CDK_BIN, [...CDK_OPTS, "bootstrap"]);
  if (bootstrapCode !== 0) {
    io.stderr(`[lite] cdk bootstrap failed with exit code ${bootstrapCode}\n`);
    printFailureGuide(io, "CDK bootstrap");
    return bootstrapCode;
  }

  io.stdout(`\n[lite] [3/${totalSteps}] deploying 2 stacks (= AppPlane + ProblemDeploy)...\n`);
  io.stdout(
    "[lite]       初回 deploy は ~10 分かかります (= AWS の制約)。 cdk の出力を直接表示します。\n",
  );
  const code = await io.spawnInherit(CDK_BIN, [
    ...CDK_OPTS,
    "deploy",
    LITE_STACK_NAMES.problemDeploy,
    LITE_STACK_NAMES.app,
    "--require-approval",
    "never",
  ]);
  if (code !== 0) {
    io.stderr(`[lite] cdk deploy failed with exit code ${code}\n`);
    printFailureGuide(io, "CFn stack deploy");
    return code;
  }

  io.stdout(`\n[lite] [4/${totalSteps}] resolving access URLs + creating Tenant Admin...\n`);
  const consoleUrl = await readStackOutput(LITE_STACK_NAMES.app, "ApplicationAdminConsoleUrl", io);
  const portalUrl = await readStackOutput(
    LITE_STACK_NAMES.problemDeploy,
    "ParticipantPortalApiUrl",
    io,
  );

  // Tenant Admin user を Cognito に作る (= 初回 sign-in のため)。
  let tenantAdminCreated = false;
  if (tenantAdminEmail) {
    const created = await ensureTenantAdminUser(tenantAdminEmail, io);
    if (created !== 0) {
      io.stderr(
        "[lite] admin-create-user failed. CognitoDomainUrl output が見えない / IAM 権限不足が原因の可能性があります。\n" +
          "[lite] 手動で以下を実行してください:\n" +
          "[lite]   aws cognito-idp list-user-pools --max-results 60\n" +
          "[lite]   aws cognito-idp admin-create-user --user-pool-id <id> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=True --desired-delivery-mediums EMAIL\n",
      );
    } else {
      tenantAdminCreated = true;
    }
  }

  printPostDeployGuide(io, {
    consoleUrl,
    portalUrl,
    tenantAdminEmail,
    tenantAdminCreated,
  });
  return 0;
}

/**
 * Issue #1345: deploy 失敗時に user が次に取るべき action を出す。 AWS / CDK の
 * エラーメッセージは「token expired / permission denied / stack rolled back」 と
 * 多様で、 ありがちなのは「ログを見る → teardown → 再実行」 の 3 step ループに
 * 収まる。
 */
function printFailureGuide(io: CliIO, phase: string): void {
  io.stderr(
    [
      "",
      `[lite] ✗ ${phase} で失敗しました。`,
      "[lite] 次のステップ:",
      "[lite]   1. 直前のログ (= 上に表示された CDK / AWS CLI の出力) でエラー原因を確認",
      "[lite]   2. make destroy           — 中途半端な stack を tear down (idempotent)",
      "[lite]   3. このコマンドを再実行   — make deploy",
      "[lite] よくある原因と対処:",
      "[lite]   - credentials expired       → aws sso login / 新しい session を取得",
      "[lite]   - role 不足                  → 必要な IAM permission を付与",
      "[lite]   - bootstrap 未実行           → cd infrastructure && bun run cdk -- bootstrap",
      "[lite]   - region 不一致 (.env と現環境) → AWS_REGION を .env と一致させる",
      "",
    ].join("\n"),
  );
}

interface PostDeployGuideInput {
  readonly consoleUrl?: string;
  readonly portalUrl?: string;
  readonly tenantAdminEmail: string;
  readonly tenantAdminCreated: boolean;
}

/**
 * Issue #1345: deploy 完了直後に「次にやること」 を 1 画面で見せる post-deploy guide。
 * 「Application Admin Console を開いて hello-world を deploy → Participant Portal で
 * 確認」 までの最短経路を文字で示す。 URL が読めなかった場合 (= IAM 不足 / output 名
 * 変更) でも guidance だけは出す。
 */
function printPostDeployGuide(io: CliIO, input: PostDeployGuideInput): void {
  const lines: string[] = [
    "",
    "================================================================",
    "✓ Lite mode deploy complete",
    "================================================================",
    "",
    "Access URLs:",
    `  - Application Admin Console: ${input.consoleUrl ?? "(unknown — bun run scripts/tenkacloud-lite.ts console-url)"}`,
    `  - Participant Portal:        ${input.portalUrl ?? "(unknown — bun run scripts/tenkacloud-lite.ts portal-url)"}`,
    "",
  ];
  if (input.tenantAdminEmail) {
    lines.push(
      input.tenantAdminCreated
        ? `Tenant Admin invite を ${input.tenantAdminEmail} に送信しました (Cognito email)。`
        : `Tenant Admin (${input.tenantAdminEmail}) は既存または作成に失敗。 上のログを参照。`,
    );
    lines.push("");
  }
  lines.push(
    "Next steps:",
    "  1. メールの一時パスワードで Application Admin Console にサインイン",
    "  2. Event タブで 「Demo」 という名前の event を作成",
    "  3. Problems タブから hello-world を deploy",
    "  4. Participant Portal URL を team に共有 (login key は event 作成時に発行)",
    "",
    // Issue #2696: LP デモポータルのオンボーディングドリル 「2. Lite デプロイ完了」 の
    // チェックポイント。 このブロックは CodeBuild ログ末尾 (= lite-pipeline 経由) と
    // 手元の `make deploy` の両方に出る。
    "Onboarding drill (LP デモポータル):",
    `  Checkpoint code: ${LITE_DRILL_CHECKPOINTS.deployComplete.code}`,
    "  「自分の TenkaCloud Lite を立てる」 ドリルの 「2. Lite デプロイ完了」 に提出しよう。",
    "  (他のコードは CloudFormation Outputs と Admin Console の各操作成功時に表示される)",
    "",
    "Teardown:",
    "  make destroy       — stack を削除（DynamoDB もデフォルトで削除）",
    "  make destroy-all   — 明示的に保持したDynamoDB履歴とCodeBuild logsも完全削除",
    "",
    "Docs:",
    "  - README.md (Quickstart)     — 30-min first-run の全体像",
    "================================================================",
    "",
  );
  io.stdout(lines.join("\n"));
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
  const match = /^https?:\/\/([^.]+)\.auth\./.exec(domainUrl);
  if (!match?.[1]) {
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

async function cmdDown(args: readonly string[], io: CliIO): Promise<number> {
  // Issue #1345: destructive teardown の first-run 誤爆を避けるため確認 prompt を入れる。
  // `--yes` / `-y` で skip 可能 (= CI / cleanup script から呼ぶときは bypass)。
  const purgeRetainedData = args.includes("--purge-retained-data");
  if (!(await confirmTeardown(args, purgeRetainedData, io))) {
    io.stdout("[lite] aborted (no resources were modified).\n");
    return 0;
  }

  if (purgeRetainedData) {
    const purgeCode = await purgeLiteStackOwnedResources({
      stackNames: [LITE_STACK_NAMES.app, LITE_STACK_NAMES.problemDeploy],
      environment: LITE_ENVIRONMENT,
      includeLegacyLauncherLogGroup: process.env.TENKACLOUD_LITE_MANAGED_LAUNCHER_LOG_GROUP === "1",
      io,
    });
    if (purgeCode !== 0) return purgeCode;
  }

  // Issue #2992: Turso backend の control-data は AWS の外にあるので、 stack を消しても
  // 残る。 stack 削除の *前* に消すこと — auth token は stack が作る SSM parameter から
  // 読むため、 先に stack を消すと認証手段ごと消えて手も足も出なくなる。
  const tursoPlan = planTursoTeardown(process.env, purgeRetainedData);
  if (tursoPlan.kind === "purge") {
    // teardown 全体の confirm は既に取ってあるので、 ここで二度目を聞かない (assumeYes)。
    const tursoCode = await io.purgeTursoControlData();
    if (tursoCode !== 0) {
      io.stderr("[lite] Turso control-data の削除に失敗しました。 teardown を中止します。\n");
      return tursoCode;
    }
  }

  // `cdk destroy` synths the app the same way `cdk deploy` does, so the shared CDK app
  // still requires CDK_PARAM_SYSTEM_ADMIN_EMAIL. Derive it from the tenant admin email so
  // `make destroy` works with only TENANT_ADMIN_EMAIL set (the Lite .env the CodeBuild
  // launcher writes); without this, destroy throws "Please provide system admin email".
  ensureSystemAdminEmailForSynth();
  // Same synth requirement for the other three unconditional resolveAppConfig reads
  // (see ensureSourceParamsForSynth's doc comment for why destroy needs them too).
  await ensureSourceParamsForSynth(io);
  // cdk destroy synths the app; the SPA dist dirs are staged as assets even though teardown
  // never builds them. Create empty placeholders so synth does not throw CannotFindAsset
  // (content is irrelevant -- destroy deletes, it never uploads).
  for (const dir of SYNTH_ASSET_DIRS) io.ensureDir(dir);
  io.stdout("[lite] destroying 2 stacks...\n");
  // app stack を先に destroy (= cross-stack 参照 (DeployApi Lambda 等) の依存方向に合わせる)。
  const code1 = await io.spawnInherit(CDK_BIN, [
    ...CDK_OPTS,
    "destroy",
    LITE_STACK_NAMES.app,
    "--force",
  ]);
  if (code1 !== 0) return code1;
  const code2 = await io.spawnInherit(CDK_BIN, [
    ...CDK_OPTS,
    "destroy",
    LITE_STACK_NAMES.problemDeploy,
    "--force",
  ]);
  if (code2 !== 0) return code2;
  // Issue #2444 / #2959: 明示的に CDK_PARAM_RETAIN_DATA_TABLES=true で deploy した
  // DDB table や旧 stack の RETAIN table は destroy 後も課金される。残存 table を列挙して
  // 警告する（削除はしない）。list 失敗は警告に留め destroy の exit code は変えない
  // (reportRetainedTables は throw せず戻り値も持たない)。
  if (purgeRetainedData) {
    io.stdout("[lite] complete teardown succeeded; stack-owned retained data was removed.\n");
  } else {
    await reportRetainedTables((args) => io.spawnCapture("aws", args), io.stdout);
    // DynamoDB backend は上の残存 table 警告で気づけるが、 Turso backend はそこに現れない。
    // 何も言わないと「全部消えた」と読めてしまうので、 明示する。
    if (tursoPlan.kind === "warn") io.stdout(tursoPlan.message);
  }
  return 0;
}

async function confirmTeardown(
  args: readonly string[],
  purgeRetainedData: boolean,
  io: CliIO,
): Promise<boolean> {
  const skipConfirm =
    args.includes("--yes") || args.includes("-y") || process.env.TENKACLOUD_LITE_DOWN_YES === "1";
  if (skipConfirm) return true;
  return io.confirm(
    (purgeRetainedData
      ? "[lite] make destroy-all は Lite stack と、stack が所有する DynamoDB の全履歴を完全削除します。\n" +
        "[lite] このデータは復元できません。stack に紐づく CloudWatch log group も削除します。\n"
      : "[lite] make destroy は Lite stack を削除します。DynamoDB table もデフォルトで削除されます。\n" +
        "[lite] CDK_PARAM_RETAIN_DATA_TABLES=true で deploy 済みの場合だけ、table と課金が残ります。\n") +
      "[lite] Cognito UserPool / S3 / CloudFront など stack 管理 resource も削除されます。\n" +
      "[lite] 続行しますか? (y/N): ",
  );
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
    ensureDir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    // Issue #2992: `make turso-reset` と同じ実装を呼ぶ。 assumeYes は teardown 全体の
    // confirm を既に取っているため (ここで二度聞かない)。 interactive:false と合わせて、
    // CodeBuild launcher からの非対話 teardown でも同じ経路が通る。
    purgeTursoControlData: () =>
      runTursoReset({
        env: process.env,
        environment: LITE_ENVIRONMENT,
        processRunner: systemProcessRunner,
        httpPost: tursoPipelinePost,
        confirm: async () => true,
        log: (message) => process.stdout.write(`${message}\n`),
        interactive: false,
        assumeYes: true,
      }),
    confirm: async (question) => {
      // 非 TTY (= CI / pipe) では false を返して safety net とする。
      // bypass したい場合は呼び出し側で --yes / TENKACLOUD_LITE_DOWN_YES=1 を渡す。
      if (!process.stdin.isTTY) return false;
      process.stdout.write(question);
      // node:readline/promises に依存せず stdin から 1 chunk を待つ単純実装。
      return await new Promise<boolean>((resolveFn) => {
        let buf = "";
        const onData = (chunk: Buffer | string) => {
          buf += chunk.toString();
          if (buf.includes("\n")) {
            process.stdin.removeListener("data", onData);
            process.stdin.pause();
            const answer = buf.trim().toLowerCase();
            resolveFn(answer === "y" || answer === "yes");
          }
        };
        process.stdin.resume();
        process.stdin.on("data", onData);
      });
    },
  };
}

// Bun: import.meta.main === true のとき本ファイルが CLI として直接実行されている。
// vitest 等から import された場合は main を呼ばない (= side effect-free entry)。
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2), defaultIO());
  process.exit(exitCode);
}
