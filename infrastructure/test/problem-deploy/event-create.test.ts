import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teamKeys from "../../lib/problem-deploy/handlers/deploy-handler/team-key";
import {
  createEvent,
  DuplicateInternalSlugError,
  DuplicateProblemIdError,
  EventTeamCredentialRequiredError,
} from "../../lib/problem-deploy/handlers/event-handler/create";
import { registerEventRoutes } from "../../lib/problem-deploy/handlers/event-handler/routes/events";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import {
  type CreateEventRequest,
  CreateEventRequestSchema,
} from "../../lib/problem-deploy/handlers/event-handler/types";
import { computeCatalogSnapshotId } from "../../lib/problem-pack/event-pin";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;
const CREATED_AT = new Date(NOW_MS).toISOString();
const DEFAULT_EXPIRES_AT = Math.floor((NOW_MS + 7 * 24 * 60 * 60 * 1000) / 1000);

const PACK_PROVENANCE = {
  source: "pack",
  packId: "com.example.cloud-pack",
  packVersion: "1.0.0",
  contentDigest: "sha256-abc",
} as const;

const teamsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    internalSlug: `team-${i}`,
    awsAccountId: String(100_000_000_000 + i),
  }));

describe("CreateEventRequestSchema teams cap (event 1 row + teams must fit one 100-item TransactWrite)", () => {
  const base = { name: "E", problems: [{ problemId: "p", defaultRegion: "ap-northeast-1" }] };

  it("should accept 99 teams (event 1 + 99 = 100 items = the atomic TransactWrite max)", () => {
    expect(CreateEventRequestSchema.safeParse({ ...base, teams: teamsOf(99) }).success).toBe(true);
  });

  it("should reject 100 teams (event 1 + 100 = 101 > 100; was a schema/runtime off-by-one -> 500)", () => {
    // 旧 schema は max(100) で 100-team request を通し、 create.ts が runtime で
    // `TransactWrite items > 100` を投げて 500 になっていた。 schema を実上限 99 に揃えて 400 で弾く。
    expect(CreateEventRequestSchema.safeParse({ ...base, teams: teamsOf(100) }).success).toBe(
      false,
    );
  });

  it("defers native versus cloud team account validation to the captured catalog", () => {
    expect(
      CreateEventRequestSchema.safeParse({
        ...base,
        teams: [{ internalSlug: "team-1" }],
      }).success,
    ).toBe(true);
  });

  it("should accept a non-AWS team bound only by its credential teamSlug (#2563)", () => {
    expect(
      CreateEventRequestSchema.safeParse({
        ...base,
        teams: [{ internalSlug: "team-1", nonAwsCredentialTeamSlug: "gcp-team-1" }],
      }).success,
    ).toBe(true);
  });
});

function buildShared(overrides: Partial<EventSharedResources> = {}): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    problemsCatalog: { "hello-world-battle": "problems/battles/hello-world-battle" },
    problemsProvenance: {},
    ...overrides,
  };
  return { shared, ddbSend };
}

