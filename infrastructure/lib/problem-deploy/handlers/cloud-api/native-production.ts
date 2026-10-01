import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { EventRecord } from "../../control-data/domain/events.js";
import { DynamoCloudRepository } from "../../control-data/dynamodb-cloud-repository.js";
import { DynamoDeploymentsCoordination } from "../../control-data/dynamodb-deployments-coordination.js";
import { type CloudCoordinationApi, settleNativeEvent } from "./coordination-routes.js";
import { createNativeArtifactResolver, createNativeCatalogProvider } from "./execution-config.js";

/** The API and operator close path share exactly the configured reviewed artifact and native transaction implementation. */
export function createProductionNativeCoordination(options: {
  readonly documentClient: DynamoDBDocumentClient;
  readonly tables: {
    readonly events: string;
    readonly teams: string;
    readonly deployments: string;
  };
  readonly artifactBucket: string;
  readonly region: string;
  readonly catalogKey: string;
  readonly expectedBucketOwner?: string;
  readonly now?: () => number;
}): CloudCoordinationApi & { closeEvent(eventId: string, atMs: number): Promise<EventRecord> } {
  const repository = new DynamoCloudRepository(options.documentClient, options.tables);
  const api: CloudCoordinationApi = {
    store: new DynamoDeploymentsCoordination(options.documentClient, options.tables),
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
