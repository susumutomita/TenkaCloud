import { describe, expect, it } from "vitest";
import {
  type CoordinationStateScope,
  DEFAULT_COORDINATION_RUN_ID,
} from "../../lib/problem-deploy/control-data/domain/coordination-scope";
import type { DeploymentRecord } from "../../lib/problem-deploy/control-data/domain/deployments.js";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository";
import { cleanupCoordinationStateIfLastDeployment } from "../../lib/problem-deploy/handlers/shared/coordination-cleanup";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

/**
 * [Issue #3149] Coordination state outlived the problem it belonged to.
 *
 * Event teardown cleared every problem in the event, and the operator's reset
 * cleared one on request, but tearing deployments down one at a time — the
 * normal way to retire a single problem while the event keeps running — cleared
 * nothing. The state then sat until its seven-day TTL.
 *
 * Not clearing on a SINGLE deployment's teardown is correct and stays that way:
 * the state is shared, so one team leaving must not wipe the match for the
 * others. These tests pin both halves of that, and the race the issue warns
 * about between deciding "this was the last one" and acting on it.
 *
 * Run against a real SQLite database through the real repository, not a mock:
 * the decision this module makes is a read followed by a conditional write, and
 * a fake that returns whatever the test arranged cannot show that the condition
 * is doing anything.
 */

const TENANT = "tenant-a";
const EVENT = "ev-1";
const PROBLEM = "crypto-battle";
const SCOPE: CoordinationStateScope = {
  tenantId: TENANT,
  eventId: EVENT,
  problemId: PROBLEM,
  runId: DEFAULT_COORDINATION_RUN_ID,
};

function deployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  const base: DeploymentRecord = {
    jobId: "j1",
    tenantId: TENANT,
    listTenantId: TENANT,
    eventId: EVENT,
    problemId: PROBLEM,
    teamId: "team-a",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "alpha",
    namePrefix: "tc-alpha-p1",
    teamLoginKey: "KEY-A",
    status: "COMPLETE",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: 4_102_444_800,
  };
  return { ...base, ...overrides };
}

async function makeRepository(): Promise<SqlDeploymentsRepository> {
  return new SqlDeploymentsRepository(makeSqliteExecutor());
}

/** Writes one state row and returns the version it now carries. */
async function seedState(
  repository: SqlDeploymentsRepository,
  scope: CoordinationStateScope = SCOPE,
  state: unknown = { turn: 7 },
): Promise<number> {
  await repository.writeCoordinationState(scope, state, 0, "2026-07-01T00:00:00.000Z", 0);
  return (await repository.readCoordinationState(scope))?.version ?? 0;
}

