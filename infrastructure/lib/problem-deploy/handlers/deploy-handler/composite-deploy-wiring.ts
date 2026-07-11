/**
 * [Composite Runtime / Issue #2075] Production wiring for the composite deploy
 * orchestrator.
 *
 * Assembles the {@link CompositeDeployDeps} the route hands to
 * {@link startCompositeDeployment} from the already-built {@link DeployContext}.
 * Keeping this assembly out of the orchestrator keeps the orchestrator pure +
 * unit-testable: the handler test injects fake collaborators, while production
 * binds the real repository (#2061), connection resolver (#2065), adapter
 * selector (the pre-mutation runtime gate), and quota enforcer here.
 *
 * No provider credential ever flows through this module's surface — the
 * connection resolver returns secret-free identifiers only, and adapters fetch
 * their own per-team credentials from the SSM SecureString store.
 */

import { ulid } from "ulid";
import { buildCompositeDeploymentPlan, selectAdapter } from "../shared/runtime/index.js";
import { buildAdapterDependencies } from "./adapter-dependencies.js";
import type { CompositeDeployDeps } from "./composite-deploy.js";
import { dispatchCompositeDeployment } from "./composite-dispatch.js";
import { materializeCompositeDeployment } from "./composite-materialization.js";
import { createCompositeParent, createCompositeTarget } from "./composite-repository.js";
import { resolveCompositeTargetConnection } from "./composite-target-connection.js";
import type { DeployContext } from "./deploy.js";
import { enforceDeployQuota } from "./deploy-quota.js";
import { slugify } from "./naming.js";
import { generateTeamLoginKey } from "./team-key.js";

/**
 * Build the production composite-deploy collaborators from a {@link DeployContext}.
 *
 * `teamName` scopes the per-target adapter dependencies (the non-AWS adapters
 * read a per-team credential), so it is threaded through to the dispatch step.
 */
export function buildCompositeDeployDeps(
  ctx: DeployContext,
  teamName: string,
): CompositeDeployDeps {
  const repo = { runtime: ctx.runtime, ddb: ctx.ddb, tableName: ctx.tableName };

  return {
    buildPlan: buildCompositeDeploymentPlan,
    tenantId: ctx.tenantId,
    enforceQuota: (tenantId, tier) =>
      enforceDeployQuota(
        { runtime: ctx.runtime, ddb: ctx.ddb, tableName: ctx.tableName, quota: ctx.deployQuota },
        tenantId,
        tier,
      ),
    materialize: (input) =>
      materializeCompositeDeployment(
        {
          createParent: (parentInput) => createCompositeParent(repo, parentInput),
          createTarget: (targetInput) => createCompositeTarget(repo, targetInput),
          newDeploymentId: ulid,
          newTeamLoginKey: generateTeamLoginKey,
          now: ctx.now,
          ...(ctx.ttlMs !== undefined ? { ttlMs: ctx.ttlMs } : {}),
        },
        input,
      ),
    dispatch: (parentDeploymentId) =>
      dispatchCompositeDeployment(
        {
          repo,
          resolveConnection: (connectionInput) =>
            resolveCompositeTargetConnection(
              {
                aws: {
                  ddb: ctx.ddb,
                  competitorAccountsTableName: ctx.competitorAccountsTableName,
                  env: ctx.env,
                },
                credentials: { ssm: requireSsm(ctx), env: ctx.env },
              },
              connectionInput,
            ),
          // Each target selects its adapter from per-target adapter deps scoped to
          // the runtime + team. AWS targets ignore the per-team credential path.
          selectAdapter: (runtime) =>
            selectAdapter(runtime, buildAdapterDependencies(ctx, runtime, slugify(teamName))),
          problemsCatalog: ctx.problemsCatalog,
          now: ctx.now,
        },
        parentDeploymentId,
      ),
  };
}

/**
 * The non-AWS target connection resolver + non-AWS adapters need an SSM client.
 * A composite that reaches a non-AWS target without one is a wiring bug, not a
 * silent fallback — fail loudly.
 */
function requireSsm(ctx: DeployContext): NonNullable<DeployContext["ssm"]> {
  if (!ctx.ssm) {
    throw new Error(
      "composite-deploy: ctx.ssm is undefined but a composite deploy needs the per-team " +
        "SecureString store for non-AWS targets. Check CDK wiring for the SSM client.",
    );
  }
  return ctx.ssm;
}
