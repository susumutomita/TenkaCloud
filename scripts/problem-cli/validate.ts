import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { KINDS } from "./constants";
import { findProblemDir, getTemplateName } from "./problem-loader";

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
  const cfnTemplate = getTemplateName(meta);
  const templatePath = join(dir, cfnTemplate);
  const ctx: ValidationContext = { dir, problemId, meta, templatePath };
  validateMetadataBasics(ctx, cfnTemplate, errors);
  validateScoringKind(ctx, errors);
  validateEndpointOutputs(ctx, errors);
  validateDashboardSlots(ctx, errors);
  return { ok: errors.length === 0, errors };
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
    errors.push(`scoring.kind="${kind}" is not a recognized kind`);
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
        `scoring.flagOutputKey="${flagKey}" not found in template.yaml Outputs (= scoring engine が読めない)`,
      );
    }
  }
  if (kind === "attack-detection") {
    const statsKey = scoring.statsOutputKey;
    if (typeof statsKey === "string" && !yaml.includes(`${statsKey}:`)) {
      errors.push(`scoring.statsOutputKey="${statsKey}" not found in template.yaml Outputs`);
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
        `endpoints[slot=${String(ep.slot)}].default.key="${key}" not found in template.yaml Outputs`,
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
        errors.push(`dashboard.slots["${slotName}"]="${slotPath}" file not found at ${physical}`);
      }
    }
  }
}