describe("cleanupCoordinationStateIfLastDeployment (#3149)", () => {
  it("should keep the state while another team on the problem can still play", async () => {
    const repository = await makeRepository();
    await seedState(repository);
    // Team A is being torn down; team B is untouched. Removing the shared state
    // here would end the match for team B because team A left.
    await repository.putDeployment(
      deployment({ jobId: "a", teamId: "team-a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );
    await repository.putDeployment(deployment({ jobId: "b", teamId: "team-b" }));

    const outcome = await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    expect(outcome).toEqual({ kind: "retained", liveDeployments: 1 });
    expect(await repository.readCoordinationState(SCOPE)).toBeDefined();
  });

  it("should delete the state once the last team on the problem is torn down", async () => {
    const repository = await makeRepository();
    await seedState(repository);
    await repository.putDeployment(
      deployment({ jobId: "a", teamId: "team-a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );
    await repository.putDeployment(
      deployment({ jobId: "b", teamId: "team-b", teardownRequestedAt: "2026-07-02T00:01:00.000Z" }),
    );

    const outcome = await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    expect(outcome).toMatchObject({ kind: "deleted" });
    expect(await repository.readCoordinationState(SCOPE)).toBeUndefined();
  });

  it("should count a FAILED teardown as gone rather than as a live deployment", async () => {
    const repository = await makeRepository();
    await seedState(repository);
    // [Issue #3128] A teardown that fails moves the row to FAILED, which is
    // indistinguishable from a failed DEPLOY by status alone. Counting by
    // status would leave this problem's state behind forever, because the row
    // never reaches a deleted-like status and nothing else ever removes it.
    await repository.putDeployment(
      deployment({
        jobId: "a",
        status: "FAILED",
        teardownRequestedAt: "2026-07-02T00:00:00.000Z",
      }),
    );

    expect(
      await cleanupCoordinationStateIfLastDeployment(
        { repository },
        { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
      ),
    ).toMatchObject({ kind: "deleted" });
  });

  it("should not touch another problem's state in the same event", async () => {
    const repository = await makeRepository();
    const otherScope = { ...SCOPE, problemId: "other-battle" };
    await seedState(repository);
    await seedState(repository, otherScope, { turn: 99 });
    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );
    await repository.putDeployment(deployment({ jobId: "o", problemId: "other-battle" }));

    await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    // The whole point of the per-problem scope (#3123). A cleanup that reached
    // sideways would end a match nobody asked to end.
    const other = await repository.readCoordinationState(otherScope);
    expect(other?.state).toMatchObject({ turn: 99 });
  });

  it("should not touch another event's state for the same problem", async () => {
    const repository = await makeRepository();
    const otherEvent = { ...SCOPE, eventId: "ev-2" };
    await seedState(repository);
    await seedState(repository, otherEvent, { turn: 42 });
    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );
    await repository.putDeployment(deployment({ jobId: "e2", eventId: "ev-2" }));

    await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    expect((await repository.readCoordinationState(otherEvent))?.state).toMatchObject({ turn: 42 });
  });

  it("should report absent rather than deleting when the match never started", async () => {
    const repository = await makeRepository();
    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );

    expect(
      await cleanupCoordinationStateIfLastDeployment(
        { repository },
        { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
      ),
    ).toEqual({ kind: "absent" });
  });

  it("should skip a deployment that carries no event", async () => {
    const repository = await makeRepository();
    // The pre-event `POST /problems/:id/deploy` path produces rows with no
    // event. They have no coordination namespace, so there is nothing to
    // address; inventing one would send a delete at rows that do not exist.
    expect(
      await cleanupCoordinationStateIfLastDeployment(
        { repository },
        { tenantId: TENANT, problemId: PROBLEM },
      ),
    ).toEqual({ kind: "not_applicable" });
  });
});

describe("cleanup vs. a new deployment, raced (#3149)", () => {
  /**
   * The race the issue names: a new deployment lands between the decision and
   * the delete. The dangerous half is the one where that deployment has already
   * been played, because then the row holds a match in progress.
   */
  it("should refuse the delete when the match was played after the decision", async () => {
    const repository = await makeRepository();
    const staleVersion = await seedState(repository);
    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );

    // A new team deploys and immediately plays a move, exactly in the window
    // between the count and the delete.
    await repository.putDeployment(deployment({ jobId: "c", teamId: "team-c" }));
    await repository.writeCoordinationState(
      SCOPE,
      { turn: 8 },
      staleVersion,
      "2026-07-02T00:00:30.000Z",
      0,
    );

    const outcome = await repository.deleteCoordinationStateIfUnchanged(SCOPE, staleVersion);

    expect(outcome).toEqual({ outcome: "conflict" });
    // The live match survives untouched, which is the only acceptable outcome:
    // an unconditional delete here would report success while ending a game
    // people are playing.
    expect((await repository.readCoordinationState(SCOPE))?.state).toMatchObject({ turn: 8 });
  });

  it("should still delete when nothing moved between the decision and the delete", async () => {
    const repository = await makeRepository();
    const version = await seedState(repository);
    expect(await repository.deleteCoordinationStateIfUnchanged(SCOPE, version)).toEqual({
      outcome: "updated",
    });
    expect(await repository.readCoordinationState(SCOPE)).toBeUndefined();
  });

  it("should report a conflict, not a success, when the row is already gone", async () => {
    const repository = await makeRepository();
    const version = await seedState(repository);
    await repository.deleteCoordinationState(SCOPE);
    // From the caller's side "someone else removed it" and "someone else
    // changed it" are the same fact: the state you were about to remove is not
    // the state that is there now.
    expect(await repository.deleteCoordinationStateIfUnchanged(SCOPE, version)).toEqual({
      outcome: "conflict",
    });
  });

  it("should refuse to build a conditional delete from version 0", async () => {
    const repository = await makeRepository();
    // 0 means "no row" everywhere else in this port. Accepting it would leave
    // the backend choosing between refusing every call and deleting
    // unconditionally — and the second reintroduces the race the condition
    // exists to close.
    await expect(repository.deleteCoordinationStateIfUnchanged(SCOPE, 0)).rejects.toThrow(
      RangeError,
    );
  });

  it("should take the match secret with the state, but only once the delete lands", async () => {
    const repository = await makeRepository();
    const version = await seedState(repository);
    await repository.ensureCoordinationMatchSecret(SCOPE, "s".repeat(64), 0);

    // A refused delete must leave the secret alone: the match is still being
    // played and is still deriving shares from that exact value. Removing it
    // would make the next op mint a different secret under a live game.
    expect(await repository.deleteCoordinationStateIfUnchanged(SCOPE, version + 5)).toEqual({
      outcome: "conflict",
    });
    expect(await repository.readCoordinationMatchSecret(SCOPE)).toBe("s".repeat(64));

    expect(await repository.deleteCoordinationStateIfUnchanged(SCOPE, version)).toEqual({
      outcome: "updated",
    });
    expect(await repository.readCoordinationMatchSecret(SCOPE)).toBeUndefined();
  });
});

describe("cleanup must not change an identifier it did not issue (#3149)", () => {
  /**
   * The negative test every cleanup PR in this area owes.
   *
   * The recorded harm: a plugin derived an order's sequence number from the
   * length of a retained list, so a cleanup that shortened that list rolled the
   * counter back, re-issued ids that were already live, and had `validateOp`
   * reject in-flight work as already complete.
   *
   * The platform-side property that keeps this module clear of that class of
   * bug is that it only ever deletes a whole scope: it never rewrites a
   * surviving row, so no counter derived from any surviving row can move.
   */
  it("should leave every surviving scope byte-identical, including its version", async () => {
    const repository = await makeRepository();
    const survivor = { ...SCOPE, problemId: "survivor-battle" };
    await seedState(repository, SCOPE, { orders: ["o-1", "o-2", "o-3"] });
    await seedState(repository, survivor, { orders: ["o-1", "o-2"] });
    // Bump the survivor so its version is something a naive rewrite would
    // disturb.
    await repository.writeCoordinationState(
      survivor,
      { orders: ["o-1", "o-2", "o-3", "o-4"] },
      1,
      "2026-07-02T00:00:00.000Z",
      0,
    );
    const before = await repository.readCoordinationState(survivor);

    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );
    await repository.putDeployment(deployment({ jobId: "s", problemId: "survivor-battle" }));
    await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    const after = await repository.readCoordinationState(survivor);
    expect(after?.version).toBe(before?.version);
    expect(after?.state).toEqual(before?.state);
  });

  it("should never partially rewrite the scope it removes", async () => {
    const repository = await makeRepository();
    const version = await seedState(repository, SCOPE, { orders: ["o-1", "o-2", "o-3"] });
    await repository.putDeployment(
      deployment({ jobId: "a", teardownRequestedAt: "2026-07-02T00:00:00.000Z" }),
    );

    await cleanupCoordinationStateIfLastDeployment(
      { repository },
      { tenantId: TENANT, eventId: EVENT, problemId: PROBLEM },
    );

    // Whole scope or nothing. A cleanup that pruned entries out of a surviving
    // row is the shape that rolled a plugin's id counter back; there is no code
    // path here that can produce one.
    expect(await repository.readCoordinationState(SCOPE)).toBeUndefined();
    expect(version).toBeGreaterThan(0);
  });
});
