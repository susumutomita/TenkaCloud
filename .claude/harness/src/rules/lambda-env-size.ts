import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding, Rule, RuleContext } from "../types.ts";

/**
 * Issue #1309 / Lambda env 4KB hard limit overflow 再発防止。
 *
 * Background (= 症状 #1308):
 *   `BATTLE_PROBLEMS_DISRUPTIONS` env が 5 問追加で 3.4KB に膨らみ、 他 env (table 名 / catalog
 *   JSON 等) と合算で AWS Lambda env 4KB hard limit を超え、 CFn CreateStack が
 *   `Lambda was unable to configure environment variables: Environment variable maximum size exceeded`
 *   で fail した。 PR review でも `cdk synth` でも気づけない (= synth は通る / deploy で初めて落ちる)
 *   ので、 構造的に harness 側で先に検出するしかない。
 *
 * Strategy:
 *   `infrastructure/cdk.out/*.template.json` を walk し、 各 `AWS::Lambda::Function`
 *   `Properties.Environment.Variables` の合計 byte 数を AWS Lambda の env 計測 spec
 *   (= name + "=" + value + delimiter ~= 2 bytes overhead per entry, UTF-8) で集計する。
 *
 *   - >= 3072 bytes (3KB) → error (= 4KB hard limit に 1KB margin。 PR を block)
 *   - >= 2560 bytes (2.5KB) → warning (= 早めに掃除しろ)
 *
 *   CFn intrinsic (= `{ Ref: ... }` / `{ Fn::Select: [...] }` 等) は deploy 時に
 *   resolve されると ARN 長 (~200 bytes 平均) になるため、 CFN_INTRINSIC_ESTIMATE_BYTES で
 *   保守的に見積もる。 純 string env (= catalog JSON / 長い feature flag list) こそが
 *   feature 追加で線形に膨らむ本丸なので、 文字列値は exact 計測する。
 *
 * Baseline:
 *   `.claude/harness/baselines/lambda-env-size.json` で現状の違反 (= #1308 の本丸である
 *   EventApiFunction) を凍結。 新規 Lambda が閾値を超える、 もしくは baseline 既存 Lambda が
 *   さらに膨らんで severity bucket を超えると baseline match を外れて発火する設計。
 *
 * cdk.out が存在しない場合 (= fresh clone で synth してない):
 *   info-level (= 非 blocking) finding を 1 件返して "make synth してから再実行" を促す。
 *   通常運用では `make before-commit` の `check-synth` で cdk.out が生成されるので、
 *   CI / PR 経路では確実に動く。
 *
 * Detection target (= 特に膨らみやすい):
 *   - catalog / disruption blob (= 問題追加で線形増加)
 *   - 長い resource ARN list / API base URLs list / IAM policy JSON
 */

const CDK_OUT_DIR = "infrastructure/cdk.out";
const HARD_LIMIT_BYTES = 4096;
const ERROR_BYTES = 3072; // 4KB - 1KB margin
const WARNING_BYTES = 2560; // 2.5KB
const ENV_VAR_DELIMITER_OVERHEAD_BYTES = 2; // "=" + entry delimiter approximation
const CFN_INTRINSIC_ESTIMATE_BYTES = 200; // average resolved ARN length

interface CfnTemplate {
  readonly Resources?: Record<string, CfnResource>;
}

interface CfnResource {
  readonly Type?: string;
  readonly Properties?: {
    readonly Environment?: {
      readonly Variables?: Record<string, unknown>;
    };
    readonly FunctionName?: unknown;
  };
}

interface EnvMeasurement {
  readonly totalBytes: number;
  readonly largestKey: string;
  readonly largestBytes: number;
}

/**
 * 1 env var の byte 数を AWS Lambda の env 計測に合わせて見積もる。
 * 文字列値は UTF-8 byte length で exact 計測、 CFn intrinsic (= 中身が object) は
 * 平均 ARN 長 (= 200 bytes) で見積もり。
 */
function measureEnvValueBytes(key: string, value: unknown): number {
  const keyBytes = Buffer.byteLength(key, "utf8");
  let valueBytes: number;
  if (typeof value === "string") {
    valueBytes = Buffer.byteLength(value, "utf8");
  } else if (typeof value === "number" || typeof value === "boolean") {
    valueBytes = Buffer.byteLength(String(value), "utf8");
  } else {
    // CFn intrinsic ({Ref}, {Fn::Sub}, {Fn::Select}, etc.) — deploy 時に resolve される ARN。
    valueBytes = CFN_INTRINSIC_ESTIMATE_BYTES;
  }
  return keyBytes + valueBytes + ENV_VAR_DELIMITER_OVERHEAD_BYTES;
}

export function measureEnvVariables(envVars: Record<string, unknown>): EnvMeasurement {
  let total = 0;
  let largestKey = "";
  let largestBytes = 0;
  for (const [key, value] of Object.entries(envVars)) {
    const size = measureEnvValueBytes(key, value);
    total += size;
    if (size > largestBytes) {
      largestBytes = size;
      largestKey = key;
    }
  }
  return { totalBytes: total, largestKey, largestBytes };
}

interface CdkTemplateFile {
  readonly relPath: string; // e.g. "infrastructure/cdk.out/tenkacloud-problem-deploy.template.json"
  readonly stackName: string; // e.g. "tenkacloud-problem-deploy"
  readonly template: CfnTemplate;
}

