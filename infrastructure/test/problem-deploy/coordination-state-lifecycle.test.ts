import { DatabaseSync } from "node:sqlite";
import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRE_SCOPE_COORDINATION_NAMESPACE } from "../../lib/problem-deploy/control-data/domain/coordination-scope";
import { DynamoDbDeploymentsCoordination } from "../../lib/problem-deploy/control-data/dynamodb-deployments-coordination";
import type { DynamoDbDeploymentsCore } from "../../lib/problem-deploy/control-data/dynamodb-deployments-core";
import { DEPLOYMENTS_SCHEMA_SQL } from "../../lib/problem-deploy/control-data/sql-deployments-core";
import { bulkTeardownEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-delete";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Issue #3123] Lifecycle and compatibility of the coordination namespace.
 *
 * The per-scope read/write/delete semantics are pinned next to their adapters
 * (`control-data/deployments-repository*.test.ts`) and next to the dispatcher
 * (`coordination-dispatch.test.ts`). This file covers the two seams that span
 * modules: the SQL schema migration off the pre-scope key, and event teardown
 * actually calling the cleanup primitive.
 */

describe("coordination_state SQL migration (#3123)", () => {
  /**
   * A database that predates this change: the two-column table, holding one
   * live row.
   */
  function seedPreScopeDatabase(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE coordination_state (
      tenant_id  TEXT    NOT NULL,
      event_id   TEXT    NOT NULL,
      state      TEXT    NOT NULL,
      version    INTEGER NOT NULL,
      updated_at TEXT    NOT NULL,
      PRIMARY KEY (tenant_id, event_id)
    )`);
    db.prepare(
      "INSERT INTO coordination_state (tenant_id, event_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("tenant-a", "ev-1", JSON.stringify({ turn: 7 }), 4, "2026-06-01T00:00:00.000Z");
    return db;
  }

  const rows = (db: DatabaseSync) =>
    db.prepare("SELECT * FROM coordination_state_scoped").all() as Record<string, unknown>[];

  it("should preserve a pre-scope row under a namespace no live scope can resolve", () => {
    const db = seedPreScopeDatabase();
    db.exec(DEPLOYMENTS_SCHEMA_SQL);

    expect(rows(db)).toEqual([
      {
        tenant_id: "tenant-a",
        event_id: "ev-1",
        // `PROBLEM_ID_RE` allows only [a-z0-9-], so no resolvable scope can
        // ever spell this. The bytes stay for forensics; nothing reads them
        // back as live state, which is what stops one problem inheriting
        // another problem's match.
        problem_id: PRE_SCOPE_COORDINATION_NAMESPACE,
        run_id: PRE_SCOPE_COORDINATION_NAMESPACE,
        state: JSON.stringify({ turn: 7 }),
        version: 4,
        updated_at: "2026-06-01T00:00:00.000Z",
        expires_at: 0,
      },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'coordination_state'").get(),
    ).toBeUndefined();
  });

  it("should be idempotent across repeated cold starts", () => {
    const db = seedPreScopeDatabase();
    db.exec(DEPLOYMENTS_SCHEMA_SQL);
    db.exec(DEPLOYMENTS_SCHEMA_SQL);
    db.exec(DEPLOYMENTS_SCHEMA_SQL);

    expect(rows(db)).toHaveLength(1);
  });

  it("should bootstrap a database that never had the legacy table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(DEPLOYMENTS_SCHEMA_SQL);

    expect(rows(db)).toEqual([]);
  });

  /**
   * The migration must not resurrect a namespace a later run already deleted:
   * the copy is `INSERT OR IGNORE` from an empty legacy table, so a second
   * bootstrap adds nothing back.
   */
  it("should not resurrect a namespace deleted after the first migration", () => {
    const db = seedPreScopeDatabase();
    db.exec(DEPLOYMENTS_SCHEMA_SQL);
    db.exec("DELETE FROM coordination_state_scoped");
    db.exec(DEPLOYMENTS_SCHEMA_SQL);

    expect(rows(db)).toEqual([]);
  });
});

describe("DynamoDbDeploymentsCoordination.sweepExpiredCoordinationState (#3123)", () => {
  /**
   * The deployments table holds several PK prefixes. The sweep must reap only
   * coordination rows — reaping a `DEPLOYMENT#` row here would delete audit
   * history another repository owns and sets its own retention for.
   */
  it("should scan only COORD# rows and delete what it finds", async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ScanCommand) {
        return { Items: [{ PK: "COORD#tn1#ev-1#problem-a#default", SK: "STATE" }] };
      }
      return {};
    });
    const coordination = new DynamoDbDeploymentsCoordination({
      ddb: { send },
      tableName: "Deployments",
    } as unknown as DynamoDbDeploymentsCore);

    expect(await coordination.sweepExpiredCoordinationState(1_800)).toBe(1);

    const scan = send.mock.calls
      .map((c) => c[0])
      .find((c) => c instanceof ScanCommand) as ScanCommand;
    expect(scan.input.FilterExpression).toBe(
      "begins_with(PK, :coordPrefix) AND expiresAt > :zero AND expiresAt <= :now",
    );
    expect(scan.input.ExpressionAttributeValues).toEqual({
      ":coordPrefix": "COORD#",
      ":zero": 0,
      ":now": 1_800,
    });
    const deleted = send.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => c.input.Key?.PK);
    expect(deleted).toEqual(["COORD#tn1#ev-1#problem-a#default"]);
  });
});

