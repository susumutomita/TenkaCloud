import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../../lib/problem-deploy/control-data/domain/events";
import { DynamoDbDeploymentsRepository } from "../../lib/problem-deploy/control-data/dynamodb-deployments-repository";
import { DynamoDbEventsRepository } from "../../lib/problem-deploy/control-data/dynamodb-events-repository";
import { SqlDeploymentsRepository } from "../../lib/problem-deploy/control-data/sql-deployments-repository";
import { SqlEventsRepository } from "../../lib/problem-deploy/control-data/sql-events-repository";
import { setEventSchedule } from "../../lib/problem-deploy/handlers/event-handler/schedule";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import * as catalogContext from "../../lib/problem-deploy/handlers/shared/execution-catalog-context";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Challenge #933 review] The started-Battle schedule rule against real event repositories, where
 * a write's condition is actually evaluated.
 */

const TENANT_ID = "tenant-a";
const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const NOW_MS = Date.parse("2026-10-23T10:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const STARTED = "2026-10-23T09:50:00.000Z";
const RESERVED = "2026-10-23T11:00:00.000Z";

function battleEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: EVENT_ID,
    tenantId: TENANT_ID,
    name: "Crypto Battle",
    status: "READY",
    problems: [{ problemId: "battle", defaultRegion: "ap-northeast-1" }],
    teamCount: 2,
    createdAt: "2026-10-23T08:00:00.000Z",
    updatedAt: "2026-10-23T08:00:00.000Z",
    expiresAt: 4_102_444_800,
    ...overrides,
  };
}

function fixture(backend: "dynamodb" | "turso", problemsCoordination: Record<string, unknown>) {
  const ddb = makeFakeDdb();
  const sql = makeSqliteExecutor();
  const events =
    backend === "dynamodb"
      ? new DynamoDbEventsRepository(ddb, "Events")
      : new SqlEventsRepository(sql);
  const deployments =
    backend === "dynamodb"
      ? new DynamoDbDeploymentsRepository(ddb, "Deployments")
      : new SqlDeploymentsRepository(sql);
  const shared = {
    runtime: {
      ...makeTestControlDataRuntime(),
      resolveRepositories: async () => ({ events }),
      resolveDeploymentsRepository: async () => deployments,
    },
    ddb,
    eventsTableName: "Events",
    teamsTableName: "Teams",
    deploymentsTableName: "Deployments",
    problemsCoordination,
  } as unknown as EventSharedResources;
  return { events, shared };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["dynamodb", "turso"] as const)("started Battle schedule on %s", (backend) => {
  it("should let only the first of two overlapping requests decide the start", async () => {
    const { events, shared } = fixture(backend, { battle: {} });
    await events.putEvent(battleEvent({ startsAt: RESERVED }));
    let readByLater!: () => void;
    let resumeLater!: () => void;
    const laterHasRead = new Promise<void>((resolve) => {
      readByLater = resolve;
    });
    const laterMayWrite = new Promise<void>((resolve) => {
      resumeLater = resolve;
    });
    const read = events.getEvent.bind(events);
    vi.spyOn(events, "getEvent").mockImplementationOnce(async (...args) => {
      const event = await read(...args);
      readByLater();
      await laterMayWrite;
      return event;
    });

    const later = setEventSchedule(shared, TENANT_ID, EVENT_ID, {
      startsAt: "2026-10-23T12:00:00.000Z",
      nowMs: NOW_MS,
    });
    await laterHasRead;
    const startNow = await setEventSchedule(shared, TENANT_ID, EVENT_ID, {
      startsAt: NOW_ISO,
      nowMs: NOW_MS,
    });
    resumeLater();

    expect(startNow).toMatchObject({ kind: "ok", startsAt: NOW_ISO });
    expect(await later).toEqual({ kind: "schedule_changed" });
    expect((await read(TENANT_ID, EVENT_ID))?.startsAt).toBe(NOW_ISO);
  });

  it("should take the Battle rule from the event's saved catalog, not this deployment's", async () => {
    const { events, shared } = fixture(backend, {});
    const key = `catalogs/${"a".repeat(64)}.json`;
    const saved = vi.spyOn(catalogContext, "savedExecutionCatalog").mockResolvedValue({
      version: 1,
      catalogKey: key,
      catalog: { battle: "saved/battle" },
      scoring: {},
      hints: {},
      endpoints: {},
      phases: {},
      visibility: {},
      runtimes: {},
      disruptions: {},
      writeups: {},
      provenance: {},
      coordination: { battle: { plugin: "coordination/battle.ts" } },
      plugins: {},
      sources: {},
      sourceArchive: { bucket: "test", key: "source.zip", versionId: "1" },
    });
    await events.putEvent(battleEvent({ startsAt: STARTED, catalogKey: key }));

    const out = await setEventSchedule(shared, TENANT_ID, EVENT_ID, {
      startsAt: NOW_ISO,
      nowMs: NOW_MS,
    });

    expect(out).toEqual({
      kind: "running_battle_start_change",
      startsAt: NOW_ISO,
      currentStartsAt: STARTED,
    });
    expect(saved).toHaveBeenCalledWith(key);
    expect((await events.getEvent(TENANT_ID, EVENT_ID))?.startsAt).toBe(STARTED);
  });
});
