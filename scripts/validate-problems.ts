#!/usr/bin/env bun
/**
 * problems/ 配下のすべての metadata.json を problems/SCHEMA.json で validate する。
 * 加えて #951 sub #2 で template.yaml との cross-ref も検査 (= 実 deploy 前に
 * scoring engine が読めない / endpoints が解決できない / portal slot が存在しない
 * パターンを検出する)。
 *
 * Usage:
 *   bun run scripts/validate-problems.ts
 *
 * 失敗時は exit code 1 + エラー内容を stderr に出す。CI / pre-commit で実行する想定。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  classifyRuntimeSupport,
  isExecutableRuntime,
  normalizeRuntime,
  RESERVED_RUNTIMES,
  type RuntimeDescriptor,
  type RuntimeMetadataInput,
} from "@tenkacloud/problem-runtime";
import Ajv2020 from "ajv";
import addFormats from "ajv-formats";
import {
  checkDisruptionActionOutputRefs,
  checkDisruptionActions,
} from "./lib/disruption-action-check";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROBLEMS_DIR = join(REPO_ROOT, "problems");
const SCHEMA_PATH = join(PROBLEMS_DIR, "SCHEMA.json");
type Metadata = Record<string, unknown>;
type ValidationError = string;

function findMetadataFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      found.push(...findMetadataFiles(full));
    } else if (entry === "metadata.json") {
      found.push(full);
    }
  }
  return found;
}

/**
 * metadata.json と template.yaml の間の cross-ref を検査する。
 *   - flag kind: scoring.flagOutputKey が template.yaml Outputs に存在
 *   - attack-detection kind: scoring.statsOutputKey が Outputs に存在
 *   - endpoints[].default.key (= cfn-output binding) が Outputs に存在
 *   - dashboard.slots["<slot>"] の portal/<file>.tsx が物理 file として存在
 *
 * 実 deploy で CFn が CREATE_COMPLETE しても、 これらの参照が解決できないと
 * scoring engine / portal が壊れるので、 ここで先に止める。
 */
/**
 * [ADR-023 / ADR-026 / ADR-027] runtime の provider/engine が、 実行可能な
 * `aws/cloudformation` でも、 ロードマップ予約済み (sakura/apprun・azure/bicep・
 * gcp/infra-manager) でもないとき = typo の可能性が高いので止める。 予約済み runtime は
 * まだ deploy できないが、 problem author が先行して書けるよう validation は通す。
 */
export function checkRuntimeSupport(runtime: RuntimeDescriptor): ValidationError[] {
  if (classifyRuntimeSupport(runtime) !== "unknown") return [];
  const reserved = RESERVED_RUNTIMES.map((r) => `${r.provider}/${r.engine}`).join(", ");
  return [
    `runtime "${runtime.provider}/${runtime.engine}" は実行可能 (aws/cloudformation) でも` +
      ` 予約済みでもありません (typo の可能性)。 予約済み: ${reserved}`,
  ];
}

function checkRuntimeConsistency(meta: Metadata): ValidationError[] {
  // [ADR-023] If both `runtime` and `cfnTemplate` are declared, they must agree (= compat window).
  const runtime = meta.runtime as Record<string, unknown> | undefined;
  if (!runtime) return [];
  const entry = typeof runtime.entry === "string" ? runtime.entry : undefined;
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : undefined;
  if (entry && cfnTemplate && entry !== cfnTemplate) {
    return [
      `runtime.entry="${entry}" と cfnTemplate="${cfnTemplate}" が一致しません (ADR-023 D2 compat window)`,
    ];
  }
  return [];
}

