import { describe, expect, it, vi } from "vitest";
import type { CoordinationArtifactStore } from "../../lib/problem-deploy/control-data/coordination-artifact-store";
import {
  COORDINATION_RUN_HISTORY_LIMIT,
  type CoordinationRunKey,
  coordinationScopeForRun,
  createCoordinationRunId,
  initialCoordinationRunPointer,
  rotateCoordinationRunPointer,
} from "../../lib/problem-deploy/control-data/domain/coordination-run";
import { DEFAULT_COORDINATION_RUN_ID } from "../../lib/problem-deploy/control-data/domain/coordination-scope";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository";
import {
  deleteAllCoordinationRuns,
  resolveCurrentCoordinationRunId,
  startCoordinationRun,
} from "../../lib/problem-deploy/handlers/shared/coordination-run";
import { makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";

/**
 * [Issue #3153] The fourth dimension of the coordination scope becomes real.
 *
 * `runId` was the literal `"default"`, so "reset this match" could only mean
 * "delete this namespace" — which works, and throws away the match an operator
 * reset precisely because they wanted to look at it.
 *
 * These pin the three things the issue asks to be shown: complete isolation
 * across the 2 problems x 2 runs matrix, a new run never reading the previous
 * one's state, and a retired run losing both its state and its artifacts.
 */

const TENANT = "tenant-a";
const EVENT = "ev-1";
const KEY: CoordinationRunKey = { tenantId: TENANT, eventId: EVENT, problemId: "crypto-battle" };
const OTHER: CoordinationRunKey = { ...KEY, problemId: "other-battle" };
const AT = "2026-07-01T00:00:00.000Z";

/** Records which scopes had their artifacts deleted. */
function makeArtifactSpy(): CoordinationArtifactStore & { readonly deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    put: () => Promise.reject(new Error("unused")),
    get: () => Promise.resolve(undefined),
    remove: () => Promise.resolve(),
    deleteScope: (scope) => {
      deleted.push(`${scope.problemId}/${scope.runId}`);
      return Promise.resolve(1);
    },
  };
}

function makeRepository(): SqlDeploymentsRepository {
  return new SqlDeploymentsRepository(makeSqliteExecutor());
}

async function seedState(
  repository: SqlDeploymentsRepository,
  key: CoordinationRunKey,
  runId: string,
  state: unknown,
): Promise<void> {
  await repository.writeCoordinationState(coordinationScopeForRun(key, runId), state, 0, AT, 0);
}

describe("rotateCoordinationRunPointer (#3153)", () => {
  it("should move the current run into history and keep the window bounded", () => {
    let pointer = initialCoordinationRunPointer(AT);
    const retiredOverall: string[] = [];
    for (const runId of ["r1", "r2", "r3", "r4"]) {
      const rotation = rotateCoordinationRunPointer(pointer, runId, AT);
      retiredOverall.push(...rotation.retired);
      pointer = rotation.pointer;
    }

    expect(pointer.runId).toBe("r4");
    // The window counts the current run, so a limit of 3 keeps the new run plus
    // the two before it.
    expect(pointer.history).toHaveLength(COORDINATION_RUN_HISTORY_LIMIT - 1);
    expect(pointer.history).toEqual(["r3", "r2"]);
    expect(retiredOverall).toEqual([DEFAULT_COORDINATION_RUN_ID, "r1"]);
  });

  it("should mint ids that are never reused and never the initial constant", () => {
    // A reused id would walk a new match into the previous run's tombstoned
    // artifact prefix (#3152), and would make history unreadable.
    const ids = new Set(Array.from({ length: 200 }, () => createCoordinationRunId()));
    expect(ids.size).toBe(200);
    expect(ids.has(DEFAULT_COORDINATION_RUN_ID)).toBe(false);
  });
});

