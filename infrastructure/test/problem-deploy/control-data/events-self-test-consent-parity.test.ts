import { describe, expect, it } from "vitest";
import { DynamoDbEventsRepository } from "../../../lib/problem-deploy/control-data/dynamodb-events-repository";
import { SqlEventsRepository } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import {
  AT,
  acknowledgment,
  EVENT_ID,
  eventRecord,
  TENANT_ID,
} from "../existing-event-consent.test-helpers";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data-write.test-helpers";

const backends = [
  ["dynamodb", () => new DynamoDbEventsRepository(makeFakeDdb(), "Events")],
  ["turso", () => new SqlEventsRepository(makeSqliteExecutor())],
] as const;

describe.each(backends)("atomic existing-event consent: %s", (_name, makeRepository) => {
  it("preserves concurrently updated schedule, scoring state, catalog pin and all other event fields", async () => {
    const repo = makeRepository();
    const event = eventRecord({
      catalogKey: "catalogs/saved.json",
      catalogSnapshotId: "saved-snapshot",
      status: "READY",
    });
    await repo.putEvent(event);
    const stale = await repo.getEvent(TENANT_ID, EVENT_ID);
    await repo.updateSchedule(
      TENANT_ID,
      EVENT_ID,
      { startsAt: "2026-10-04T12:00:00.000Z", teardownAt: "2026-10-04T16:00:00.000Z" },
      "2026-10-03T12:01:00.000Z",
    );
    await repo.lockScoring(TENANT_ID, EVENT_ID, "other-operator", "2026-10-03T12:02:00.000Z");
    const latest = await repo.getEvent(TENANT_ID, EVENT_ID);
    const result = await repo.acknowledgeHostingAccountSelfTest(
      TENANT_ID,
      EVENT_ID,
      acknowledgment,
      stale ?? {},
    );
    expect(result.outcome).toBe("updated");
    expect(await repo.getEvent(TENANT_ID, EVENT_ID)).toEqual({
      ...latest,
      hostingAccountSelfTest: acknowledgment,
    });
    expect(result.outcome === "updated" && result.event).toEqual({
      ...latest,
      hostingAccountSelfTest: acknowledgment,
    });
  });

  it("keeps the first consent when two callers race from the same snapshot", async () => {
    const repo = makeRepository();
    const event = eventRecord();
    await repo.putEvent(event);
    const [first, duplicate] = await Promise.all([
      repo.acknowledgeHostingAccountSelfTest(TENANT_ID, EVENT_ID, acknowledgment, event),
      repo.acknowledgeHostingAccountSelfTest(
        TENANT_ID,
        EVENT_ID,
        { ...acknowledgment, acknowledgedBy: "other-operator" },
        event,
      ),
    ]);
    expect(first.outcome).toBe("updated");
    expect(duplicate.outcome).toBe("conflict");
    expect(await repo.getEvent(TENANT_ID, EVENT_ID)).toEqual({
      ...event,
      hostingAccountSelfTest: acknowledgment,
    });
  });

  it("does not write another tenant, missing event, or changed catalog", async () => {
    const repo = makeRepository();
    const event = eventRecord({ catalogKey: "catalogs/saved.json" });
    await repo.putEvent(event);
    expect(
      (await repo.acknowledgeHostingAccountSelfTest("foreign", EVENT_ID, acknowledgment, event))
        .outcome,
    ).toBe("not_found");
    expect(
      (await repo.acknowledgeHostingAccountSelfTest(TENANT_ID, "missing", acknowledgment, event))
        .outcome,
    ).toBe("not_found");
    expect(
      (await repo.acknowledgeHostingAccountSelfTest(TENANT_ID, EVENT_ID, acknowledgment, {}))
        .outcome,
    ).toBe("conflict");
    expect(await repo.getEvent(TENANT_ID, EVENT_ID)).toEqual(event);
  });

  it("can replace stale account consent without losing other state", async () => {
    const repo = makeRepository();
    const event = eventRecord({
      hostingAccountSelfTest: {
        ...acknowledgment,
        awsAccountId: "222222222222",
        acknowledgedAt: AT,
      },
    });
    await repo.putEvent(event);
    expect(
      (await repo.acknowledgeHostingAccountSelfTest(TENANT_ID, EVENT_ID, acknowledgment, event))
        .outcome,
    ).toBe("updated");
    expect(await repo.getEvent(TENANT_ID, EVENT_ID)).toEqual({
      ...event,
      hostingAccountSelfTest: acknowledgment,
    });
  });
});