export function checkCrossRefs(metaPath: string, meta: Metadata): ValidationError[] {
  const dir = dirname(metaPath);
  // [ADR-023] 正本の正規化ロジック (problem-runtime) を共有して provider/engine/entry を解決。
  const runtime = normalizeRuntime(meta as RuntimeMetadataInput);
  if (!runtime) {
    return ["runtime object が不正です (provider / engine / entry はすべて string 必須)"];
  }
  const templatePath = join(dir, runtime.entry);
  if (!existsSync(templatePath)) {
    return [`runtime entry file "${runtime.entry}" not found`];
  }

  const errors = [
    ...checkRuntimeSupport(runtime),
    ...checkRuntimeConsistency(meta),
    ...checkDashboardSlotFiles(meta, dir),
    ...checkCoordinationPluginFile(meta, dir),
    ...checkDisruptionActions(meta),
    ...checkRegionConsistency(meta),
  ];

  // CFn Outputs 構文 (`Key:`) を前提にした cross-ref は executable な aws/cloudformation
  // engine のときだけ意味を持つ。 予約済み (sakura/azure/gcp) は出力 binding 機構が
  // provider 固有 + まだ deploy 不可なので、 ここでは file 存在のみ担保し CFn check は skip。
  if (isExecutableRuntime(runtime)) {
    const yaml = readFileSync(templatePath, "utf8");
    errors.push(
      ...checkScoringOutputRefs(meta, yaml, runtime.entry),
      ...checkEndpointOutputRefs(meta, yaml, runtime.entry),
      ...checkDisruptionActionOutputRefs(meta, yaml, runtime.entry),
    );
  }
  return errors;
}

const REGION_RE = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/;

function checkSupportedRegionsArray(supportedRegions: readonly unknown[]): ValidationError[] {
  const errors: ValidationError[] = [];
  if (supportedRegions.length === 0) {
    errors.push(
      "supportedRegions が空配列です。 宣言するなら 1 件以上指定するか field 自体を省略してください",
    );
  }
  for (const r of supportedRegions) {
    if (typeof r !== "string" || !REGION_RE.test(r)) {
      errors.push(
        `supportedRegions に AWS region 形式でない値が含まれています: ${JSON.stringify(r)}`,
      );
    }
  }
  return errors;
}

function checkDefaultRegionInSupported(
  defaultRegion: string,
  supportedRegions: readonly unknown[],
): ValidationError[] {
  if (!supportedRegions.every((r) => typeof r === "string")) return [];
  if (supportedRegions.includes(defaultRegion)) return [];
  return [
    `defaultRegion="${defaultRegion}" が supportedRegions=${JSON.stringify(supportedRegions)} に含まれていません (= wizard で picker から選べない region を初期値にしている)`,
  ];
}

/**
 * Issue #1201 Phase 2: `defaultRegion` / `supportedRegions` の整合性 check。
 *
 *   - 両 field とも AWS region 形式 `^[a-z]{2,3}-[a-z]+-\d+$` であること
 *   - `defaultRegion` 宣言 + `supportedRegions` 宣言 の場合、 `defaultRegion ∈
 *     supportedRegions` であること (= wizard が picker から拾えない region に倒れない)
 *   - `supportedRegions` が空配列のときは 「宣言したのに空」 として reject
 *
 * 未宣言 (= optional 未使用) は OK (= 後方互換)。
 */
export function checkRegionConsistency(meta: Metadata): ValidationError[] {
  const errors: ValidationError[] = [];
  const defaultRegion = typeof meta.defaultRegion === "string" ? meta.defaultRegion : undefined;
  const supportedRegions = Array.isArray(meta.supportedRegions)
    ? (meta.supportedRegions as unknown[])
    : undefined;

  if (defaultRegion !== undefined && !REGION_RE.test(defaultRegion)) {
    errors.push(
      `defaultRegion="${defaultRegion}" は AWS region 形式と一致しません (例: ap-northeast-1)`,
    );
  }
  if (supportedRegions !== undefined) {
    errors.push(...checkSupportedRegionsArray(supportedRegions));
    if (defaultRegion !== undefined) {
      errors.push(...checkDefaultRegionInSupported(defaultRegion, supportedRegions));
    }
  }
  return errors;
}

function checkScoringOutputRefs(
  meta: Metadata,
  yaml: string,
  cfnTemplate: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const scoring = meta.scoring as Record<string, unknown> | undefined;
  const kind = scoring?.kind;

  if (kind === "flag") {
    const flagKey = scoring?.flagOutputKey;
    if (typeof flagKey === "string" && !yaml.includes(`${flagKey}:`)) {
      errors.push(
        `scoring.flagOutputKey="${flagKey}" not found in ${cfnTemplate} Outputs (= scoring engine が読めない)`,
      );
    }
  }

  if (kind === "attack-detection") {
    const statsKey = scoring?.statsOutputKey;
    if (typeof statsKey === "string" && !yaml.includes(`${statsKey}:`)) {
      errors.push(`scoring.statsOutputKey="${statsKey}" not found in ${cfnTemplate} Outputs`);
    }
  }
  return errors;
}

