/**
 * [Problem SDK / Issue #2225 ← #2184 RC-28-6] `composite-probe` scoring kind
 * (#2070). Extracted verbatim from scoring-metadata.ts.
 */

import { type ProgressiveHint, parseHints } from "./hints.js";
import { optionalNonEmptyString, parseExpectedStatuses } from "./primitives.js";

/** Issue #2070: one declared scoring target of a Composite problem. */
export interface CompositeProbeTarget {
  readonly targetId: string;
  readonly probe: "https";
  readonly outputKey: string;
  readonly path?: string;
  readonly expectStatus?: readonly number[];
}

/** Issue #2070: opt-in `composite-probe` scoring kind for Composite problems. */
export interface CompositeProbeScoringMetadata {
  readonly kind: "composite-probe";
  readonly targets: readonly CompositeProbeTarget[];
  readonly success: "all";
  readonly pointsAllOk: number;
  readonly hints?: readonly ProgressiveHint[];
}

/**
 * Issue #2070: narrow the opt-in `composite-probe` kind. Fail-loud (whole-object
 * reject) because a silently dropped target would change which targets gate the
 * award.
 */
export function parseCompositeProbe(value: unknown): CompositeProbeScoringMetadata | undefined {
  const c = value as {
    targets?: unknown;
    success?: unknown;
    pointsAllOk?: unknown;
    hints?: unknown;
  };
  if (c.success !== "all") return undefined;
  if (typeof c.pointsAllOk !== "number" || !Number.isFinite(c.pointsAllOk) || c.pointsAllOk <= 0) {
    return undefined;
  }
  if (!Array.isArray(c.targets) || c.targets.length === 0) return undefined;

  const targets: CompositeProbeTarget[] = [];
  const seenTargetIds = new Set<string>();
  for (const raw of c.targets) {
    const target = parseCompositeProbeTarget(raw);
    if (!target) return undefined;
    if (seenTargetIds.has(target.targetId)) return undefined;
    seenTargetIds.add(target.targetId);
    targets.push(target);
  }

  const hints = parseHints(c.hints);
  return {
    kind: "composite-probe",
    targets,
    success: "all",
    pointsAllOk: c.pointsAllOk,
    ...(hints ? { hints } : {}),
  };
}

function parseCompositeProbeTarget(value: unknown): CompositeProbeTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const t = value as {
    targetId?: unknown;
    probe?: unknown;
    outputKey?: unknown;
    path?: unknown;
    expectStatus?: unknown;
  };
  const targetId = optionalNonEmptyString(t.targetId);
  const outputKey = optionalNonEmptyString(t.outputKey);
  if (!targetId || !outputKey) return undefined;
  if (t.probe !== "https") return undefined;
  const path = optionalNonEmptyString(t.path);
  const expectStatus = parseExpectedStatuses(t.expectStatus);
  return {
    targetId,
    probe: "https",
    outputKey,
    ...(path ? { path } : {}),
    ...(expectStatus ? { expectStatus } : {}),
  };
}
