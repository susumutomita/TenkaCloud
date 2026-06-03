/**
 * [Issue #1666] Local attack-verification harness — pure logic.
 *
 * A `uptime-multi` problem can declare `scoring.attackProbes` (ADR-034): each tick the scorer
 * POSTs an attack payload (e.g. SQL injection) at the team's app and penalizes a team whose
 * defense is breached — i.e. the response status is in `vulnerableStatus`. The scorer's penalty
 * arithmetic is already unit-tested against a *mocked* response.
 *
 * This harness lets the *real* running app answer instead. It resolves each declared attackProbe
 * to a local URL (mapping `slot` → the docker-compose port) and judges whether the live baseline
 * app actually responds with its `vulnerableStatus`. That pins **metadata ↔ app agreement**: if the
 * app's auth route moves, or the payload stops bypassing auth, the probe silently stops attacking —
 * which is exactly the "hollow red-team" failure mode (a declared attack that no longer lands). The
 * harness turns that from an unnoticed regression into a loud failure.
 *
 * Pure (no fetch / no docker). The I/O shell that brings the stack up and fires is
 * scripts/verify-attacks-local.ts. The defended path (403 → no penalty) stays the scorer's
 * unit test; this proves the attack lands on the known-vulnerable baseline.
 */

export interface AttackProbeDecl {
  readonly slot: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly vulnerableStatus: readonly number[];
  readonly penalty: number;
}

export interface ResolvedLocalProbe {
  /** Human label for the report, e.g. `api POST /api/v1/auth`. */
  readonly name: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly vulnerableStatus: readonly number[];
}

/**
 * URL join with the **same semantics as the scorer** (`generic-scoring-handler/shared.ts` `joinUrl`):
 * an absolute `relPath` overrides the base; otherwise base/path are concatenated with a single `/`.
 * Kept in sync so a locally-fired probe hits the exact URL the production scorer would build.
 */
export function joinUrl(base: string, relPath: string): string {
  if (!relPath) return base;
  try {
    return new URL(relPath).toString();
  } catch {
    // relative path: fall through to slash-normalized concat.
  }
  const baseTrimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const pathTrimmed = relPath.startsWith("/") ? relPath.slice(1) : relPath;
  return `${baseTrimmed}/${pathTrimmed}`;
}

function asAttackProbe(raw: unknown, index: number): AttackProbeDecl {
  if (!raw || typeof raw !== "object") {
    throw new Error(`scoring.attackProbes[${index}] is not an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.slot !== "string" || r.slot.length === 0) {
    throw new Error(`scoring.attackProbes[${index}].slot must be a non-empty string`);
  }
  if (typeof r.path !== "string" || r.path.length === 0) {
    throw new Error(`scoring.attackProbes[${index}].path must be a non-empty string`);
  }
  if (
    !Array.isArray(r.vulnerableStatus) ||
    r.vulnerableStatus.length === 0 ||
    !r.vulnerableStatus.every((s) => typeof s === "number")
  ) {
    throw new Error(`scoring.attackProbes[${index}].vulnerableStatus must be a non-empty number[]`);
  }
  if (r.method !== undefined && r.method !== "GET" && r.method !== "POST") {
    throw new Error(`scoring.attackProbes[${index}].method must be "GET" or "POST"`);
  }
  if (r.body !== undefined && typeof r.body !== "string") {
    throw new Error(`scoring.attackProbes[${index}].body must be a string`);
  }
  return {
    slot: r.slot,
    path: r.path,
    ...(r.method ? { method: r.method as "GET" | "POST" } : {}),
    ...(r.body !== undefined ? { body: r.body as string } : {}),
    vulnerableStatus: r.vulnerableStatus as number[],
    penalty: typeof r.penalty === "number" ? r.penalty : 0,
  };
}

/** Pull `scoring.attackProbes` out of a problem's metadata. Returns `[]` when none are declared. */
export function readAttackProbes(metadata: unknown): AttackProbeDecl[] {
  const scoring =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).scoring
      : undefined;
  const probes =
    scoring && typeof scoring === "object"
      ? (scoring as Record<string, unknown>).attackProbes
      : undefined;
  if (probes === undefined) return [];
  if (!Array.isArray(probes)) {
    throw new Error("scoring.attackProbes must be an array when present");
  }
  return probes.map(asAttackProbe);
}

/**
 * Resolve each attackProbe's `slot` to a local base URL and build the URL it will be fired at.
 * An unknown slot throws loudly (no silent skip — a misdeclared slot must surface, not vanish).
 */
export function resolveLocalAttackProbes(
  probes: readonly AttackProbeDecl[],
  slotBaseUrls: Readonly<Record<string, string>>,
): ResolvedLocalProbe[] {
  return probes.map((p) => {
    const base = slotBaseUrls[p.slot];
    if (!base) {
      const known = Object.keys(slotBaseUrls).join(", ") || "none";
      throw new Error(
        `attackProbe references slot '${p.slot}' which has no local base URL (known slots: ${known})`,
      );
    }
    const method = p.method ?? "GET";
    return {
      name: `${p.slot} ${method} ${p.path}`,
      url: joinUrl(base, p.path),
      method,
      ...(p.body !== undefined ? { body: p.body } : {}),
      vulnerableStatus: p.vulnerableStatus,
    };
  });
}

export interface ProbeOutcome {
  readonly name: string;
  readonly expected: readonly number[];
  readonly actual: number;
  /** The attack landed on the vulnerable baseline (`actual` ∈ `vulnerableStatus`). */
  readonly fired: boolean;
}

/** Judge one fired probe against the live app's response status. */
export function evaluateProbeOutcome(
  probe: ResolvedLocalProbe,
  actualStatus: number,
): ProbeOutcome {
  return {
    name: probe.name,
    expected: probe.vulnerableStatus,
    actual: actualStatus,
    fired: probe.vulnerableStatus.includes(actualStatus),
  };
}

export interface VerificationSummary {
  readonly total: number;
  readonly firedCount: number;
  /** Every declared probe landed on the vulnerable baseline — the red-team attacks are real. */
  readonly allFired: boolean;
}

export function summarizeVerification(outcomes: readonly ProbeOutcome[]): VerificationSummary {
  const firedCount = outcomes.filter((o) => o.fired).length;
  return {
    total: outcomes.length,
    firedCount,
    allFired: outcomes.length > 0 && firedCount === outcomes.length,
  };
}
