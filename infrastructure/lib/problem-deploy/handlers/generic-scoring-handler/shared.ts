import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type ProblemDisruptionEntry,
  parseDisruptionsCatalogEnv,
} from "../../../utils/discover-problems-catalog.js";
import { type ProblemEndpointSlot, parseEndpointsEnv } from "../../../utils/endpoints-metadata.js";
import { readCatalogBlob } from "../../../utils/read-catalog-blob.js";
import { type ProblemScoringMetadata, parseScoringEnv } from "../../../utils/scoring-metadata.js";
import type { DeploymentsRepository } from "../../control-data/deployments-repository.js";
import type { DisruptionsRepository } from "../../control-data/disruptions-repository.js";
import type { ProblemEndpointsRepository } from "../../control-data/problem-endpoints-repository.js";
import type { ControlDataRuntime } from "../../control-data/runtime-repositories.js";
import { parseProblemsCatalog } from "../shared/catalog.js";

/** Lambda-only composition for scoring, reconciliation, and Composite DAG continuation. */
export interface GenericScoringSharedResources {
  readonly runtime: ControlDataRuntime;
  readonly ddb: DynamoDBDocumentClient;
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly endpointsTableName: string;
  readonly competitorAccountsTableName: string;
  readonly problemsScoring: Record<string, ProblemScoringMetadata>;
  readonly problemsEndpoints: Record<string, readonly ProblemEndpointSlot[]>;
  readonly problemsDisruptions: Record<string, readonly ProblemDisruptionEntry[]>;
  readonly problemsCatalog: Readonly<Record<string, string>>;
  readonly disruptionsTableName: string;
  readonly eventBusName: string;
  readonly events: EventBridgeClient;
  readonly env: string;
  readonly ssm: SSMClient;
  readonly sakuraAppRunBaseUrl?: string;
}

export function buildSharedResources(runtime: ControlDataRuntime): GenericScoringSharedResources {
  return {
    runtime,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    deploymentsTableName: process.env.DEPLOYMENTS_TABLE_NAME ?? "",
    eventsTableName: process.env.EVENTS_TABLE_NAME ?? "",
    endpointsTableName: process.env.PROBLEM_ENDPOINTS_TABLE_NAME ?? "",
    competitorAccountsTableName: process.env.COMPETITOR_ACCOUNTS_TABLE_NAME ?? "",
    problemsScoring: parseScoringEnv(readCatalogBlob("BATTLE_PROBLEMS_SCORING")),
    problemsEndpoints: parseEndpointsEnv(process.env.PROBLEM_ENDPOINTS),
    problemsDisruptions: parseDisruptionsCatalogEnv(process.env.BATTLE_PROBLEMS_DISRUPTIONS),
    problemsCatalog: parseProblemsCatalog(process.env.BATTLE_PROBLEMS_CATALOG),
    disruptionsTableName: process.env.DISRUPTIONS_TABLE_NAME ?? "",
    eventBusName: process.env.DEPLOY_EVENT_BUS_NAME ?? "",
    events: new EventBridgeClient({}),
    env: process.env.DEPLOY_ENVIRONMENT ?? "",
    ssm: new SSMClient({}),
    sakuraAppRunBaseUrl: process.env.SAKURA_APPRUN_BASE_URL || undefined,
  };
}

export interface GenericScoringDeploymentsSharedResources {
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly deploymentsTableName: string;
}

export function resolveDeploymentsRepository(
  shared: GenericScoringDeploymentsSharedResources,
): Promise<DeploymentsRepository> {
  return shared.runtime.resolveDeploymentsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    deploymentsTableName: shared.deploymentsTableName,
  });
}

export interface GenericScoringEndpointsSharedResources {
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly endpointsTableName: string;
}

export function resolveProblemEndpointsRepository(
  shared: GenericScoringEndpointsSharedResources,
): Promise<ProblemEndpointsRepository> {
  return shared.runtime.resolveProblemEndpointsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    endpointsTableName: shared.endpointsTableName,
  });
}

export interface GenericScoringDisruptionsSharedResources {
  readonly runtime: ControlDataRuntime;
  readonly ddb: Pick<DynamoDBDocumentClient, "send">;
  readonly disruptionsTableName: string;
}

export function resolveDisruptionsRepository(
  shared: GenericScoringDisruptionsSharedResources,
): Promise<DisruptionsRepository> {
  return shared.runtime.resolveDisruptionsRepository({
    ddb: shared.ddb as DynamoDBDocumentClient,
    disruptionsTableName: shared.disruptionsTableName,
  });
}

export * from "./scoring-kernel.js";
