import type {
  CloudDataRepository,
  CloudDeploymentsCoordination,
} from "../../control-data/cloud-data-ports.js";
import type { EventRecord } from "../../control-data/domain/events.js";
import { type CloudCoordinationApi, settleNativeEvent } from "./coordination-routes.js";
import { createNativeArtifactResolver, createNativeCatalogProvider } from "./execution-config.js";

/** The API and operator close path resolve saved run artifacts through the same native transactions. */
export function createProductionNativeCoordination(options: {
  readonly repository: Pick<CloudDataRepository, "getEvent">;
  readonly store: CloudDeploymentsCoordination;
  readonly artifactBucket: string;
  readonly region: string;
  readonly catalogKey: string;
  readonly expectedBucketOwner?: string;
  readonly now?: () => number;
}): CloudCoordinationApi & { closeEvent(eventId: string, atMs: number): Promise<EventRecord> } {
  const { repository } = options;
  const api: CloudCoordinationApi = {
    store: options.store,
    catalog: createNativeCatalogProvider(options),
    resolve: createNativeArtifactResolver(options),
  };
  return {
    ...api,
    closeEvent: async (eventId, atMs) => {
      const event = await repository.getEvent(eventId);
      if (!event) throw new Error("Native event was not found.");
      return (
        (await settleNativeEvent(
          api,
          event,
          () => atMs,
          { status: "TEARDOWN", endsAt: new Date(atMs).toISOString(), scoringLocked: true },
          true,
        )) ?? event
      );
    },
  };
}
