import { DeploymentsRepositoryFacade } from "./deployments-repository-facade.js";
import { SqlDeploymentsComposite } from "./sql-deployments-composite.js";
import { SqlDeploymentsCoordination } from "./sql-deployments-coordination.js";
import { SqlDeploymentsCore } from "./sql-deployments-core.js";
import { SqlDeploymentsLifecycle } from "./sql-deployments-lifecycle.js";
import { SqlDeploymentsQuery } from "./sql-deployments-query.js";
import { SqlDeploymentsScoring } from "./sql-deployments-scoring.js";
import type { SqlExecutor } from "./types.js";

// The Deployments DDL stays importable from the pre-split path (libsql-executor
// bootstrap + local parity-test helpers).
export {
  DEPLOYMENTS_SCHEMA_SQL,
  DEPLOYMENTS_SCHEMA_STATEMENTS,
} from "./sql-deployments-core.js";

/**
 * [Issue #2441] SQLite (Turso/libSQL) implementation of the Deployments seam.
 * [#2527 Slice 3] A composition facade: the five capability adapters
 * (query / lifecycle / scoring / composite / coordination) share one
 * {@link SqlDeploymentsCore} engine. [#2866] The per-method delegation table
 * moved to the shared {@link DeploymentsRepositoryFacade} base (it was
 * byte-identical with the DynamoDB facade); this class only wires the adapters.
 * The class name and constructor shape are unchanged, so the resolver
 * factories and tests compile untouched.
 */
export class SqlDeploymentsRepository extends DeploymentsRepositoryFacade {
  constructor(sql: SqlExecutor) {
    const core = new SqlDeploymentsCore(sql);
    super({
      query: new SqlDeploymentsQuery(core),
      lifecycle: new SqlDeploymentsLifecycle(core),
      scoring: new SqlDeploymentsScoring(core),
      composite: new SqlDeploymentsComposite(core),
      coordination: new SqlDeploymentsCoordination(core),
    });
  }
}
