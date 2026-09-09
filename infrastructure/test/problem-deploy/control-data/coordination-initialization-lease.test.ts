import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../../lib/problem-deploy/control-data/deployments-repository.js";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers.js";

const scope = { tenantId: "tenant", eventId: "event", problemId: "battle", runId: "default" };
const at = "2026-09-09T00:00:00.000Z";

it("acquires and releases with the dispatcher's existing permissions, without DeleteItem", async () => {
  const ddb = makeFakeDdb();
  const send = ddb.send.bind(ddb);
  vi.spyOn(ddb, "send").mockImplementation(async (command) => {
    if (command instanceof DeleteCommand) throw new Error("AccessDenied: DeleteItem");
    return send(command);
  });
  const repository = new DynamoDbDeploymentsRepository(ddb, "Deployments");
  expect(await repository.acquireCoordinationInitialization(scope, "first", 1000, 31000)).toEqual({
    outcome: "updated",
  });
  await repository.releaseCoordinationInitialization(scope, "first");
  expect(await repository.acquireCoordinationInitialization(scope, "next", 1001, 31001)).toEqual({
    outcome: "updated",
  });
});

function clients(backend: string) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const make = () =>
    backend === "DynamoDB"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  // Separate repository instances model separate dispatcher invocations.
  return [make(), make()] as const;
}

describe.each(["DynamoDB", "SQL"])("shared initialization lease: %s", (backend) => {
  it("allows one owner across clients and permits takeover only at expiry", async () => {
    const [first, second] = clients(backend);
    const results = await Promise.all([
      first.acquireCoordinationInitialization(scope, "first", 1_000, 31_000),
      second.acquireCoordinationInitialization(scope, "second", 1_000, 31_000),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["conflict", "updated"]);
    expect(await second.acquireCoordinationInitialization(scope, "next", 30_999, 61_000)).toEqual({
      outcome: "conflict",
    });
    expect(await second.acquireCoordinationInitialization(scope, "next", 31_000, 61_000)).toEqual({
      outcome: "updated",
    });
  });

  it("fences an expired owner from writing or releasing the successor's lease", async () => {
    const [first, second] = clients(backend);
    await first.acquireCoordinationInitialization(scope, "old", 1_000, 31_000);
    await second.acquireCoordinationInitialization(scope, "new", 31_000, 61_000);
    await first.releaseCoordinationInitialization(scope, "old");
    expect(
      await first.writeCoordinationState(scope, { owner: "old" }, 0, at, 100, false, "old"),
    ).toEqual({ outcome: "conflict" });
    expect(
      await second.writeCoordinationState(scope, { owner: "new" }, 0, at, 100, false, "new"),
    ).toEqual({ outcome: "updated" });
    expect((await first.readCoordinationState(scope))?.state).toEqual({ owner: "new" });
    await second.releaseCoordinationInitialization(scope, "new");
    // Release is idempotent and cannot hold up an ordinary later request.
    await second.releaseCoordinationInitialization(scope, "new");
    expect(await first.acquireCoordinationInitialization(scope, "later", 32_000, 62_000)).toEqual({
      outcome: "updated",
    });
  });

  it.each([
    "tenantId",
    "eventId",
    "problemId",
    "runId",
  ] as const)("isolates the %s dimension", async (dimension) => {
    const [first, second] = clients(backend);
    await first.acquireCoordinationInitialization(scope, "first", 1_000, 31_000);
    expect(
      await second.acquireCoordinationInitialization(
        { ...scope, [dimension]: "different" },
        "second",
        1_000,
        31_000,
      ),
    ).toEqual({ outcome: "updated" });
  });

  it("teardown revokes an in-flight initializer before it can create state", async () => {
    const [first, second] = clients(backend);
    await first.acquireCoordinationInitialization(scope, "old", 1_000, 31_000);
    await second.deleteCoordinationState(scope);
    expect(await first.writeCoordinationState(scope, {}, 0, at, 100, false, "old")).toEqual({
      outcome: "conflict",
    });
    expect(await second.acquireCoordinationInitialization(scope, "new", 1_001, 31_001)).toEqual({
      outcome: "updated",
    });
  });

  it("sweeps an expired abandoned lease without removing another live scope", async () => {
    const [first, second] = clients(backend);
    const live = { ...scope, problemId: "live" };
    await first.acquireCoordinationInitialization(scope, "expired", 1_000, 2_000);
    await first.acquireCoordinationInitialization(live, "live", 1_000, 31_000);
    await second.sweepExpiredCoordinationState(2);
    // A backwards probe distinguishes actual cleanup from expiry-based takeover.
    expect(await second.acquireCoordinationInitialization(scope, "next", 1_000, 31_000)).toEqual({
      outcome: "updated",
    });
    expect(await second.acquireCoordinationInitialization(live, "next", 2_000, 32_000)).toEqual({
      outcome: "conflict",
    });
  });
});