describe("resolveCurrentCoordinationRunId (#3153)", () => {
  it("should resolve a problem that was never reset to the initial run", async () => {
    // Every match in flight when this ships lives under the old constant.
    // Minting on first read would move all of them to an empty namespace and
    // silently restart them from `initialState`.
    const repository = makeRepository();
    expect(await resolveCurrentCoordinationRunId(repository, KEY)).toBe(
      DEFAULT_COORDINATION_RUN_ID,
    );
  });

  it("should resolve to the run the pointer names once one exists", async () => {
    const repository = makeRepository();
    const started = await startCoordinationRun({ repository }, KEY, AT);

    expect(started.kind).toBe("started");
    expect(await resolveCurrentCoordinationRunId(repository, KEY)).toBe(
      started.kind === "started" ? started.runId : "",
    );
  });

  it("should not fall back to the initial run when the pointer cannot be read", async () => {
    const repository = makeRepository();
    const broken = {
      readCoordinationRun: () => Promise.reject(new Error("control data unavailable")),
    } as unknown as SqlDeploymentsRepository;

    // Falling back would send an operation into whichever match happens to live
    // under the initial run — the previous one, if this problem was ever reset
    // — and the write would succeed. A failed request is recoverable; a write
    // into the wrong match is not.
    await expect(resolveCurrentCoordinationRunId(broken, KEY)).rejects.toThrow(
      "control data unavailable",
    );
    expect(repository).toBeDefined();
  });
});

