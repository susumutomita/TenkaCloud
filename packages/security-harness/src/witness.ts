/**
 * `http-sequence` witness validation and execution (Issue #3036 evidence boundary: "path
 * traversal、symlink、socket、FIFO、device file を拒否" for file witnesses generalizes here to
 * "reject anything that is not a bounded, same-origin HTTP request/assertion pair").
 *
 * `validateHttpSequenceWitness` never throws on bad input — untrusted witness bundles are
 * expected data, not a programming error, so a validation failure is a normal return value
 * (`{ ok: false, errors }`), matching how this repo already treats evidence-boundary parsing
 * (see `infrastructure/lib/problem-deploy/handlers/shared/attack-probe-status.ts`).
 */

import type { HttpSequenceWitness, HttpWitnessStep } from "./types.js";

const MAX_STEPS = 20;
const MAX_BODY_BYTES = 4096;
const MAX_HEADER_ENTRIES = 16;
const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly errors: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_STEP_FIELDS: ReadonlySet<string> = new Set([
  "method",
  "path",
  "headers",
  "body",
  "expectStatus",
  "expectBodyIncludes",
  "expectBodyExcludes",
]);

function validateStepMethod(method: unknown, index: number, errors: string[]): void {
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
    errors.push(`steps[${index}]: method must be one of ${[...ALLOWED_METHODS].join(", ")}`);
  }
}

function validateStepPath(path: unknown, index: number, errors: string[]): void {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("://") ||
    path.includes("..")
  ) {
    errors.push(`steps[${index}]: path must be a same-origin absolute path with no ".."`);
  }
}

function validateStepHeaders(headers: unknown, index: number, errors: string[]): void {
  if (headers === undefined) return;
  if (!isPlainObject(headers) || Object.keys(headers).length > MAX_HEADER_ENTRIES) {
    errors.push(`steps[${index}]: headers must be a bounded plain object`);
  } else if (Object.values(headers).some((v) => typeof v !== "string")) {
    errors.push(`steps[${index}]: header values must be strings`);
  }
}

function validateStepBody(body: unknown, index: number, errors: string[]): void {
  if (body === undefined) return;
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    errors.push(`steps[${index}]: body must be a string of at most ${MAX_BODY_BYTES} bytes`);
  }
}

function validateStepExpectStatus(expectStatus: unknown, index: number, errors: string[]): void {
  if (
    typeof expectStatus !== "number" ||
    !Number.isInteger(expectStatus) ||
    expectStatus < 100 ||
    expectStatus > 599
  ) {
    errors.push(`steps[${index}]: expectStatus must be a valid HTTP status code`);
  }
}

function validateStepExpectBodyMatcher(
  fieldName: "expectBodyIncludes" | "expectBodyExcludes",
  fieldValue: unknown,
  index: number,
  errors: string[],
): void {
  if (fieldValue !== undefined && typeof fieldValue !== "string") {
    errors.push(`steps[${index}]: ${fieldName} must be a string`);
  }
}

function validateStep(
  value: unknown,
  index: number,
  outerErrors: string[],
): HttpWitnessStep | undefined {
  if (!isPlainObject(value)) {
    outerErrors.push(`steps[${index}]: expected an object`);
    return undefined;
  }
  const stepErrors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!KNOWN_STEP_FIELDS.has(key)) stepErrors.push(`steps[${index}]: unknown field "${key}"`);
  }
  const { method, path, headers, body, expectStatus, expectBodyIncludes, expectBodyExcludes } =
    value as Record<string, unknown>;
  validateStepMethod(method, index, stepErrors);
  validateStepPath(path, index, stepErrors);
  validateStepHeaders(headers, index, stepErrors);
  validateStepBody(body, index, stepErrors);
  validateStepExpectStatus(expectStatus, index, stepErrors);
  validateStepExpectBodyMatcher("expectBodyIncludes", expectBodyIncludes, index, stepErrors);
  validateStepExpectBodyMatcher("expectBodyExcludes", expectBodyExcludes, index, stepErrors);

  outerErrors.push(...stepErrors);
  if (stepErrors.length > 0) return undefined;
  return {
    method: method as HttpWitnessStep["method"],
    path: path as string,
    ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
    ...(body !== undefined ? { body: body as string } : {}),
    expectStatus: expectStatus as number,
    ...(expectBodyIncludes !== undefined
      ? { expectBodyIncludes: expectBodyIncludes as string }
      : {}),
    ...(expectBodyExcludes !== undefined
      ? { expectBodyExcludes: expectBodyExcludes as string }
      : {}),
  };
}

