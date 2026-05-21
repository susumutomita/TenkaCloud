import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEvent,
  DuplicateInternalSlugError,
  DuplicateProblemIdError,
} from "../../lib/problem-deploy/handlers/event-handler/create";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import type { CreateEventRequest } from "../../lib/problem-deploy/handlers/event-handler/types";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
  };
  return { shared, ddbSend };
}

const sampleRequest = (over: Partial<CreateEventRequest> = {}): CreateEventRequest => ({
  name: "Tenka Battle Cup 2026",
  // #528: 各 team は自社 AWS account を持つ。test data は別 account を割り当て、
  // 「team A が team B の account に deploy しない」を pin できるようにする。
  teams: [
    { internalSlug: "team-alpha", awsAccountId: "111111111111" },
    { internalSlug: "team-beta", awsAccountId: "222222222222" },
  ],
  problems: [
    {
      problemId: "hello-world-battle",
      defaultRegion: "ap-northeast-1",
    },
  ],
  ...over,
});

describe("createEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should write 1 Event row + N Teams rows in a single TransactWrite", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    const out = await createEvent(
      shared,
      { tenantId: "tenant-acme", nowMs: NOW_MS },
      sampleRequest(),
    );

    expect(ddbSend).toHaveBeenCalledTimes(1);
    const cmd = ddbSend.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(cmd).toBeInstanceOf(TransactWriteCommand);
    const items = cmd.input.TransactItems ?? [];
    // Events 1 + Teams 2 = 3 行
    expect(items).toHaveLength(3);

    // 1 件目は Event
    const eventPut = items[0]?.Put;
    expect(eventPut?.TableName).toBe("TestEvents");
    expect(eventPut?.Item?.SK).toBe("META");
    expect(eventPut?.Item?.tenantId).toBe("tenant-acme");
    expect(eventPut?.Item?.status).toBe("DRAFT");
    expect(eventPut?.Item?.teamCount).toBe(2);

    // 2 件目以降は Teams
    for (let i = 1; i <= 2; i++) {
      const teamPut = items[i]?.Put;
      expect(teamPut?.TableName).toBe("TestTeams");
      expect(teamPut?.Item?.tenantId).toBe("tenant-acme");
      expect(typeof teamPut?.Item?.teamLoginKey).toBe("string");
      expect((teamPut?.Item?.teamLoginKey as string).length).toBeGreaterThan(20);
    }

    // 各 team の teamLoginKey が一意
    const keys = items.slice(1).map((i) => i.Put?.Item?.teamLoginKey);
    expect(new Set(keys).size).toBe(keys.length);

    // レスポンスに teamLoginKey が含まれる (1 度だけ露出)
    expect(out.teams).toHaveLength(2);
    expect(out.teams[0]?.teamLoginKey).toBeTruthy();
    expect(out.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out.status).toBe("DRAFT");
  });

  it("should throw DuplicateInternalSlugError without calling TransactWrite on duplicate internalSlug in teams", async () => {
    const { shared, ddbSend } = buildShared();
    await expect(
      createEvent(
        shared,
        { tenantId: "tenant-acme", nowMs: NOW_MS },
        sampleRequest({
          teams: [
            { internalSlug: "dup", awsAccountId: "111111111111" },
            { internalSlug: "dup", awsAccountId: "222222222222" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(DuplicateInternalSlugError);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("should throw DuplicateProblemIdError without calling TransactWrite on duplicate problemIds in problems", async () => {
    const { shared, ddbSend } = buildShared();
    await expect(
      createEvent(
        shared,
        { tenantId: "tenant-acme", nowMs: NOW_MS },
        sampleRequest({
          problems: [
            {
              problemId: "p",
              defaultAwsAccountId: "999999999999",
              defaultRegion: "ap-northeast-1",
            },
            {
              problemId: "p",
              defaultAwsAccountId: "888888888888",
              defaultRegion: "us-east-1",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(DuplicateProblemIdError);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("Teams Put should always attach GSI1 (TENANT) and GSI2 (TEAMKEY) attributes (against sparse expiry)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const cmd = ddbSend.mock.calls[0]?.[0] as TransactWriteCommand;
    const teamItem = cmd.input.TransactItems?.[1]?.Put?.Item;
    expect(teamItem?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(teamItem?.GSI1SK).toMatch(/^EVENT#[0-9A-HJKMNP-TV-Z]{26}#TEAM#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(teamItem?.GSI2PK).toBe(`TEAMKEY#${teamItem?.teamLoginKey}`);
    expect(teamItem?.GSI2SK).toBe("META");
  });

  it("Event Put should attach GSI1 (TENANT / createdAt) to enable newest-first queries", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const eventItem = (ddbSend.mock.calls[0]?.[0] as TransactWriteCommand).input.TransactItems?.[0]
      ?.Put?.Item;
    expect(eventItem?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(eventItem?.GSI1SK).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should prevent double creation on the same PK via ConditionExpression (defense in depth)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const cmd = ddbSend.mock.calls[0]?.[0] as TransactWriteCommand;
    for (const item of cmd.input.TransactItems ?? []) {
      expect(item.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    }
  });
});