function firstTransactWriteCommand(ddbSend: ReturnType<typeof vi.fn>): TransactWriteCommand {
  const command = ddbSend.mock.calls[0]?.[0];
  expect(command).toBeInstanceOf(TransactWriteCommand);
  if (!(command instanceof TransactWriteCommand)) {
    throw new Error("Expected a TransactWriteCommand");
  }
  return command;
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
    const cmd = firstTransactWriteCommand(ddbSend);
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
      const teamLoginKey = teamPut?.Item?.teamLoginKey;
      expect(typeof teamLoginKey).toBe("string");
      if (typeof teamLoginKey !== "string") throw new Error("Expected a team login key");
      expect(teamLoginKey.length).toBeGreaterThan(20);
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

  it("Teams Put should attach GSI1 (TENANT) attributes and no login-key GSI keys (#2674)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const cmd = firstTransactWriteCommand(ddbSend);
    const teamItem = cmd.input.TransactItems?.[1]?.Put?.Item;
    expect(teamItem?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(teamItem?.GSI1SK).toMatch(/^EVENT#[0-9A-HJKMNP-TV-Z]{26}#TEAM#[0-9A-HJKMNP-TV-Z]{26}$/);
    // [#2674] Teams GSI2 was deleted; the plaintext bearer must no longer be
    // written as an index key, while the distributable attribute itself remains.
    expect(teamItem?.GSI2PK).toBeUndefined();
    expect(teamItem?.GSI2SK).toBeUndefined();
    expect(String(teamItem?.teamLoginKey ?? "").length).toBeGreaterThan(0);
  });

  it("Event Put should attach GSI1 (TENANT / createdAt) to enable newest-first queries", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const command = firstTransactWriteCommand(ddbSend);
    const eventItem = command.input.TransactItems?.[0]?.Put?.Item;
    expect(eventItem?.GSI1PK).toBe("TENANT#tenant-acme");
    expect(eventItem?.GSI1SK).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should omit catalogSnapshotId and packProvenance when the active catalog has no pack rows", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const command = firstTransactWriteCommand(ddbSend);
    const eventItem = command.input.TransactItems?.[0]?.Put?.Item;
    expect(eventItem).toEqual({
      PK: `EVENT#${eventItem?.eventId}`,
      SK: "META",
      GSI1PK: "TENANT#tenant-acme",
      GSI1SK: CREATED_AT,
      eventId: eventItem?.eventId,
      tenantId: "tenant-acme",
      name: "Tenka Battle Cup 2026",
      status: "DRAFT",
      problems: sampleRequest().problems,
      teamCount: 2,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      expiresAt: DEFAULT_EXPIRES_AT,
    });
  });

  it("should pin the full active catalog snapshot and write packProvenance for pack rows only", async () => {
    const { shared, ddbSend } = buildShared({
      problemsCatalog: {
        "core-problem": "problems/challenges/core-problem",
        "pack-problem": "pack-problems/com.example.cloud-pack/1.0.0/challenges/pack-problem",
      },
      problemsProvenance: {
        "pack-problem": PACK_PROVENANCE,
      },
    });
    ddbSend.mockResolvedValueOnce({});

    await createEvent(
      shared,
      { tenantId: "tenant-acme", nowMs: NOW_MS },
      sampleRequest({
        problems: [{ problemId: "core-problem", defaultRegion: "ap-northeast-1" }],
      }),
    );

    const command = firstTransactWriteCommand(ddbSend);
    const eventItem = command.input.TransactItems?.[0]?.Put?.Item;
    expect(eventItem?.packProvenance).toEqual({
      "pack-problem": {
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: "sha256-abc",
      },
    });
    expect(eventItem?.catalogSnapshotId).toBe(
      computeCatalogSnapshotId("tenant-acme", [
        { problemId: "core-problem", provenance: { source: "core" } },
        { problemId: "pack-problem", provenance: PACK_PROVENANCE },
      ]),
    );
  });

  it("should surface a TransactWrite conflict as a loud error (500 path)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      }),
    );

    await expect(
      createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest()),
    ).rejects.toThrow(/createEventWithTeams conflict/);
  });

  it("should prevent double creation on the same PK via ConditionExpression (defense in depth)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    await createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest());

    const cmd = firstTransactWriteCommand(ddbSend);
    for (const item of cmd.input.TransactItems ?? []) {
      expect(item.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    }
  });

  /**
   * [Issue #3169] The capacity warning is advisory, and advisory output must
   * never be able to fail a write that already succeeded.
   *
   * `coordinationStateBudget()` throws on a malformed
   * `COORDINATION_STATE_MAX_BYTES` — on purpose, since a typo there would
   * otherwise silently restore the "no ceiling at all" state #3151 removed.
   * Computing the warning AFTER the commit therefore meant an environment with
   * that typo persisted the event and its teams and then returned 500, taking
   * the one-time plaintext `teamLoginKey` values with it. There is no way to
   * re-read them, so the operator loses an event they cannot use and cannot
   * delete cleanly.
   */
  it("should not commit the event when the capacity warning cannot be computed", async () => {
    const { shared, ddbSend } = buildShared({
      runtime: {
        ...makeTestControlDataRuntime(),
        coordinationStateBudget: () => {
          throw new RangeError("COORDINATION_STATE_MAX_BYTES must be a positive integer");
        },
      },
    });
    ddbSend.mockResolvedValue({});

    await expect(
      createEvent(shared, { tenantId: "tenant-acme", nowMs: NOW_MS }, sampleRequest()),
    ).rejects.toThrow("COORDINATION_STATE_MAX_BYTES");

    // Nothing was written, so there are no login keys to have lost.
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("hosting-account self-test consent precedes event creation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const acknowledgment = {
    awsAccountId: "111111111111",
    riskVersion: "hosting-account-self-test-v1" as const,
  };

  it("rejects a cloud team without credentials before generating keys or writing rows", async () => {
    const generate = vi.spyOn(teamKeys, "generateTeamLoginKey");
    const { shared, ddbSend } = buildShared();

    await expect(
      createEvent(
        shared,
        { tenantId: "tenant-a", nowMs: NOW_MS },
        sampleRequest({ teams: [{ internalSlug: "without-credentials" }] }),
      ),
    ).rejects.toBeInstanceOf(EventTeamCredentialRequiredError);

    expect(generate).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("accepts a non-AWS team credential without requiring an AWS account", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const { shared, ddbSend } = buildShared({
      resolveProblemRuntimeDescriptor: () => ({
        provider: "gcp",
        engine: "infra-manager",
        entry: "main.yaml",
      }),
    });
    ddbSend.mockResolvedValue({});

    const result = await createEvent(
      shared,
      { tenantId: "tenant-a", nowMs: NOW_MS },
      sampleRequest({ teams: [{ internalSlug: "gcp-team", nonAwsCredentialTeamSlug: "gcp" }] }),
    );

    expect(result.teams[0]?.teamLoginKey).toBeTruthy();
    const writes = firstTransactWriteCommand(ddbSend).input.TransactItems;
    expect(writes?.[0]?.Put?.Item?.hostingAccountSelfTest).toBeUndefined();
    expect(writes?.[1]?.Put?.Item).toMatchObject({
      internalSlug: "gcp-team",
      nonAwsCredentialTeamSlug: "gcp",
    });
  });

  it.each([true, false])(
    "requires hosting-account consent only for composites containing AWS targets: %s",
    async (includesAws) => {
      vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
      const generate = vi.spyOn(teamKeys, "generateTeamLoginKey");
      const { shared, ddbSend } = buildShared({
        resolveProblemRuntimeDescriptor: () => ({
          kind: "composite",
          targets: [
            { id: "gcp", provider: "gcp", engine: "infra-manager", entry: "main.yaml" },
            includesAws
              ? { id: "aws", provider: "aws", engine: "cloudformation", entry: "template.yaml" }
              : { id: "azure", provider: "azure", engine: "bicep", entry: "main.bicep" },
          ],
        }),
      });
      ddbSend.mockResolvedValue({});
      const pending = createEvent(
        shared,
        { tenantId: "tenant-a", nowMs: NOW_MS, actor: "operator-a" },
        sampleRequest(),
      );

      if (includesAws) {
        await expect(pending).rejects.toMatchObject({ code: "unsupported_hosting_account" });
        expect(generate).not.toHaveBeenCalled();
        expect(ddbSend).not.toHaveBeenCalled();
      } else {
        expect((await pending).teams).toHaveLength(2);
        expect(
          firstTransactWriteCommand(ddbSend).input.TransactItems?.[0]?.Put?.Item
            ?.hostingAccountSelfTest,
        ).toBeUndefined();
      }
    },
  );

  it("accepts consent through the real event route using the authenticated actor", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const generate = vi.spyOn(teamKeys, "generateTeamLoginKey");
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValue({});
    const app = new Hono();
    registerEventRoutes(app, shared);
    const env = {
      event: {
        requestContext: {
          authorizer: {
            claims: {
              sub: "operator-from-cognito",
              "custom:tenantId": "tenant-from-cognito",
              "custom:userRole": "TenantAdmin",
            },
          },
        },
      },
    };
    const post = (body: unknown) =>
      app.request(
        "/events",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );

    const refused = await post(sampleRequest());
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "unsupported_hosting_account",
      awsAccountId: acknowledgment.awsAccountId,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();

    const accepted = await post({
      ...sampleRequest(),
      hostingAccountSelfTest: {
        ...acknowledgment,
        acknowledgedBy: "forged-client-actor",
        acknowledgedAt: "2000-01-01T00:00:00.000Z",
      },
    });
    expect(accepted.status).toBe(201);
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const event = firstTransactWriteCommand(ddbSend).input.TransactItems?.[0]?.Put?.Item;
    expect(event).toMatchObject({
      tenantId: "tenant-from-cognito",
      hostingAccountSelfTest: {
        ...acknowledgment,
        acknowledgedBy: "operator-from-cognito",
        acknowledgedAt: CREATED_AT,
      },
    });
    const body = await accepted.json();
    expect(body.teams).toHaveLength(2);
    expect(body.teams[0].teamLoginKey).toBeTruthy();
  });

  it.each([undefined, { ...acknowledgment, awsAccountId: "222222222222" }])(
    "rejects missing or wrong-account consent without keys or writes: %s",
    async (consent) => {
      vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
      const generate = vi.spyOn(teamKeys, "generateTeamLoginKey");
      const { shared, ddbSend } = buildShared();
      await expect(
        createEvent(
          shared,
          { tenantId: "tenant-a", nowMs: NOW_MS, actor: "operator-a" },
          sampleRequest({ hostingAccountSelfTest: consent }),
        ),
      ).rejects.toMatchObject({ code: "unsupported_hosting_account" });
      expect(generate).not.toHaveBeenCalled();
      expect(ddbSend).not.toHaveBeenCalled();
    },
  );

  it("records only the authenticated actor and server time with the new event", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValue({});
    const request = CreateEventRequestSchema.parse({
      ...sampleRequest(),
      hostingAccountSelfTest: {
        ...acknowledgment,
        acknowledgedBy: "spoofed",
        acknowledgedAt: "2000-01-01T00:00:00Z",
        eventId: "other-event",
      },
    });
    await createEvent(
      shared,
      { tenantId: "tenant-a", nowMs: NOW_MS, actor: "operator-a" },
      request,
    );
    const event = firstTransactWriteCommand(ddbSend).input.TransactItems?.[0]?.Put?.Item;
    expect(event?.hostingAccountSelfTest).toEqual({
      ...acknowledgment,
      acknowledgedBy: "operator-a",
      acknowledgedAt: CREATED_AT,
    });
  });

  it("rejects consent without an authenticated actor", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const { shared, ddbSend } = buildShared();
    await expect(
      createEvent(
        shared,
        { tenantId: "tenant-a", nowMs: NOW_MS },
        sampleRequest({ hostingAccountSelfTest: acknowledgment }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_hosting_account" });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("accepts a separate shared competitor account across team regions without consent", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "999999999999");
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValue({});
    const result = await createEvent(
      shared,
      { tenantId: "tenant-a", nowMs: NOW_MS },
      sampleRequest({
        teams: [
          { internalSlug: "alpha", awsAccountId: "111111111111", region: "ap-northeast-1" },
          { internalSlug: "beta", awsAccountId: "111111111111", region: "us-east-1" },
        ],
      }),
    );
    expect(result.teams).toHaveLength(2);
    expect(
      firstTransactWriteCommand(ddbSend).input.TransactItems?.[0]?.Put?.Item
        ?.hostingAccountSelfTest,
    ).toBeUndefined();
  });

  it("keeps native Battle without AWS credentials available", async () => {
    vi.stubEnv("CONTROL_PLANE_ACCOUNT", "111111111111");
    const executionCatalog: NonNullable<EventSharedResources["executionCatalog"]> = {
      version: 1,
      catalogKey: `catalogs/${"a".repeat(64)}.json`,
      catalog: { "ac26-crypto-battle": "problems/battles/ac26-crypto-battle" },
      nativeProblems: [
        {
          problemId: "ac26-crypto-battle",
          kind: "coordination",
          problemDir: "problems/battles/ac26-crypto-battle",
          artifactDigest: "a".repeat(64),
          pluginKey: `plugins/${"a".repeat(64)}.mjs`,
          stateBudget: { bytesPerTeam: 100, baseBytes: 0 },
          name: "Crypto",
          description: "Native battle",
          instructions: "Play",
        },
      ],
      scoring: {},
      hints: {},
      endpoints: {},
      phases: {},
      visibility: {},
      runtimes: {},
      disruptions: {},
      writeups: {},
      provenance: {},
      coordination: {},
      plugins: {},
      sources: {},
      sourceArchive: { bucket: "test", key: "source.zip", versionId: "1" },
    };
    const { shared, ddbSend } = buildShared({ executionCatalog });
    ddbSend.mockResolvedValue({});
    const result = await createEvent(
      shared,
      { tenantId: "tenant-a", nowMs: NOW_MS },
      sampleRequest({
        teams: [{ internalSlug: "self" }],
        problems: [{ problemId: "ac26-crypto-battle", defaultRegion: "ap-northeast-1" }],
      }),
    );
    expect(result.teams).toHaveLength(1);
  });
});
