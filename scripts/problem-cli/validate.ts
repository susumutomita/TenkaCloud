import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { KINDS } from "./constants";
import {
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  findProblemDir,
  getTemplateName,
  normalizeRuntime,
} from "./problem-loader";

export interface ValidateResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

interface ValidationContext {
  readonly dir: string;
  readonly problemId: string;
  readonly meta: Record<string, unknown>;
  readonly templatePath: string;
}

export function runValidate(problemId: string): ValidateResult {
  const dir = findProblemDir(problemId);
  if (!dir) {
    return { ok: false, errors: [`Problem dir not found for id="${problemId}"`] };
  }
  const errors: string[] = [];
  const meta = loadMetadataForValidation(dir, errors);
  if (!meta) {
    return { ok: false, errors };
  }
  validateRuntime(meta, errors);
  const cfnTemplate = getTemplateName(meta);
  const templatePath = join(dir, cfnTemplate);
  const ctx: ValidationContext = { dir, problemId, meta, templatePath };
  validateMetadataBasics(ctx, cfnTemplate, errors);
  validateScoringKind(ctx, errors);
  validateEndpointOutputs(ctx, errors);
  validateDashboardSlots(ctx, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * [ADR-023] Phase 1: optional `runtime` field の検証。
 *   - normalize 失敗 (= 不完全な runtime block) は明示エラー
 *   - `runtime` と `cfnTemplate` 両方宣言時は `runtime.entry === cfnTemplate` を強制 (= 互換期間)
 *   - executable な combination は `aws` + `cloudformation` のみ。 それ以外は reject する
 *     (= author が deploy できない問題を ship するのを止める)。 reject 理由は 2 種に分岐:
 *       - reserved (ADR-026/027 の roadmap provider, tracker #1408) → 「adapter 着地後に author 可」
 *       - unknown (typo の可能性) → 「provider/engine の綴りを確認」
 */
function validateRuntime(meta: Record<string, unknown>, errors: string[]): void {
  const runtimeBlock = meta.runtime;
  if (runtimeBlock !== undefined) {
    const normalized = normalizeRuntime(meta);
    if (!normalized) {
      errors.push(
        "runtime block must declare provider / engine / entry (all strings). See ADR-023.",
      );
      return;
    }
    const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : undefined;
    if (cfnTemplate !== undefined && cfnTemplate !== normalized.entry) {
      errors.push(
        `runtime.entry="${normalized.entry}" and cfnTemplate="${cfnTemplate}" must match during the dual-field compatibility window (ADR-023 D2).`,
      );
    }
    const support = classifyRuntimeSupport(normalized);
    if (support === "reserved") {
      errors.push(
        `Runtime ${normalized.provider}/${normalized.engine} is a planned provider/engine (ADR-026/ADR-027, tracker #1408) but is not yet executable — author it once the engine adapter lands. Executable today: ${EXECUTABLE_PROVIDER}/${EXECUTABLE_ENGINE} (ADR-023 D4).`,
      );
    } else if (support === "unknown") {
      errors.push(
        `Runtime ${normalized.provider}/${normalized.engine} is not a recognized runtime (check provider/engine for typos). Executable today: ${EXECUTABLE_PROVIDER}/${EXECUTABLE_ENGINE} (ADR-023 D4).`,
      );
    }
  }
}

function loadMetadataForValidation(
  dir: string,
  errors: string[],
): Record<string, unknown> | undefined {
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) {
    errors.push("metadata.json not found");
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    errors.push(`metadata.json parse error: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function validateMetadataBasics(
  ctx: ValidationContext,
  cfnTemplate: string,
  errors: string[],
): void {
  const { dir, meta, problemId, templatePath } = ctx;
  if (meta.id !== problemId) {
    errors.push(`metadata.id="${String(meta.id)}" does not match dir name "${problemId}"`);
  }
  if (!existsSync(templatePath)) {
    errors.push(`cfnTemplate file "${cfnTemplate}" not found in ${dir}`);
  }
}

function validateScoringKind(ctx: ValidationContext, errors: string[]): void {
  const { meta, templatePath } = ctx;
  const scoring = meta.scoring as Record<string, unknown> | undefined;
  const kind = scoring?.kind;
  if (typeof kind !== "string") return;
  if (!(KINDS as readonly string[]).includes(kind) && kind !== "uptime") {
    errors.push(
      `scoring.kind="${kind}" is not a recognized kind — set it to one of ${KINDS.map((k) => `"${k}"`).join(" | ")}`,
    );
  }
  if (!existsSync(templatePath)) return;
  const yaml = readFileSync(templatePath, "utf8");
  validateScoringOutputKey(kind, scoring, yaml, errors);
}

function validateScoringOutputKey(
  kind: string,
  scoring: Record<string, unknown>,
  yaml: string,
  errors: string[],
): void {
  if (kind === "flag") {
    const flagKey = scoring.flagOutputKey;
    if (typeof flagKey === "string" && !yaml.includes(`${flagKey}:`)) {
      errors.push(
        `scoring.flagOutputKey="${flagKey}" not found in template.yaml Outputs (= scoring engine が読めない) — add an "Outputs.${flagKey}:" entry to template.yaml or fix the metadata key`,
      );
    }
  }
  if (kind === "multi-flag") {
    validateMultiFlagOutputKeys(scoring, yaml, errors);
  }
  if (kind === "attack-detection") {
    const statsKey = scoring.statsOutputKey;
    if (typeof statsKey === "string" && !yaml.includes(`${statsKey}:`)) {
      errors.push(
        `scoring.statsOutputKey="${statsKey}" not found in template.yaml Outputs — add an "Outputs.${statsKey}:" entry whose Value is the integer attack count`,
      );
    }
  }
}

/**
 * multi-flag (#1796): flags[] の各 flagOutputKey が template.yaml Outputs に居るかを個別検査。
 */
function validateMultiFlagOutputKeys(
  scoring: Record<string, unknown>,
  yaml: string,
  errors: string[],
): void {
  const flags = Array.isArray(scoring.flags) ? scoring.flags : [];
  for (const f of flags as Array<Record<string, unknown>>) {
    const flagKey = f.flagOutputKey;
    if (typeof flagKey === "string" && !yaml.includes(`${flagKey}:`)) {
      errors.push(
        `scoring.flags[id=${String(f.id)}].flagOutputKey="${flagKey}" not found in template.yaml Outputs (= scoring engine が読めない) — add an "Outputs.${flagKey}:" entry to template.yaml or fix the metadata key`,
      );
    }
  }
}

function validateEndpointOutputs(ctx: ValidationContext, errors: string[]): void {
  const { meta, templatePath } = ctx;
  const endpoints = Array.isArray(meta.endpoints) ? meta.endpoints : [];
  if (endpoints.length === 0 || !existsSync(templatePath)) return;
  const yaml = readFileSync(templatePath, "utf8");
  for (const ep of endpoints as Array<Record<string, unknown>>) {
    const def = ep.default as Record<string, unknown> | undefined;
    const key = def?.key;
    if (typeof key === "string" && !yaml.includes(`${key}:`)) {
      errors.push(
        `endpoints[slot=${String(ep.slot)}].default.key="${key}" not found in template.yaml Outputs — add an "Outputs.${key}:" entry exposing the public URL`,
      );
    }
  }
}

function validateDashboardSlots(ctx: ValidationContext, errors: string[]): void {
  const { dir, meta } = ctx;
  const dashboard = meta.dashboard as Record<string, unknown> | undefined;
  const slots = dashboard?.slots as Record<string, unknown> | undefined;
  if (!slots) return;
  for (const [slotName, slotPath] of Object.entries(slots)) {
    if (typeof slotPath === "string") {
      const physical = join(dir, slotPath);
      if (!existsSync(physical)) {
        errors.push(
          `dashboard.slots["${slotName}"]="${slotPath}" file not found at ${physical} — create the .tsx file at that path, or remove the slot from metadata.json`,
        );
      }
    }
  }
}
