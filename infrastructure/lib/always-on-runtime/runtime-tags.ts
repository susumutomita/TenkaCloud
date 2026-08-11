import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Issue #2293 — the Always-On runtime **tagging contract**. Every event-runtime CDK stack/resource
 * carries this `TenkaCloud:*` tag set so the
 * cleanup sweeper ({@link ./sweeper/sweep.ts}) can find and force-destroy runtimes whose event has
 * ended — and, crucially, can tell its own stacks apart from Lite/SaaS stacks it must never touch.
 *
 * The contract requires four tags:
 *   - `TenkaCloud:EventId`    — ULID of the event (cleanup sweeper + per-event cost attribution)
 *   - `TenkaCloud:TenantId`   — tenant identifier (cross-tenant hygiene audits)
 *   - `TenkaCloud:ExpiresAt`  — ISO-8601 hard deadline (event end + grace); anything past this is swept
 *   - `TenkaCloud:ManagedBy`  — always `always-on-runtime`; the discriminator the sweeper keys on so
 *                               it can NEVER touch a Lite/SaaS/competitor stack.
 */

export const TAG_EVENT_ID = "TenkaCloud:EventId";
export const TAG_TENANT_ID = "TenkaCloud:TenantId";
export const TAG_EXPIRES_AT = "TenkaCloud:ExpiresAt";
export const TAG_MANAGED_BY = "TenkaCloud:ManagedBy";

/** The one and only `TenkaCloud:ManagedBy` value the cleanup sweeper is allowed to act on. */
export const MANAGED_BY_ALWAYS_ON_RUNTIME = "always-on-runtime";

export interface AlwaysOnRuntimeTagOptions {
  /** ULID of the event this runtime serves. */
  readonly eventId: string;
  /** Tenant identifier that owns the event. */
  readonly tenantId: string;
  /** Hard deadline (event end + grace). A `Date` or any string `new Date()` can parse. */
  readonly expiresAt: Date | string;
}

/**
 * Normalize an expiry to a canonical ISO-8601 string. Throws loudly on an unparseable value —
 * a runtime tagged with a garbage `ExpiresAt` would be invisible to the sweeper and leak cost
 * forever, so we refuse to apply the tag rather than silently accept it (repo fail-loud rule).
 */
export function normalizeExpiresAt(expiresAt: Date | string): string {
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `TenkaCloud:ExpiresAt must be a valid Date or ISO-8601 string; received ${JSON.stringify(
        expiresAt,
      )}. Refusing to tag an always-on runtime with an unparseable expiry (it would leak past cleanup).`,
    );
  }
  return date.toISOString();
}

/**
 * Apply the four tags to `scope` (a Stack or any Construct — CDK propagates tags to
 * every taggable resource beneath it). `expiresAt` is normalized to ISO-8601 first, so a bad value
 * fails at synth time, not silently at sweep time.
 */
export function applyAlwaysOnRuntimeTags(scope: Construct, opts: AlwaysOnRuntimeTagOptions): void {
  const expiresAtIso = normalizeExpiresAt(opts.expiresAt);
  const tags = cdk.Tags.of(scope);
  tags.add(TAG_EVENT_ID, opts.eventId);
  tags.add(TAG_TENANT_ID, opts.tenantId);
  tags.add(TAG_EXPIRES_AT, expiresAtIso);
  tags.add(TAG_MANAGED_BY, MANAGED_BY_ALWAYS_ON_RUNTIME);
}
