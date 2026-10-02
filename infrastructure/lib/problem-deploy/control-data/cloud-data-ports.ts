import type { DynamoCloudRepository } from "./dynamodb-cloud-repository.js";
import type { DynamoDbCompetitorAccountsRepository } from "./dynamodb-competitor-accounts-repository.js";
import type { DynamoDeploymentWork } from "./dynamodb-deployment-work.js";
import type { DynamoDeploymentsCoordination } from "./dynamodb-deployments-coordination.js";

/** Existing public operations shared by the cloud adapters; private driver state is not a port. */
export type CloudDataRepository = Pick<DynamoCloudRepository, keyof DynamoCloudRepository>;
export type CloudDeploymentWork = Pick<DynamoDeploymentWork, keyof DynamoDeploymentWork>;
export type CloudCompetitorAccountsRepository = Pick<
  DynamoDbCompetitorAccountsRepository,
  keyof DynamoDbCompetitorAccountsRepository
>;
export type CloudDeploymentsCoordination = Pick<
  DynamoDeploymentsCoordination,
  keyof DynamoDeploymentsCoordination
>;

export interface CloudData {
  readonly repository: CloudDataRepository;
  readonly work: CloudDeploymentWork;
  readonly accounts: CloudCompetitorAccountsRepository;
  readonly coordination: CloudDeploymentsCoordination;
  close(): void;
}

export type CloudWorkData = Pick<CloudData, "work" | "accounts" | "close">;