/** Strict-parses an untrusted value into an `HttpSequenceWitness`. Rejects unknown fields, oversized/empty step lists, and malformed steps instead of coercing them. */
export function validateHttpSequenceWitness(value: unknown): ValidationResult<HttpSequenceWitness> {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["witness: expected an object"] };
  }
  const known = new Set(["type", "witnessId", "focusArea", "steps"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(`witness: unknown field "${key}"`);
  }
  const { type, witnessId, focusArea, steps } = value as Record<string, unknown>;
  if (type !== "http-sequence") {
    errors.push('witness: type must be "http-sequence"');
  }
  if (typeof witnessId !== "string" || witnessId.length === 0) {
    errors.push("witness: witnessId must be a non-empty string");
  }
  if (typeof focusArea !== "string" || focusArea.length === 0) {
    errors.push("witness: focusArea must be a non-empty string");
  }
  let parsedSteps: HttpWitnessStep[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push("witness: steps must be a non-empty array");
  } else if (steps.length > MAX_STEPS) {
    errors.push(`witness: steps exceeds the ${MAX_STEPS}-step bound`);
  } else {
    const stepErrors: string[] = [];
    parsedSteps = steps
      .map((s, i) => validateStep(s, i, stepErrors))
      .filter((s): s is HttpWitnessStep => s !== undefined);
    errors.push(...stepErrors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      type: "http-sequence",
      witnessId: witnessId as string,
      focusArea: focusArea as string,
      steps: parsedSteps,
    },
    errors: [],
  };
}

export interface HttpResponseLike {
  readonly status: number;
  readonly body: string;
}

/** The only thing a witness executor needs from an HTTP transport — real `fetch` in production paths, a fake in unit tests. */
export interface HttpClient {
  request(step: HttpWitnessStep): Promise<HttpResponseLike>;
}

export interface WitnessStepOutcome extends HttpResponseLike {
  readonly passed: boolean;
}

export interface WitnessRunResult {
  /** True only when every step's response matched its declared expectation. */
  readonly success: boolean;
  readonly steps: readonly WitnessStepOutcome[];
}

function stepPassed(step: HttpWitnessStep, response: HttpResponseLike): boolean {
  if (response.status !== step.expectStatus) return false;
  if (step.expectBodyIncludes !== undefined && !response.body.includes(step.expectBodyIncludes))
    return false;
  if (step.expectBodyExcludes !== undefined && response.body.includes(step.expectBodyExcludes))
    return false;
  return true;
}

/**
 * Runs every step of a witness against `client` in order and reports whether the whole sequence
 * matched its declared assertions. The SAME witness is reused for the baseline confirmation, the
 * post-patch "original witness replay", and (with a different witness bundle) the fresh
 * re-attack: assertions describe "the vulnerable behavior", so `success === true` always means
 * that behavior is still observable, regardless of which stage is asking.
 */
export async function runHttpSequenceWitness(
  witness: HttpSequenceWitness,
  client: HttpClient,
): Promise<WitnessRunResult> {
  const steps: WitnessStepOutcome[] = [];
  let success = true;
  for (const step of witness.steps) {
    const response = await client.request(step);
    const passed = stepPassed(step, response);
    if (!passed) success = false;
    steps.push({ ...response, passed });
  }
  return { success, steps };
}