function checkEndpointOutputRefs(
  meta: Metadata,
  yaml: string,
  cfnTemplate: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  for (const ep of endpoints as Array<Record<string, unknown>>) {
    const def = ep.default as Record<string, unknown> | undefined;
    const from = def?.from;
    const key = def?.key;
    if (from === "cfn-output" && typeof key === "string" && !yaml.includes(`${key}:`)) {
      errors.push(
        `endpoints[slot=${String(ep.slot)}].default.key="${key}" not found in ${cfnTemplate} Outputs`,
      );
    }
  }
  return errors;
}

function checkDashboardSlotFiles(meta: Metadata, dir: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (!slots) return errors;
  for (const [slotName, slotPath] of Object.entries(slots)) {
    if (typeof slotPath === "string") {
      const physical = join(dir, slotPath);
      if (!existsSync(physical)) {
        errors.push(`dashboard.slots["${slotName}"]="${slotPath}" file not found`);
      }
    }
  }

  return errors;
}

/**
 * interTeamCoordination.plugin (ADR-028 / #1420) が物理 file として存在するか cross-ref する。
 * dashboard.slots (portal/*.tsx) と同方針 — platform の dispatcher が runtime に動的 import する
 * ため、 存在しない path を宣言したまま catalog に載ると実行時に coordination が無言で無効化され
 * 出題者は気付けない。 SCHEMA は path pattern までしか保証しないので file 実在はここで止める。
 * interTeamCoordination 未宣言の problem は無影響 (= 早期 return)。
 */
/**
 * ADR-030 S1/S3 (#1420): coordination plugin は **副作用なしの純 reducer** でなければならない。
 * platform の (最小 IAM とはいえ) dispatcher Lambda が in-process で動的 import するため、 AWS SDK /
 * fetch / node 組み込み / 環境変数アクセスを含む plugin は資格情報・外部 I/O への足がかりになりうる。
 * S1 の「reviewer checklist (import 監査)」を機械チェック化し、 これらを宣言した plugin は出題時に reject する。
 */