describe("starting a run keeps the previous one (#3153)", () => {
  it.each([
    false,
    true,
  ])("should refuse a pending delivery and allow reset after acknowledgement (rotated=%s)", async (rotated) => {
    const repository = makeRepository();
    const artifacts = makeArtifactSpy();
    if (rotated) await startCoordinationRun({ repository }, KEY, AT);
    const pointer = await repository.readCoordinationRun(KEY);
    const runId = pointer?.runId ?? DEFAULT_COORDINATION_RUN_ID;
    const scope = coordinationScopeForRun(KEY, runId);
    const state = {
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 1,
      state: { scores: { "team-a": 30, "team-b": 10 }, ledger: ["accepted"] },
      pendingScores: {
        occurredAt: AT,
        // Team A has already committed; only B remains in this delivery.
        teams: { "team-b": { before: 0, score: 10, reason: "leak" } },
      },
    };
    await seedState(repository, KEY, runId, state);

    expect(await startCoordinationRun({ repository, artifacts }, KEY, AT)).toEqual({
      kind: "conflict",
    });
    expect(await repository.readCoordinationRun(KEY)).toEqual(pointer);
    expect((await repository.readCoordinationState(scope))?.state).toEqual(state);
    expect(artifacts.deleted).toEqual([]);

    await repository.acknowledgeCoordinationScores(scope, 1);
    const retried = await startCoordinationRun({ repository, artifacts }, KEY, AT);

    expect(retried).toMatchObject({ kind: "started", previousRunId: runId });
    expect((await repository.readCoordinationState(scope))?.state).toEqual({
      __tenkacloudCoordinationEnvelope: 1,
      stateSchemaVersion: 1,
      state: state.state,
    });
  });

  it("should reject a delivery saved after the pre-rotation read", async () => {
    const repository = makeRepository();
    const artifacts = makeArtifactSpy();
    const scope = coordinationScopeForRun(KEY, DEFAULT_COORDINATION_RUN_ID);
    await seedState(repository, KEY, scope.runId, { score: 0 });
    const read = repository.readCoordinationState.bind(repository);
    vi.spyOn(repository, "readCoordinationState").mockImplementationOnce(async (readScope) => {
      const observed = await read(readScope);
      await repository.writeCoordinationState(
        scope,
        {
          __tenkacloudCoordinationEnvelope: 1,
          stateSchemaVersion: 1,
          state: { score: 30 },
          pendingScores: {
            occurredAt: AT,
            teams: { "team-a": { before: 0, score: 30, reason: "cipher" } },
          },
        },
        1,
        AT,
        0,
      );
      return observed;
    });

    expect(await startCoordinationRun({ repository, artifacts }, KEY, AT)).toEqual({
      kind: "conflict",
    });
    expect(await resolveCurrentCoordinationRunId(repository, KEY)).toBe(scope.runId);
    expect((await read(scope))?.version).toBe(2);
    expect(artifacts.deleted).toEqual([]);
  });

  it.each([
    { pendingScores: { teams: {} } },
    { __tenkacloudCoordinationEnvelope: 1, pendingScores: { teams: {} } },
    { __tenkacloudCoordinationEnvelope: 1, stateSchemaVersion: 1, state: {}, pendingScores: null },
  ])("should not confuse opaque plugin fields with a pending delivery: %j", async (state) => {
    const repository = makeRepository();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, state);
    expect((await startCoordinationRun({ repository }, KEY, AT)).kind).toBe("started");
  });

  it("should leave the pointer unchanged when the current state cannot be read", async () => {
    const repository = makeRepository();
    vi.spyOn(repository, "readCoordinationState").mockRejectedValueOnce(new Error("read failed"));
    await expect(startCoordinationRun({ repository }, KEY, AT)).rejects.toThrow("read failed");
    expect(await repository.readCoordinationRun(KEY)).toBeUndefined();
  });

  it("should leave the previous run's state readable under its own scope", async () => {
    const repository = makeRepository();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 7 });

    const started = await startCoordinationRun({ repository }, KEY, AT);
    const previous = started.kind === "started" ? started.previousRunId : "";

    // The whole point of the change: the operator who reset because something
    // went wrong can still see what went wrong.
    expect(
      (await repository.readCoordinationState(coordinationScopeForRun(KEY, previous)))?.state,
    ).toMatchObject({ turn: 7 });
  });

  it("should start the new run uninitialized rather than inheriting the old state", async () => {
    const repository = makeRepository();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 7 });

    const started = await startCoordinationRun({ repository }, KEY, AT);
    const current = started.kind === "started" ? started.runId : "";

    // An absent row IS an uninitialized match: the first operation materializes
    // it from `plugin.initialState`, exactly as the delete-based reset did.
    expect(
      await repository.readCoordinationState(coordinationScopeForRun(KEY, current)),
    ).toBeUndefined();
  });

  it("should delete state and artifacts together when a run leaves the window", async () => {
    const repository = makeRepository();
    const artifacts = makeArtifactSpy();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 1 });

    const runs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const started = await startCoordinationRun({ repository, artifacts }, KEY, AT);
      if (started.kind === "started") runs.push(started.runId);
      await seedState(repository, KEY, runs.at(-1) ?? "", { turn: index + 2 });
    }

    // The initial run has now been pushed out of a three-run window.
    expect(
      await repository.readCoordinationState(
        coordinationScopeForRun(KEY, DEFAULT_COORDINATION_RUN_ID),
      ),
    ).toBeUndefined();
    expect(artifacts.deleted).toContain(`${KEY.problemId}/${DEFAULT_COORDINATION_RUN_ID}`);
    // ...and the run before the current one is still there.
    expect(
      await repository.readCoordinationState(coordinationScopeForRun(KEY, runs[1] ?? "")),
    ).toBeDefined();
  });

  it("should delete nothing when the rotation loses its race", async () => {
    const repository = makeRepository();
    const artifacts = makeArtifactSpy();
    await startCoordinationRun({ repository }, KEY, AT);
    // A rotation built from a pointer that has since moved on.
    const stale = await repository.readCoordinationRun(KEY);
    await startCoordinationRun({ repository }, KEY, AT);

    const outcome = await repository.rotateCoordinationRun(
      KEY,
      stale?.runId ?? "",
      { runId: "rLOSER", startedAt: AT, history: [] },
      0,
    );

    expect(outcome).toEqual({ outcome: "conflict" });
    // Deleting before the write would let a rotation that lost still destroy
    // history the winner is keeping.
    expect(artifacts.deleted).toEqual([]);
  });
});

