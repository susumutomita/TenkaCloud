import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeploymentsRepositoryFacade } from "./deployments-repository-facade.js";
import { DynamoDbDeploymentsComposite } from "./dynamodb-deployments-composite.js";
import { DynamoDbDeploymentsCoordination } from "./dynamodb-deployments-coordination.js";
import { DynamoDbDeploymentsCore } from "./dynamodb-deployments-core.js";
import { DynamoDbDeploymentsLifecycle } from "./dynamodb-deployments-lifecycle.js";
import { DynamoDbDeploymentsQuery } from "./dynamodb-deployments-query.js";
import { DynamoDbDeploymentsScoring } from "./dynamodb-deployments-scoring.js";

/**
 * [Issue #2441] DynamoDB implementation of the Deployments seam.
 * [#2527 Slice 3] A composition facade: the five capability adapters
 * (query / lifecycle / scoring / composite / coordination) share one
 * {@link DynamoDbDeploymentsCore} engine. [#2866] The per-method delegation
 * table moved to the shared {@link DeploymentsRepositoryFacade} base (it was
 * byte-identical with the SQL facade); this class only wires the adapters.
 * The class name and constructor shape are unchanged, so the resolver
 * factories and tests compile untouched.
 */
export class DynamoDbDeploymentsRepository extends DeploymentsRepositoryFacade {
  constructor(ddb: DynamoDBDocumentClient, tableName: string) {
    const core = new DynamoDbDeploymentsCore(ddb, tableName);
    super({
      query: new DynamoDbDeploymentsQuery(core),
      lifecycle: new DynamoDbDeploymentsLifecycle(core),
      scoring: new DynamoDbDeploymentsScoring(core),
      composite: new DynamoDbDeploymentsComposite(core),
      coordination: new DynamoDbDeploymentsCoordination(core),
    });
  }
}