const COORDINATION_FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly label: string;
  readonly re: RegExp;
}> = [
  { label: "@aws-sdk import", re: /@aws-sdk\// },
  { label: "node: builtin import", re: /["']node:/ },
  { label: "process.env access", re: /process\s*\.\s*env/ },
  { label: "fetch() call", re: /\bfetch\s*\(/ },
];

export function checkCoordinationPluginFile(meta: Metadata, dir: string): ValidationError[] {
  const coordination = meta.interTeamCoordination as Record<string, unknown> | undefined;
  const plugin = coordination?.plugin;
  if (typeof plugin !== "string") return [];
  const pluginPath = join(dir, plugin);
  if (!existsSync(pluginPath)) {
    return [`interTeamCoordination.plugin="${plugin}" file not found`];
  }
  // ADR-030 S1: pure-reducer 規約を機械 enforce (= dispatcher が in-process 実行するため、
  // 未信頼コードが資格情報・外部 I/O に到達する import を出題時に弾く)。
  const source = readFileSync(pluginPath, "utf8");
  return COORDINATION_FORBIDDEN_PATTERNS.filter(({ re }) => re.test(source)).map(
    ({ label }) =>
      `interTeamCoordination.plugin="${plugin}" must be a side-effect-free pure reducer (ADR-030 S1): forbidden ${label}`,
  );
}

function main(): void {
  const validate = createSchemaValidator();
  const metadataFiles = findMetadataFiles(PROBLEMS_DIR);
  assertMetadataFilesExist(metadataFiles);
  const failed = validateMetadataFiles(metadataFiles, validate);
  reportResult(failed, metadataFiles.length);
}

function createSchemaValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertMetadataFilesExist(metadataFiles: string[]): void {
  if (metadataFiles.length === 0) {
    console.error("No metadata.json found under problems/. At least one problem is expected.");
    process.exit(1);
  }
}

function validateMetadataFiles(
  metadataFiles: string[],
  validate: ReturnType<Ajv2020["compile"]>,
): number {
  let failed = 0;
  for (const file of metadataFiles) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!validate(data)) {
      failed += 1;
      printSchemaErrors(file, data, validate.errors ?? []);
      continue;
    }

    const crossRefErrors = checkCrossRefs(file, data);
    if (crossRefErrors.length > 0) {
      failed += 1;
      printCrossRefErrors(file, crossRefErrors);
      continue;
    }

    console.log(`OK  ${relative(REPO_ROOT, file)}`);
  }
  return failed;
}

/**
 * Issue #1347: Ajv raw error -> author-friendly hint。 metadata.json はほぼ全ての contributor が
 * 初見で開く file なので、 「何が悪い + どう fix するか」 を 1 行で返す。 Ajv の `keyword` / `params`
 * から派生する典型 case を抑える。 想定外 case は元の `err.message` をそのまま出す。
 */
type AjvError = NonNullable<ReturnType<Ajv2020["compile"]>["errors"]>[number];

function paramStr(err: AjvError, key: string): string {
  return String((err.params as Record<string, unknown>)[key] ?? "");
}

const AJV_HINT_HANDLERS: Record<string, (path: string, err: AjvError) => string> = {
  required: (path, err) =>
    `${path} 必須 field "${paramStr(err, "missingProperty")}" がありません — SCHEMA.json の description を参照、 値を追加してください`,
  enum: (path, err) => {
    const allowed = (err.params as Record<string, unknown>).allowedValues;
    const list = Array.isArray(allowed) ? allowed.map((v) => JSON.stringify(v)).join(" | ") : "";
    return `${path} ${err.message ?? ""} — 有効値は ${list}`;
  },
  type: (path, err) => `${path} 型が違います (expected: ${paramStr(err, "type")})`,
  pattern: (path, err) =>
    `${path} 値が pattern /${paramStr(err, "pattern")}/ に一致しません (例: kebab-case 制約等)`,
  minLength: (path, err) => `${path} 文字数が短すぎ (limit: ${paramStr(err, "limit")})`,
  maxLength: (path, err) => `${path} 文字数が長すぎ (limit: ${paramStr(err, "limit")})`,
  minItems: (path, err) => `${path} 要素数が少なすぎ (limit: ${paramStr(err, "limit")})`,
  maxItems: (path, err) => `${path} 要素数が多すぎ (limit: ${paramStr(err, "limit")})`,
  additionalProperties: (path, err) =>
    `${path} 未知の field "${paramStr(err, "additionalProperty")}" — typo か、 SCHEMA.json に未定義の field`,
  const: (path, err) => {
    const want = JSON.stringify((err.params as Record<string, unknown>).allowedValue);
    return `${path} 値は ${want} でなければなりません`;
  },
};

export function describeAjvError(err: AjvError): string {
  const path = err.instancePath || "(root)";
  const handler = AJV_HINT_HANDLERS[err.keyword];
  return handler ? handler(path, err) : `${path} ${err.message ?? ""}`;
}

function printSchemaErrors(
  file: string,
  data: Metadata,
  errors: NonNullable<ReturnType<Ajv2020["compile"]>["errors"]>,
): void {
  console.error(`NG  ${relative(REPO_ROOT, file)}`);
  for (const err of errors) {
    console.error(`     ${describeAjvError(err)}`);
  }
  const expectedId = file.split("/").slice(-2, -1)[0];
  if (data.id && data.id !== expectedId) {
    console.error(`     id (${data.id}) はディレクトリ名 (${expectedId}) と一致させてください`);
  }
  console.error(
    `     詳細: docs/problems/CONTRIBUTING.md "Validation errors and how to read them" 参照`,
  );
}

function printCrossRefErrors(file: string, errors: ValidationError[]): void {
  console.error(`NG  ${relative(REPO_ROOT, file)} (cross-ref)`);
  for (const e of errors) {
    console.error(`     ${e}`);
  }
}

function reportResult(failed: number, total: number): void {
  if (failed > 0) {
    console.error(
      `\n${failed} / ${total} 件の metadata.json が schema / cross-ref に違反しています`,
    );
    process.exit(1);
  }
  console.log(`\n${total} 件の metadata.json はすべて有効です`);
}

// CLI として直接実行されたときだけ走らせる。 test が helper を import しても
// validation 全体が走らないようにする (= 他 scripts/*.ts と同じ import.meta.main guard)。
if (import.meta.main) {
  main();
}
