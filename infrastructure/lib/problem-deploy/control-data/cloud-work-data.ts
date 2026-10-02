import type { CloudWorkData } from "./cloud-data-ports.js";
import {
  type CloudDataOptions,
  createCloudProviderCache,
  runtimeCloudDataOptions,
} from "./cloud-provider-cache.js";
import { DynamoDbCompetitorAccountsRepository } from "./dynamodb-competitor-accounts-repository.js";
import { DynamoDeploymentWork } from "./dynamodb-deployment-work.js";
import { SqlCompetitorAccountsRepository } from "./sql-competitor-accounts-repository.js";
import { SqlDeploymentWork } from "./sql-deployment-work.js";

/** Workers need job/account storage; exclude the API's native plugin engine from their bundles. */
export function createCloudWorkCache(options: CloudDataOptions): () => Promise<CloudWorkData> {
  return createCloudProviderCache<Omit<CloudWorkData, "close">>(options, {
    turso: (sql) => ({
      work: new SqlDeploymentWork(sql),
      accounts: new SqlCompetitorAccountsRepository(sql),
    }),
    dynamodb: (document, tables) => ({
      work: new DynamoDeploymentWork(document, tables),
      accounts: new DynamoDbCompetitorAccountsRepository(document, tables),
    }),
  });
}

let runtime: ReturnType<typeof createCloudWorkCache> | undefined;
export function acquireCloudWork(): Promise<CloudWorkData> {
  runtime ??= createCloudWorkCache(runtimeCloudDataOptions());
  return runtime();
}
