import { describe, expect, it } from "vitest";
import { DynamoDbEventsRepository } from "../../../lib/problem-deploy/control-data/dynamodb-events-repository";
import { SqlEventsRepository } from "../../../lib/problem-deploy/control-data/sql-events-repository";
import { makeFakeDdb, makeSqliteExecutor } from "../control-data/control-data-write.test-helpers";
import { eventId, legacyEvent, tenantId } from "./legacy-fixture";

describe.each(["sqlite", "dynamodb"])("historical registration compatibility: %s", (backend) => {
  it.each([true, false])("preserves stored claims with credential binding %s", async (bound) => {
    const repository =
      backend === "sqlite"
        ? new SqlEventsRepository(makeSqliteExecutor())
        : new DynamoDbEventsRepository(makeFakeDdb(), "Events");
    const event = legacyEvent();
    if (!event.registration) throw new Error("Missing legacy registration fixture");
    if (!bound) {
      event.registration = {
        ...event.registration,
        claims: event.registration.claims.map(({ receiptHash, teamId, claimedAt }) => ({
          receiptHash,
          teamId,
          claimedAt,
        })),
      };
    }
    await repository.putEvent(event);
    const stored = await repository.getEvent(tenantId, eventId);
    expect(stored).toEqual(event);
    expect(await repository.getEvent("another-tenant", eventId)).toBeUndefined();
    if (!stored) throw new Error("Missing stored event");
    await repository.putEvent({ ...stored, name: "Renamed by organizer" });
    expect((await repository.getEvent(tenantId, eventId))?.registration).toEqual(
      event.registration,
    );
  });
});
