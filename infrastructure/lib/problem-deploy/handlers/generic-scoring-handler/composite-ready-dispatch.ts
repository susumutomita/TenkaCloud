/**
 * [Issue #2747] Continue Composite DAG execution after upstream targets complete.
 *
 * The initial deploy request starts wave zero. Later waves are driven by the existing one-minute
 * maintenance tick after provider statuses have been refreshed. This module scans only active
 * Composite parents and reuses `dispatchCompositeDeployment`, whose PENDING/status and dependency
 * guards make every tick idempotent.
 */

import { buildAdapterDependencies } from "../deploy-handler/adapter-dependencies.js";
import { dispatchCompositeDeployment } from "../deploy-handler/composite-dispatch.js";
import { resolveCompositeTargetConnection } from "../deploy-handler/composite-target-connection.js";
import { slugify } from "../deploy-handler/naming.js";
import { selectAdapter } from "../shared/runtime/index.js";
import {
  type GenericScoringSharedResources,
  resolveDeploymentsRepository,
} from "./shared.js";

export async function dispatchCompositeReadyTargets(
  shared: GenericScoringSharedResources,
  nowMs: number,
): Promise<void> {
  const repository = await resolveDeploymentsRepository(shared);
  await repository.forEachCompositeDeployReconcilablePage(async (parents) => {
    await Promise.all(
      parents.map(async (parent) => {
        try {
          await dispatchCompositeDeployment(
            {
              repo: {
                runtime: shared.runtime,
                ddb: shared.ddb,
                tableName: shared.deploymentsTableName,
              },
              resolveConnection: (input) =>
                resolveCompositeTargetConnection(
                  {
                    aws: {
                      runtime: shared.runtime,
                      ddb: shared.ddb,
                      competitorAccountsTableName: shared.competitorAccountsTableName,
                      env: shared.env,
                    },
                    credentials: { ssm: shared.ssm, env: shared.env },
                  },
                  input,
                ),
              selectAdapter: (runtime, target) =>
                selectAdapter(
                  runtime,
                  buildAdapterDependencies(
                    {
                      env: shared.env,
                      tenantId: target.tenantId,
                      events: shared.events,
                      eventBusName: shared.eventBusName,
                      ssm: shared.ssm,
                      sakuraAppRunBaseUrl: shared.sakuraAppRunBaseUrl,
                    },
                    runtime,
                    slugify(target.teamName),
                  ),
                ),
              problemsCatalog: shared.problemsCatalog,
              now: () => nowMs,
            },
            parent.jobId,
          );
        } catch (error) {
          console.warn("[composite-dataflow] ready-target dispatch failed", {
            parentDeploymentId: parent.jobId,
            message: error instanceof Error ? error.name : "unknown error",
          });
        }
      }),
    );
  });
}
