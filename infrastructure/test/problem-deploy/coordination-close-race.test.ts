import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import { initialCoordinationRunPointer } from "../../lib/problem-deploy/control-data/domain/coordination-run.js";
import { cleanupCoordinationStateIfLastDeployment } from "../../lib/problem-deploy/handlers/shared/coordination-cleanup.js";
import {
  deleteAllCoordinationRuns,
  startCoordinationRun,
} from "../../lib/problem-deploy/handlers/shared/coordination-run.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { fakeArtifactStore } from "./coordination.test-helpers.js";

const key = { tenantId: "tenant", eventId: "event", problemId: "battle" };
const at = "2026-09-06T00:00:00.000Z";
const pending = {
  __tenkacloudCoordinationEnvelope: 1,
  stateSchemaVersion: 1,
  state: 30,
  pendingScores: { occurredAt: at, teams: { red: { before: 0, score: 30, reason: "cipher" } } },
};

afterEach(() => vi.restoreAllMocks());

describe.each(["DynamoDB", "SQL"])("atomic coordination closure: %s", (backend) => {
  function repository() {
    return backend === "SQL"
      ? new SqlDeploymentsRepository(makeSqliteExecutor())
      : new DynamoDbDeploymentsRepository(makeFakeDdb(), "Deployments");
  }

  it("closes an unmaterialized default run before last-deployment cleanup returns absent", async () => {
    const repo = repository();
    const scope = { ...key, runId: "default" };
    const artifacts = fakeArtifactStore();
    const sweep = vi.spyOn(artifacts, "deleteScope").mockImplementation(async () => {
      expect(await repo.writeCoordinationState(scope, structuredClone(pending), 0, at, 0)).toEqual({
        outcome: "conflict",
      });
      return 0;
    });
    expect(
      await cleanupCoordinationStateIfLastDeployment({ repository: repo, artifacts }, key),
    ).toEqual({ kind: "absent" });
    expect(sweep).toHaveBeenCalledOnce();
    expect(await repo.readCoordinationRun(key)).toMatchObject({ runId: "default", closed: true });
    expect(await repo.writeCoordinationState(scope, structuredClone(pending), 0, at, 0)).toEqual({
      outcome: "conflict",
    });
  });

  it("retains a first state write that wins after cleanup observed no state", async () => {
    const repo = repository();
    const scope = { ...key, runId: "default" };
    const close = repo.closeCoordinationRun.bind(repo);
    vi.spyOn(repo, "closeCoordinationRun").mockImplementationOnce(async (...args) => {
      expect(await repo.writeCoordinationState(scope, 1, 0, at, 0)).toEqual({ outcome: "updated" });
      return close(...args);
    });
    expect(await cleanupCoordinationStateIfLastDeployment({ repository: repo }, key)).toEqual({
      kind: "raced",
    });
    expect((await repo.readCoordinationState(scope))?.state).toBe(1);
    expect((await repo.readCoordinationRun(key))?.closed).toBeUndefined();
  });

  it.each([
    "default",
    "reset-run",
  ])("fences queued first writes during artifact deletion and after teardown (%s)", async (runId) => {
    const repo = repository();
    const scope = { ...key, runId };
    if (runId !== "default") {
      expect(await startCoordinationRun({ repository: repo }, key, at, runId)).toMatchObject({
        kind: "started",
      });
    }
    expect(await repo.writeCoordinationState(scope, 0, 0, at, 0)).toEqual({ outcome: "updated" });
    const artifacts = fakeArtifactStore();
    let attempts = 0;
    vi.spyOn(artifacts, "deleteScope").mockImplementation(async () => {
      attempts++;
      expect(await repo.readCoordinationState(scope)).toBeUndefined();
      expect(await repo.readCoordinationRun(key)).toMatchObject({ runId, closed: true });
      // The exact review interleaving: state gone, slow artifact I/O, stale tick
      // tries version 0 so that it would recreate version 1 with a score debt.
      expect(await repo.writeCoordinationState(scope, structuredClone(pending), 0, at, 0)).toEqual({
        outcome: "conflict",
      });
      expect(
        await repo.writeCoordinationState(
          { ...scope, runId: "default" },
          structuredClone(pending),
          0,
          at,
          0,
        ),
      ).toEqual({ outcome: "conflict" });
      return 0;
    });
    await deleteAllCoordinationRuns({ repository: repo, artifacts }, key);
    expect(attempts).toBeGreaterThan(0);
    await repo.deleteCoordinationRun(key);
    await repo.sweepExpiredCoordinationState(Number.MAX_SAFE_INTEGER);
    expect(await repo.readCoordinationRun(key)).toMatchObject({ runId, closed: true });
    expect(await repo.writeCoordinationState(scope, structuredClone(pending), 0, at, 0)).toEqual({
      outcome: "conflict",
    });
    expect(await repo.readCoordinationState(scope)).toBeUndefined();
  });

  it("keeps a delivery that wins immediately before closure, then closes after acknowledgement", async () => {
    const repo = repository();
    const scope = { ...key, runId: "default" };
    await repo.writeCoordinationState(scope, 0, 0, at, 0);
    const close = repo.closeCoordinationRun.bind(repo);
    vi.spyOn(repo, "closeCoordinationRun").mockImplementationOnce(async (...args) => {
      expect(await repo.writeCoordinationState(scope, structuredClone(pending), 1, at, 0)).toEqual({
        outcome: "updated",
      });
      return close(...args);
    });
    const artifacts = fakeArtifactStore();
    const sweep = vi.spyOn(artifacts, "deleteScope");
    await expect(deleteAllCoordinationRuns({ repository: repo, artifacts }, key)).rejects.toThrow(
      "closure conflicted",
    );
    expect((await repo.readCoordinationState(scope))?.state).toEqual(pending);
    expect((await repo.readCoordinationRun(key))?.closed).toBeUndefined();
    expect(sweep).not.toHaveBeenCalled();
    await repo.acknowledgeCoordinationScores(scope, 2);
    await deleteAllCoordinationRuns({ repository: repo, artifacts }, key);
    expect(await repo.readCoordinationState(scope)).toBeUndefined();
    expect(await repo.readCoordinationRun(key)).toMatchObject({ closed: true });
  });

  it("checks the cleanup version atomically and does not close a replacement run", async () => {
    const repo = repository();
    const scope = { ...key, runId: "default" };
    const oldPointer = initialCoordinationRunPointer(at);
    await repo.writeCoordinationState(scope, 0, 0, at, 0);
    await repo.writeCoordinationState(scope, 1, 1, at, 0);
    expect(await repo.closeCoordinationRun(key, oldPointer, 1)).toEqual({ outcome: "conflict" });
    expect((await repo.readCoordinationState(scope))?.state).toBe(1);
    expect(await startCoordinationRun({ repository: repo }, key, at, "new-run")).toMatchObject({
      kind: "started",
    });
    await repo.writeCoordinationState({ ...key, runId: "new-run" }, 2, 0, at, 0);
    expect(await repo.closeCoordinationRun(key, oldPointer)).toEqual({ outcome: "conflict" });
    expect(await repo.readCoordinationRun(key)).toMatchObject({ runId: "new-run" });
    expect((await repo.readCoordinationRun(key))?.closed).toBeUndefined();
  });

  it("retains a closed pointer after artifact failure, retries it, and reopens only a fresh explicit run", async () => {
    const repo = repository();
    const scope = { ...key, runId: "default" };
    await repo.writeCoordinationState(scope, 0, 0, at, 0);
    const artifacts = fakeArtifactStore();
    vi.spyOn(artifacts, "deleteScope").mockRejectedValueOnce(new Error("artifact unavailable"));
    await expect(deleteAllCoordinationRuns({ repository: repo, artifacts }, key)).rejects.toThrow(
      "artifact unavailable",
    );
    expect(await repo.readCoordinationRun(key)).toMatchObject({ closed: true });
    await deleteAllCoordinationRuns({ repository: repo, artifacts }, key);
    expect(await startCoordinationRun({ repository: repo }, key, at, "fresh-run")).toMatchObject({
      kind: "started",
    });
    expect((await repo.readCoordinationRun(key))?.closed).toBeUndefined();
    expect(
      await repo.writeCoordinationState({ ...key, runId: "fresh-run" }, 0, 0, at, 0, true),
    ).toEqual({ outcome: "updated" });
    expect(await repo.writeCoordinationState(scope, structuredClone(pending), 0, at, 0)).toEqual({
      outcome: "conflict",
    });
  });
});
