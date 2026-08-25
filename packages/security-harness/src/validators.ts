/**
 * Strict validator for `SecurityHarnessDefinition` (Issue #3036 evidence boundary: "unknown
 * field / oversized artifact / unexpected file type を拒否する"). Like `validateHttpSequenceWitness`
 * in ./witness.ts, this never throws on bad input — it returns a diagnostic list so a problem
 * author's malformed definition fails loudly and specifically instead of the harness guessing at
 * defaults.
 */

import type { SecurityHarnessDefinition } from "./types.js";
import type { ValidationResult } from "./witness.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function pushUnknownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(`${prefix}: unknown field "${key}"`);
  }
}

function validateCommandContract(value: unknown, prefix: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(value, new Set(["operationId", "args"]), prefix, errors);
  if (!isNonEmptyString(value.operationId)) {
    errors.push(
      `${prefix}.operationId: must be a non-empty string (a reviewed operation id, not a raw shell command)`,
    );
  }
  if (value.args !== undefined) {
    if (
      !isPlainObject(value.args) ||
      Object.values(value.args).some((v) => typeof v !== "string")
    ) {
      errors.push(`${prefix}.args: must be a plain string-to-string object`);
    }
  }
}

function validateReadiness(value: unknown, errors: string[]): void {
  const prefix = "definition.target.readiness";
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(value, new Set(["path", "expectedStatus", "timeoutMs"]), prefix, errors);
  if (!isNonEmptyString(value.path) || !value.path.startsWith("/")) {
    errors.push(`${prefix}.path: must be a non-empty absolute path`);
  }
  if (typeof value.expectedStatus !== "number") {
    errors.push(`${prefix}.expectedStatus: must be a number`);
  }
  if (typeof value.timeoutMs !== "number" || value.timeoutMs <= 0) {
    errors.push(`${prefix}.timeoutMs: must be a positive number`);
  }
}

function validateGoldenTests(value: unknown, errors: string[]): void {
  const prefix = "definition.target.goldenTests";
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${prefix}: must be a non-empty array`);
    return;
  }
  value.forEach((t: unknown, i: number) => {
    if (!isPlainObject(t) || !isNonEmptyString(t.id) || !isNonEmptyString(t.description)) {
      errors.push(`${prefix}[${i}]: must have a non-empty id and description`);
    }
  });
}

function validateTarget(value: unknown, errors: string[]): void {
  const prefix = "definition.target";
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(
    value,
    new Set(["artifactDigest", "runtime", "build", "start", "readiness", "goldenTests"]),
    prefix,
    errors,
  );
  if (!isNonEmptyString(value.artifactDigest) || !value.artifactDigest.startsWith("sha256:")) {
    errors.push(`${prefix}.artifactDigest: must be a "sha256:<hex>" content digest`);
  }
  if (value.runtime !== "container") {
    errors.push(`${prefix}.runtime: must be "container"`);
  }
  validateCommandContract(value.build, `${prefix}.build`, errors);
  validateCommandContract(value.start, `${prefix}.start`, errors);
  validateReadiness(value.readiness, errors);
  validateGoldenTests(value.goldenTests, errors);
}

function validateEngagement(value: unknown, errors: string[]): void {
  const prefix = "definition.engagement";
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(
    value,
    new Set(["threatModelDigest", "allowedTargetIds", "allowedNetworkScopes", "nonGoals"]),
    prefix,
    errors,
  );
  if (
    !isNonEmptyString(value.threatModelDigest) ||
    !value.threatModelDigest.startsWith("sha256:")
  ) {
    errors.push(`${prefix}.threatModelDigest: must be a "sha256:<hex>" content digest`);
  }
  if (!isStringArray(value.allowedTargetIds))
    errors.push(`${prefix}.allowedTargetIds: must be a string array`);
  if (!isStringArray(value.allowedNetworkScopes)) {
    errors.push(`${prefix}.allowedNetworkScopes: must be a string array`);
  }
  if (!isStringArray(value.nonGoals)) errors.push(`${prefix}.nonGoals: must be a string array`);
}

const KNOWN_WITNESS_TYPES: ReadonlySet<string> = new Set([
  "http-sequence",
  "crash-input",
  "executable-test",
  "state-predicate",
  "log-query",
]);

function validateWitnessDeclaration(value: unknown, errors: string[]): void {
  const prefix = "definition.witness";
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(value, new Set(["type", "verifierId", "minimumReproductions"]), prefix, errors);
  if (typeof value.type !== "string" || !KNOWN_WITNESS_TYPES.has(value.type)) {
    errors.push(`${prefix}.type: must be a known witness type`);
  }
  if (!isNonEmptyString(value.verifierId))
    errors.push(`${prefix}.verifierId: must be a non-empty string`);
  if (
    typeof value.minimumReproductions !== "number" ||
    !Number.isInteger(value.minimumReproductions) ||
    value.minimumReproductions < 1
  ) {
    errors.push(
      `${prefix}.minimumReproductions: must be an integer >= 1 — 0 would confirm without ever reproducing`,
    );
  }
}

function validateBudget(value: unknown, errors: string[]): void {
  const prefix = "definition.budget";
  if (!isPlainObject(value)) {
    errors.push(`${prefix}: expected an object`);
    return;
  }
  pushUnknownKeys(value, new Set(["wallClockSeconds", "maxToolCalls"]), prefix, errors);
  if (typeof value.wallClockSeconds !== "number" || value.wallClockSeconds <= 0) {
    errors.push(`${prefix}.wallClockSeconds: must be a positive number`);
  }
  if (typeof value.maxToolCalls !== "number" || value.maxToolCalls <= 0) {
    errors.push(`${prefix}.maxToolCalls: must be a positive number`);
  }
}

export function validateSecurityHarnessDefinition(
  value: unknown,
): ValidationResult<SecurityHarnessDefinition> {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["definition: expected an object"] };
  }
  const errors: string[] = [];
  pushUnknownKeys(
    value,
    new Set(["version", "target", "engagement", "witness", "budget"]),
    "definition",
    errors,
  );
  if (value.version !== "tenkacloud.security-harness.v1") {
    errors.push('definition.version: must be "tenkacloud.security-harness.v1"');
  }
  validateTarget(value.target, errors);
  validateEngagement(value.engagement, errors);
  validateWitnessDeclaration(value.witness, errors);
  validateBudget(value.budget, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as unknown as SecurityHarnessDefinition, errors: [] };
}