function listCdkTemplates(cwd: string): readonly CdkTemplateFile[] {
  const dir = resolve(cwd, CDK_OUT_DIR);
  if (!existsSync(dir)) return [];
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const results: CdkTemplateFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".template.json")) continue;
    // CDK が出す asset.* / nested stack の template も .template.json で出るが
    // top-level stack だけが対象。 asset bundle 用は asset.<hash>.* の prefix。
    if (name.startsWith("asset.")) continue;
    const fullPath = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    let parsed: CfnTemplate;
    try {
      parsed = JSON.parse(raw) as CfnTemplate;
    } catch {
      continue;
    }
    const stackName = name.replace(/\.template\.json$/, "");
    results.push({
      relPath: `${CDK_OUT_DIR}/${name}`,
      stackName,
      template: parsed,
    });
  }
  return results;
}

function isCdkOutFresh(cwd: string): boolean {
  const dir = resolve(cwd, CDK_OUT_DIR);
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir).filter((n) => n.endsWith(".template.json"));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * severity bucket を返す。 baseline match の単位として使う (= byte 数そのものを match
 * key にすると 1 byte 増えるだけで baseline 外れて再警告するため、 bucket 化する)。
 */
export function bucketFor(totalBytes: number): "ok" | "ge-warning" | "ge-error" | "ge-hard-limit" {
  if (totalBytes >= HARD_LIMIT_BYTES) return "ge-hard-limit";
  if (totalBytes >= ERROR_BYTES) return "ge-error";
  if (totalBytes >= WARNING_BYTES) return "ge-warning";
  return "ok";
}

export interface CheckTemplatesOptions {
  readonly templates: readonly CdkTemplateFile[];
}

export function checkTemplates(opts: CheckTemplatesOptions): Finding[] {
  const findings: Finding[] = [];
  for (const { relPath, stackName, template } of opts.templates) {
    const resources = template.Resources ?? {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const envVars = resource.Properties?.Environment?.Variables ?? {};
      const measurement = measureEnvVariables(envVars);
      const bucket = bucketFor(measurement.totalBytes);
      if (bucket === "ok") continue;
      const severity = bucket === "ge-warning" ? "warning" : "error";
      const overLimitNote =
        bucket === "ge-hard-limit"
          ? ` (= AWS Lambda 4KB hard limit ${HARD_LIMIT_BYTES} bytes 超過、 deploy で必ず fail する)`
          : bucket === "ge-error"
            ? ` (= 4KB hard limit ${HARD_LIMIT_BYTES} bytes に対し残 margin ${HARD_LIMIT_BYTES - measurement.totalBytes} bytes)`
            : ` (= 4KB hard limit ${HARD_LIMIT_BYTES} bytes に対し残 margin ${HARD_LIMIT_BYTES - measurement.totalBytes} bytes、 早めに掃除推奨)`;
      findings.push({
        ruleId: "lambda-env-size",
        severity,
        filePath: relPath,
        line: 1,
        // bucket 単位で baseline match (= 同 bucket 内なら byte 増減で baseline 外れない)
        match: `${stackName}::${logicalId}::${bucket}`,
        message:
          `Lambda \`${logicalId}\` in stack \`${stackName}\` has total env size ` +
          `${measurement.totalBytes} bytes${overLimitNote}. ` +
          `Largest var: \`${measurement.largestKey}\` (${measurement.largestBytes} bytes).`,
        recommendation:
          "AWS Lambda 4KB hard limit. Move large env data to one of: " +
          "(1) bundled module via esbuild `bundling.define` (literal substitution at build time, = #1158 / #1308 catalog pattern); " +
          "(2) S3 + lazy fetch at cold start; " +
          "(3) SSM Parameter Store SecureString (cost-zero, AGENTS.md secrets-manager-forbidden rule). " +
          "See #1308 for the catalog/disruption bundling pattern.",
      });
    }
  }
  return findings;
}

export const lambdaEnvSize: Rule = {
  id: "lambda-env-size",
  severity: "error",
  check(ctx: RuleContext): readonly Finding[] {
    const cwd = process.cwd();
    if (!isCdkOutFresh(cwd)) {
      // cdk.out が無い fresh clone / synth 未実行ケース。 false negative より silent skip
      // を選ぶと #1308 の再発を見逃すため、 info 1 件出して synth を促す。
      return [
        {
          ruleId: "lambda-env-size",
          severity: "info",
          filePath: CDK_OUT_DIR,
          line: 1,
          match: "cdk-out-missing",
          message:
            "lambda-env-size: cdk.out が存在しません (= synth 未実行)。 Lambda env 計測を skip しました。",
          recommendation:
            "`make synth` を実行して `infrastructure/cdk.out/*.template.json` を生成してから harness を再実行してください。 " +
            "`make before-commit` を経由すれば check-synth が自動で走るので追加操作不要です。",
        },
      ];
    }
    const templates = listCdkTemplates(cwd);
    if (templates.length === 0) return [];
    return checkTemplates({ templates });
  },
};

// vitest からは内部 helper を直接 import するためここで再 export。
// 不要 export を一括公開しないよう named only。
export const __test__ = {
  listCdkTemplates,
  isCdkOutFresh,
  measureEnvValueBytes,
  CFN_INTRINSIC_ESTIMATE_BYTES,
  ERROR_BYTES,
  WARNING_BYTES,
  HARD_LIMIT_BYTES,
};
