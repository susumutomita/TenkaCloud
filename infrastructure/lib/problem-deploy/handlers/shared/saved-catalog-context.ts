import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { EventRecord } from "../../control-data/events-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import type { DeploymentItem } from "../deploy-handler/types.js";
import type { ResolvedExecutionCatalog } from "./execution-catalog.js";

export type SavedCatalogLoader = (key: string | undefined) => Promise<ResolvedExecutionCatalog>;
export interface CatalogScope {
  readonly tenantId?: string;
  readonly eventId?: string;
  readonly catalogKey?: string;
}
export interface SavedCatalogResources {
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly eventsTableName: string;
  readonly catalogLoader?: SavedCatalogLoader;
}

/** Read authorization/lifecycle rows live; only challenge content comes from the saved catalog. */
export async function resolveSavedCatalogContext(
  shared: SavedCatalogResources,
  scope: CatalogScope,
): Promise<{ catalog: ResolvedExecutionCatalog; event?: EventRecord } | undefined> {
  if (!shared.catalogLoader) return undefined;
  let key = scope.catalogKey;
  let event: EventRecord | undefined;
  if (scope.eventId) {
    if (!scope.tenantId) throw new Error("catalog_scope_missing: event tenant is required");
    event = await readSavedEvent(shared, scope.tenantId, scope.eventId);
    if (event.catalogKey && key && event.catalogKey !== key) {
      throw new Error("catalog_pin_mismatch: event and deployment reference different catalogs");
    }
    key = event.catalogKey ?? key;
  }
  return { catalog: await shared.catalogLoader(key), event };
}

/** The event as stored now, read strongly; a missing event fails rather than reading as none. */
export async function readSavedEvent(
  shared: Pick<SavedCatalogResources, "runtime" | "ddb" | "eventsTableName">,
  tenantId: string,
  eventId: string,
): Promise<EventRecord> {
  const events = await shared.runtime.resolveEventsRepository({
    ddb: shared.ddb,
    eventsTableName: shared.eventsTableName,
  });
  const event = await events.getEvent(tenantId, eventId, true);
  if (!event) throw new Error("catalog_event_missing: saved event is unavailable");
  return event;
}

/** Current lifecycle data controls execution; normalized invalid dates close the gate. */
export function liveEventRoundWindow(
  event: Partial<EventRecord> | undefined,
  fallback: Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">,
): Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt"> {
  if (!event) return { eventStartsAt: fallback.eventStartsAt, eventEndsAt: fallback.eventEndsAt };
  const stopped = event.scoringLocked || event.status === "DRAFT";
  const ended = event.status === "ENDED" || event.status === "ARCHIVED";
  const start = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  const end = event.endsAt ? Date.parse(event.endsAt) : undefined;
  let eventEndsAt: string | undefined;
  if (ended || (end !== undefined && !Number.isFinite(end)))
    eventEndsAt = new Date(0).toISOString();
  else if (end !== undefined) eventEndsAt = new Date(end).toISOString();
  return {
    eventStartsAt: !stopped && Number.isFinite(start) ? new Date(start).toISOString() : undefined,
    eventEndsAt,
  };
}

/** End Event locks scoring, but its existing battles still owe their final tick. */
export function coordinationRoundWindow(
  event: Partial<EventRecord> | undefined,
  fallback: Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt">,
): Pick<DeploymentItem, "eventStartsAt" | "eventEndsAt"> {
  if (event?.status === "ENDED") {
    return { eventStartsAt: event.startsAt, eventEndsAt: event.endsAt };
  }
  return liveEventRoundWindow(event, fallback);
}

export function savedScoringMap(catalog: ResolvedExecutionCatalog) {
  const parsed = parseScoringEnv(JSON.stringify(catalog.scoring));
  if (Object.keys(parsed).length !== Object.keys(catalog.scoring).length) {
    throw new Error("catalog_metadata_invalid: saved scoring metadata is malformed");
  }
  return parsed;
}