describe("2 problems x 2 runs stay completely isolated (#3153)", () => {
  it("should keep every combination's state to itself", async () => {
    const repository = makeRepository();
    // Two problems, each on its second run, with state written to all four.
    const firstRuns = { a: DEFAULT_COORDINATION_RUN_ID, b: DEFAULT_COORDINATION_RUN_ID };
    await seedState(repository, KEY, firstRuns.a, { who: "a", run: 1 });
    await seedState(repository, OTHER, firstRuns.b, { who: "b", run: 1 });
    const startedA = await startCoordinationRun({ repository }, KEY, AT);
    const startedB = await startCoordinationRun({ repository }, OTHER, AT);
    const secondRuns = {
      a: startedA.kind === "started" ? startedA.runId : "",
      b: startedB.kind === "started" ? startedB.runId : "",
    };
    await seedState(repository, KEY, secondRuns.a, { who: "a", run: 2 });
    await seedState(repository, OTHER, secondRuns.b, { who: "b", run: 2 });

    const read = async (key: CoordinationRunKey, runId: string) =>
      (await repository.readCoordinationState(coordinationScopeForRun(key, runId)))?.state;

    // Neither dimension leaks into the other: same problem different run, same
    // run different problem, and the diagonal.
    expect(await read(KEY, firstRuns.a)).toMatchObject({ who: "a", run: 1 });
    expect(await read(KEY, secondRuns.a)).toMatchObject({ who: "a", run: 2 });
    expect(await read(OTHER, firstRuns.b)).toMatchObject({ who: "b", run: 1 });
    expect(await read(OTHER, secondRuns.b)).toMatchObject({ who: "b", run: 2 });
  });

  it("should not let one problem's reset move the other problem's run", async () => {
    const repository = makeRepository();
    await startCoordinationRun({ repository }, KEY, AT);

    expect(await resolveCurrentCoordinationRunId(repository, OTHER)).toBe(
      DEFAULT_COORDINATION_RUN_ID,
    );
  });

  it("should keep two events on the same problem apart", async () => {
    const repository = makeRepository();
    const otherEvent: CoordinationRunKey = { ...KEY, eventId: "ev-2" };
    const started = await startCoordinationRun({ repository }, KEY, AT);

    expect(await resolveCurrentCoordinationRunId(repository, otherEvent)).toBe(
      DEFAULT_COORDINATION_RUN_ID,
    );
    expect(started.kind === "started" && started.runId).not.toBe(DEFAULT_COORDINATION_RUN_ID);
  });
});

describe("removing a problem removes every run it had (#3153)", () => {
  it("should delete the current run, the history, and the pointer", async () => {
    const repository = makeRepository();
    const artifacts = makeArtifactSpy();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 1 });
    const first = await startCoordinationRun({ repository, artifacts }, KEY, AT);
    const firstRun = first.kind === "started" ? first.runId : "";
    await seedState(repository, KEY, firstRun, { turn: 2 });
    const second = await startCoordinationRun({ repository, artifacts }, KEY, AT);
    const currentRun = second.kind === "started" ? second.runId : "";
    await seedState(repository, KEY, currentRun, { turn: 3 });

    const removed = await deleteAllCoordinationRuns({ repository, artifacts }, KEY);

    expect(removed).toEqual(expect.arrayContaining([currentRun, firstRun]));
    for (const runId of removed) {
      expect(
        await repository.readCoordinationState(coordinationScopeForRun(KEY, runId)),
      ).toBeUndefined();
      expect(artifacts.deleted).toContain(`${KEY.problemId}/${runId}`);
    }
    // The pointer goes last, so a failure part way through leaves a pointer
    // naming runs that still exist rather than runs nothing names.
    expect(await repository.readCoordinationRun(KEY)).toBeUndefined();
  });

  it("should still clear the initial run for a problem that was never reset", async () => {
    const repository = makeRepository();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 1 });

    // No pointer exists, but there is certainly a match: the first run of every
    // problem is the constant.
    expect(await deleteAllCoordinationRuns({ repository }, KEY)).toEqual([
      DEFAULT_COORDINATION_RUN_ID,
    ]);
    expect(
      await repository.readCoordinationState(
        coordinationScopeForRun(KEY, DEFAULT_COORDINATION_RUN_ID),
      ),
    ).toBeUndefined();
  });

  it("should not touch another problem's runs", async () => {
    const repository = makeRepository();
    await seedState(repository, OTHER, DEFAULT_COORDINATION_RUN_ID, { who: "b" });

    await deleteAllCoordinationRuns({ repository }, KEY);

    expect(
      await repository.readCoordinationState(
        coordinationScopeForRun(OTHER, DEFAULT_COORDINATION_RUN_ID),
      ),
    ).toBeDefined();
  });
});

