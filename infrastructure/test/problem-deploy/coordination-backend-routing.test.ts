import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository.js";
import { DEFAULT_COORDINATION_RUN_ID } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import type { DeploymentsRepository } from "../../lib/problem-deploy/control-data/types.js";
import { dispatchCoordinationOp } from "../../lib/problem-deploy/handlers/participant-handler/coordination-dispatch.js";
import { deliverCoordinationScores } from "../../lib/problem-deploy/handlers/participant-handler/coordination-scoring.js";
import {
  type CoordinationStoreDeps,
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers.js";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers.js";

const at = "2026-09-06T00:00:00.000Z";
const scope = {
  tenantId: "tenant",
  eventId: "event",
  problemId: "battle",
  runId: DEFAULT_COORDINATION_RUN_ID,
};
const plugin: CoordinationPlugin<number, { kind: "solve" }, number> = {
  initialState: () => 0,
  validateOp: (state) => (state === 0 ? { ok: true } : { ok: false, error: "already_solved" }),
  applyOp: () => 30,
  teamScores: (score) => ({ red: score }),
  projectForTeam: (score) => score,
};

/** These are two runtime surfaces over the same backing data, as in the dispatcher. */
function restrictRepository(repository: DeploymentsRepository, forbidden: readonly string[]) {
  return new Proxy(repository, {
    get(target, key) {
      if (forbidden.includes(String(key))) throw new Error(`Wrong backend used for ${String(key)}`);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.each(["DynamoDB", "SQL"])("coordination backend routing: %s", (backend) => {
  it.each([
    false,
    true,
  ])("saves a move normally and confines delivery failure/replay to the bounded backend (timeout=%s)", async (timeout) => {
    const ddb = makeFakeDdb();
    const sql = makeSqliteExecutor();
    const repository: DeploymentsRepository =
      backend === "DynamoDB"
        ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
        : new SqlDeploymentsRepository(sql);
    await repository.putDeployment({
      ...scope,
      jobId: "red",
      teamId: "red",
      teamName: "Red",
      teamLoginKey: "fixture-key",
      namePrefix: "red",
      awsAccountId: "123456789012",
      region: "ap-northeast-1",
      status: "COMPLETE",
      createdAt: at,
      updatedAt: at,
      score: 0,
    });
    const publish = vi.spyOn(repository, "publishCoordinationScore");
    if (timeout)
      publish.mockRejectedValueOnce(
        Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
      );
    const normalRepository = restrictRepository(repository, [
      "listByTenantAndEvent",
      "getDeployment",
      "publishCoordinationScore",
      "acknowledgeCoordinationScores",
    ]);
    const deliveryRepository = restrictRepository(repository, [
      "readCoordinationState",
      "writeCoordinationState",
      "readCoordinationMatchSecret",
      "ensureCoordinationMatchSecret",
    ]);
    const runtime = makeTestControlDataRuntime({
      CONTROL_DATA_BACKEND: backend === "SQL" ? "turso" : "dynamodb",
    });
    const normalResolver = vi.fn(async () => normalRepository);
    const deliveryResolver = vi.fn(async () => deliveryRepository);
    const deliveryDdb = { send: vi.fn() };
    const store: CoordinationStoreDeps = {
      runtime: { ...runtime, resolveDeploymentsRepository: normalResolver },
      ddb,
      tableName: "Deployments",
      coordinationScoreModes: { battle: "exclusive" },
      scoreDelivery: {
        runtime: { ...runtime, resolveDeploymentsRepository: deliveryResolver },
        ddb: deliveryDdb,
        tableName: "Deployments",
      },
    };
    await writeCoordinationState(store, scope, 0, 0, at);
    const input = {
      scope,
      teamId: "red",
      ctx: { eventId: scope.eventId, teamIds: ["red"] },
      op: { kind: "solve" as const },
      fallbackProjection: 0,
      nowIso: at,
    };
    expect(await dispatchCoordinationOp(store, plugin, input)).toEqual({
      kind: "ok",
      projection: 30,
    });
    const saved = await readCoordinationState(store, scope);
    expect(saved).toMatchObject({ state: 30, version: 2 });
    expect(Boolean(saved?.pendingScores)).toBe(timeout);
    expect(publish).toHaveBeenCalledTimes(1);
    if (timeout) {
      expect((await repository.getDeployment("red"))?.score).toBe(0);
      expect(await deliverCoordinationScores(store, scope, saved)).toBe(true);
      expect((await readCoordinationState(store, scope))?.pendingScores).toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(2);
    }
    expect((await repository.getDeployment("red"))?.score).toBe(30);
    expect(await dispatchCoordinationOp(store, plugin, input)).toEqual({
      kind: "rejected",
      error: "already_solved",
    });
    expect(normalResolver).toHaveBeenCalledWith({ ddb, deploymentsTableName: "Deployments" });
    expect(deliveryResolver).toHaveBeenCalledWith({
      ddb: deliveryDdb,
      deploymentsTableName: "Deployments",
    });
  });
});
