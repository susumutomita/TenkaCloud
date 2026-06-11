import type { ApiClient } from "./client";

/**
 * [#1417 / #1666] Operator-facing disruption (red-team) API.
 *
 *   GET  /events/:eventId/disruptions        — catalog of declared disruptions for the event's problems
 *   POST /events/:eventId/disruptions/fire   — fire one disruption at a scope (all / team / random-n)
 *   GET  /events/:eventId/disruptions/audit  — fire history (cursor-paginated)
 *
 * The mechanism is generic: a problem declares each disruption in metadata.json; the catalog
 * surfaces them, and firing publishes a `*DisruptionFired` event the cross-account executor Lambda
 * picks up (ADR-031/033/034). This client is the operator's read/fire surface.
 */

export type DisruptionScope = "all" | "team" | "random-n";

/** [ADR-037] When the injection runs: immediately, or scheduled `afterMinutes` from now. */
export type DisruptionTiming = "immediate" | "scheduled";

/**
 * [ADR-013 Phase 2] A condition that auto-fires the disruption from the scoring tick.
 * Declared in the problem's metadata.json (`disruptions[].triggers[]`, OR-combined);
 * the catalog surfaces them read-only — the metadata stays the source of truth.
 */
export type DisruptionTrigger =
  | { readonly kind: "after-deploy"; readonly afterMinutes: number }
  | { readonly kind: "team-score-above"; readonly threshold: number }
  | { readonly kind: "phase-entered"; readonly phaseName: string };

/** One declared disruption as surfaced by the catalog (a problem's metadata.json declaration). */
export interface DisruptionCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly eventDetailType: string;
  /** Parameter keys an operator may override at fire time (allow-list). */
  readonly operatorEditable?: readonly string[];
  /** Declared default parameters (operatorEditable values pre-fill from here). */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Whether competitors can see this disruption exists (operator view shows all). */
  readonly publicHint?: boolean;
  /** [ADR-037] Declared default delay (minutes) used to pre-fill the schedule input. */
  readonly defaultAfterMinutes?: number;
  /** [ADR-013 Phase 2] Auto-fire conditions (absent = manual fire only). */
  readonly triggers?: readonly DisruptionTrigger[];
}

export interface DisruptionCatalogEntry {
  readonly problemId: string;
  readonly disruption: DisruptionCatalogItem;
}

export interface DisruptionCatalogResponse {
  readonly entries: readonly DisruptionCatalogEntry[];
}

export interface FireDisruptionRequest {
  readonly problemId: string;
  readonly disruptionId: string;
  readonly scope: DisruptionScope;
  readonly targetTeamIds?: readonly string[];
  readonly randomCount?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Idempotency key (>= 8 chars); re-firing with the same id is a no-op on the platform. */
  readonly requestId: string;
  /** [ADR-037] `immediate` (default) injects now; `scheduled` defers by `afterMinutes`. */
  readonly timing?: DisruptionTiming;
  /** [ADR-037] Required when `timing === "scheduled"`; 1–1440 minutes. */
  readonly afterMinutes?: number;
}

export interface FireDisruptionResult {
  readonly auditId: string;
  readonly firedAt: string;
  readonly affectedTeamIds: readonly string[];
}

export interface DisruptionAuditRow {
  readonly auditId: string;
  readonly problemId: string;
  readonly disruptionId: string;
  readonly firedBy: string;
  readonly firedAt: string;
  readonly scope: DisruptionScope;
  readonly targetTeamIds: readonly string[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  /** [ADR-037] For a scheduled fire, the time the injection is/was due (ISO8601). */
  readonly scheduledFor?: string;
}

export interface DisruptionAuditResponse {
  readonly items: readonly DisruptionAuditRow[];
  readonly nextCursor?: string;
}

export function fetchDisruptionCatalog(
  api: ApiClient,
  eventId: string,
): Promise<DisruptionCatalogResponse> {
  return api.get<DisruptionCatalogResponse>(`events/${eventId}/disruptions`);
}

export function fireDisruption(
  api: ApiClient,
  eventId: string,
  request: FireDisruptionRequest,
): Promise<FireDisruptionResult> {
  return api.post<FireDisruptionResult>(`events/${eventId}/disruptions/fire`, request);
}

export function fetchDisruptionAudit(
  api: ApiClient,
  eventId: string,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<DisruptionAuditResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const qs = params.toString();
  return api.get<DisruptionAuditResponse>(
    `events/${eventId}/disruptions/audit${qs ? `?${qs}` : ""}`,
  );
}

/** A fresh idempotency key for a fire request (>= 8 chars). */
export function newFireRequestId(): string {
  return `fire-${crypto.randomUUID()}`;
}