describe("the run pointer outlives the runs it names (#3153)", () => {
  it("should store the pointer without an expiry", async () => {
    const repository = makeRepository();
    let storedExpiry: number | undefined;
    const spy = {
      readCoordinationRun: () => Promise.resolve(undefined),
      readCoordinationState: () => Promise.resolve(undefined),
      rotateCoordinationRun: (
        _key: CoordinationRunKey,
        _expected: string,
        _pointer: unknown,
        expiresAt: number,
      ) => {
        storedExpiry = expiresAt;
        return Promise.resolve({ outcome: "updated" as const });
      },
      deleteCoordinationState: () => Promise.resolve(),
    } as unknown as SqlDeploymentsRepository;

    await startCoordinationRun({ repository: spy }, KEY, AT);

    // A pointer that expired before its runs would resolve every participant
    // back to the initial run — a DIFFERENT match, whose state they would then
    // read and write. The other direction is harmless: a pointer naming a run
    // whose state has expired just materializes that run from `initialState`.
    expect(storedExpiry).toBe(0);
    expect(repository).toBeDefined();
  });

  it("should be skipped by the expiry sweep", async () => {
    const repository = makeRepository();
    await startCoordinationRun({ repository }, KEY, AT);

    // The sweep only reaps rows with a positive `expiresAt`, which is the same
    // "never expires" convention the pre-TTL coordination rows already use.
    await repository.sweepExpiredCoordinationState(Number.MAX_SAFE_INTEGER);

    expect(await repository.readCoordinationRun(KEY)).toBeDefined();
  });
});

describe("failures while retiring or removing runs (#3153)", () => {
  it("should report a run that could not be retired without failing the rotation", async () => {
    const repository = makeRepository();
    const artifacts = {
      ...makeArtifactSpy(),
      deleteScope: () => Promise.reject(new Error("s3 unavailable")),
    };
    // Fill the window so the next rotation pushes one run out.
    for (let index = 0; index < 3; index += 1) {
      await startCoordinationRun({ repository }, KEY, AT);
    }

    const outcome = await startCoordinationRun({ repository, artifacts }, KEY, AT);

    // The pointer is already written, so the run being removed is unreachable
    // through any normal path. Failing the caller would report that a reset did
    // not happen when it did; the bucket's expiry is still the backstop.
    expect(outcome.kind).toBe("started");
    expect(outcome.kind === "started" && outcome.retired).toHaveLength(1);
  });

  it("should propagate a failure that leaves runs still reachable", async () => {
    const repository = makeRepository();
    await seedState(repository, KEY, DEFAULT_COORDINATION_RUN_ID, { turn: 1 });
    const broken = {
      readCoordinationRun: () => Promise.resolve(undefined),
      deleteCoordinationState: () => Promise.reject(new Error("control data unavailable")),
    } as unknown as SqlDeploymentsRepository;

    // Unlike retirement, this one still has a pointer path to the data. A
    // silent success here would report a problem removed while its state stayed
    // readable.
    await expect(deleteAllCoordinationRuns({ repository: broken }, KEY)).rejects.toThrow(
      "control data unavailable",
    );
  });
});