describe("event teardown cleans up coordination state (#3123)", () => {
  const NOW_MS = 1_700_000_000_000;

  function buildShared(): {
    shared: EventSharedResources;
    ddbSend: ReturnType<typeof vi.fn>;
  } {
    const ddbSend = vi.fn();
    const shared: EventSharedResources = {
      runtime: makeTestControlDataRuntime(),
      eventsTableName: "TestEvents",
      teamsTableName: "TestTeams",
      deploymentsTableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      eventBusName: "test-bus",
      env: "development",
      ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
      events: { send: vi.fn().mockResolvedValue({}) } as unknown as EventSharedResources["events"],
      problemsCatalog: {},
    };
    return { shared, ddbSend };
  }

  const dep = (over: Record<string, unknown> = {}) => ({
    jobId: "01HJOBONE",
    eventId: "EV1",
    tenantId: "tenant-acme",
    problemId: "problem-a",
    awsAccountId: "999999999999",
    region: "ap-northeast-1",
    namePrefix: "tc-p-team-1",
    status: "COMPLETE",
    ...over,
  });

  beforeEach(() => vi.clearAllMocks());

  /**
   * Deployment teardown alone cannot delete coordination state: it is shared by
   * every team on the problem, so removing it when ONE team's deployment goes
   * away would wipe a match the others are still playing. Event teardown is the
   * first boundary at which no team is left, so it owns the cleanup.
   */
  it("should delete one namespace per distinct problem in the event", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { eventId: "EV1", tenantId: "tenant-acme" } });
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({ jobId: "01A", problemId: "problem-a", namePrefix: "tc-a-t1" }),
        // Same problem, a second team — one namespace, not two deletes.
        dep({ jobId: "01B", problemId: "problem-a", namePrefix: "tc-a-t2" }),
        dep({ jobId: "01C", problemId: "problem-b", namePrefix: "tc-b-t1" }),
      ],
    });
    ddbSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");

    const deleted = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is DeleteCommand => c instanceof DeleteCommand)
      .map((c) => c.input.Key?.PK);
    expect(new Set(deleted)).toEqual(
      new Set([
        "COORD#tenant-acme#EV1#problem-a#default",
        "COORD#tenant-acme#EV1#problem-b#default",
        // The pre-scope row for this event goes too — it predates `expiresAt`,
        // so nothing else would ever reap it.
        "COORD#tenant-acme#EV1",
      ]),
    );
  });

  /**
   * Cleanup is a best-effort tail step: teardown has already reported which
   * CloudFormation stacks it enqueued, and failing the whole call here would
   * leave the operator unable to tell a leaked stack (money, real resources)
   * from a leaked state row (bytes, and covered by the row's TTL).
   */
  it("should still report the teardown result when the cleanup write fails", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { eventId: "EV1", tenantId: "tenant-acme" } });
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A" })] });
    ddbSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof DeleteCommand) throw new Error("ddb down");
      return {};
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
  });

  /**
   * A deployment row with no `problemId` names no namespace, so there is
   * nothing to delete. Issuing `COORD#tenant#event#undefined#default` instead
   * would create a partition no honest read ever reaches.
   */
  it.each([
    ["absent", undefined],
    ["empty", ""],
  ])("should not delete anything when every deployment's problemId is %s", async (_label, problemId) => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { eventId: "EV1", tenantId: "tenant-acme" } });
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A", problemId })] });
    ddbSend.mockResolvedValue({});

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(ddbSend.mock.calls.map((c) => c[0]).some((c) => c instanceof DeleteCommand)).toBe(false);
  });

  it("should not touch coordination state when the event has no deployments", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { eventId: "EV1", tenantId: "tenant-acme" } });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);

    expect(ddbSend.mock.calls.map((c) => c[0]).some((c) => c instanceof DeleteCommand)).toBe(false);
  });
});
