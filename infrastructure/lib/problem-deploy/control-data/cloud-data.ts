import type { CloudData } from "./cloud-data-ports.js";
import {
  type CloudDataOptions,
  createCloudProviderCache,
  runtimeCloudDataOptions,
} from "./cloud-provider-cache.js";
import { DynamoCloudRepository } from "./dynamodb-cloud-repository.js";
import { DynamoDbCompetitorAccountsRepository } from "./dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "./dynamodb-deployment-work.js";
import { DynamoDeploymentsCoordination } from "./dynamodb-deployments-coordination.js";
import { SqlCloudRepository } from "./sql-cloud-repository.js";
import { SqlCompetitorAccountsRepository } from "./sql-competitor-accounts-repository.js";
import { SqlDeploymentWork } from "./sql-deployment-work.js";
import { SqlDeploymentsCoordination } from "./sql-deployments-coordination.js";

/** API/operator composition uses the same selected provider for every durable store. */
export function createCloudDataCache(options: CloudDataOptions): () => Promise<CloudData> {
  return createCloudProviderCache<Omit<CloudData, "close">>(options, {
    turso: (sql) => ({
      repository: new SqlCloudRepository(sql),
      work: new SqlDeploymentWork(sql),
      accounts: new SqlCompetitorAccountsRepository(sql),
      coordination: new SqlDeploymentsCoordination(sql),
    }),
    dynamodb: (document, tables) => ({
      repository: new DynamoCloudRepository(document, tables),
      work: new DynamoDeploymentWork(document, tables),
      accounts: new DynamoDbCompetitorAccountsRepository(document, tables),
      coordination: new DynamoDeploymentsCoordination(document, tables),
    }),
  });
}

let runtime: ReturnType<typeof createCloudDataCache> | undefined;
/** Lazily composed once per Lambda cold start, without requiring the unselected provider's settings. */
export function acquireCloudData(): Promise<CloudData> {
  runtime ??= createCloudDataCache(runtimeCloudDataOptions());
  return runtime();
}
