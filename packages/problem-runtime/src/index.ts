/**
 * @tenkacloud/problem-runtime — single source of truth for problem runtime
 * classification (ADR-023 / ADR-026 / ADR-027).
 *
 * Previously this logic was hand-duplicated, in lock-step, between:
 *   - the deploy worker Lambda (`infrastructure/lib/problem-deploy/handlers/shared/runtime/normalize.ts`)
 *   - the problem CLI (`scripts/problem-cli/problem-loader.ts`)
 * The two bundles cannot share a relative module (separate workspaces / bundling
 * targets), so the rules drifted by hand. This package is the one place the
 * rules live; both sides import it (#1423).
 *
 * The functions are pure and dependency-free so the Lambda esbuild bundle and
 * the bun-run CLI can both consume the TypeScript source directly.
 */

/** Normalized runtime descriptor — the shape every reader agrees on. */
export interface RuntimeDescriptor {
  readonly provider: string;
  readonly engine: string;
  readonly entry: string;
}

/**
 * Loose metadata shape accepted by {@link normalizeRuntime}. Both callers feed
 * already-`JSON.parse`d metadata (from EventBridge / catalog payloads or
 * `metadata.json`) without a Zod schema upfront, so every field is `unknown`.
 */
export type RuntimeMetadataInput = {
  readonly runtime?: unknown;
  readonly cfnTemplate?: unknown;
};

/** The only provider/engine the platform can execute today (ADR-023 D4). */
export const EXECUTABLE_PROVIDER = "aws" as const;
export const EXECUTABLE_ENGINE = "cloudformation" as const;

/** Default deploy body filename when neither `runtime.entry` nor `cfnTemplate` is declared. */
export const DEFAULT_ENTRY = "template.yaml" as const;

/**
 * [ADR-026 / ADR-027] Provider/engine pairs the metadata layer recognizes as
 * **planned** (a real roadmap provider) but that are **not yet executable** (no
 * adapter registered). Distinguishing these from a typo lets the deploy worker
 * and the validator point authors at the tracker (#1408) instead of failing
 * generically. Each engine PR moves its pair out of this set as it ships.
 */
export const RESERVED_RUNTIMES: readonly { readonly provider: string; readonly engine: string }[] =
  [
    { provider: "sakura", engine: "apprun" }, // ADR-026
    { provider: "azure", engine: "bicep" }, // ADR-027
    { provider: "gcp", engine: "infra-manager" }, // ADR-027
  ];

/**
 * Normalize a problem's runtime descriptor. Precedence:
 *   1. An explicit `runtime` object → used as-is, but only if `provider` /
 *      `engine` / `entry` are all strings; otherwise the input is malformed and
 *      we return `undefined` (callers treat that as a loud failure).
 *   2. Legacy `cfnTemplate` (string) → `aws` / `cloudformation` / `<cfnTemplate>`.
 *   3. Neither declared → `aws` / `cloudformation` / `template.yaml`.
 *
 * `runtime` being `null` (or any non-object) is treated like "absent" and falls
 * through to the legacy/default path — never throws.
 */
export function normalizeRuntime(meta: RuntimeMetadataInput): RuntimeDescriptor | undefined {
  const runtime = meta.runtime as Record<string, unknown> | undefined | null;
  if (runtime !== undefined && runtime !== null) {
    if (
      typeof runtime.provider !== "string" ||
      typeof runtime.engine !== "string" ||
      typeof runtime.entry !== "string"
    ) {
      return undefined;
    }
    return { provider: runtime.provider, engine: runtime.engine, entry: runtime.entry };
  }
  const cfnTemplate = typeof meta.cfnTemplate === "string" ? meta.cfnTemplate : DEFAULT_ENTRY;
  return { provider: EXECUTABLE_PROVIDER, engine: EXECUTABLE_ENGINE, entry: cfnTemplate };
}

/** True when the runtime is the one executable combination (`aws/cloudformation`). */
export function isExecutableRuntime(runtime: RuntimeDescriptor): boolean {
  return runtime.provider === EXECUTABLE_PROVIDER && runtime.engine === EXECUTABLE_ENGINE;
}

/** True when the runtime is a planned-but-not-yet-executable roadmap pair. */
export function isReservedRuntime(runtime: RuntimeDescriptor): boolean {
  return RESERVED_RUNTIMES.some(
    (r) => r.provider === runtime.provider && r.engine === runtime.engine,
  );
}

export type RuntimeSupport = "executable" | "reserved" | "unknown";

/** Classify a runtime as executable / reserved (planned) / unknown (likely a typo). */
export function classifyRuntimeSupport(runtime: RuntimeDescriptor): RuntimeSupport {
  if (isExecutableRuntime(runtime)) return "executable";
  if (isReservedRuntime(runtime)) return "reserved";
  return "unknown";
}
