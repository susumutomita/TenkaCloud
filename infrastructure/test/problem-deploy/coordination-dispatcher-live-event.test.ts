import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinationTickBatch } from "../../lib/problem-deploy/handlers/shared/coordination-tick-contract";

/**
 * [Issue #3453] The dispatcher's catalog resolver hands each tick the event it read. Loading the
 * saved catalog and materializing the plugin can be slow on a cold start, so a target that runs
 * the plugin must get the event as stored after that work, not the snapshot read before it.
 */
interface LiveState {
  deleteOnImport: boolean;
  preserveEnd: boolean;
  configured: boolean[];
  event: Record<string, string | boolean> | undefined;
  resolved: { endsAt?: string; error?: string }[];
}
const live = vi.hoisted(
  (): LiveState => ({
    deleteOnImport: false,
    preserveEnd: false,
    configured: [],
    event: undefined,
    resolved: [],
  }),
);

vi.mock("../../lib/problem-deploy/control-data/runtime-repositories", () => ({
  createDefaultControlDataRuntime: () => ({}),
}));
vi.mock(
  "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/coordination-backends",
  () => ({
    createScoreDeliveryControlDataRuntime: () => ({}),
    createScoreDeliveryDdbClient: () => ({ send: vi.fn() }),
  }),
);
vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", () => ({
  buildParticipantSharedResources: () => ({
    runtime: {
      resolveEventsRepository: async () => ({
        getEvent: async () => (live.event ? { ...live.event } : undefined),
      }),
    },
    ddb: { send: vi.fn() },
    tableName: "T",
    eventsTableName: "Events",
    catalogLoader: async () => ({ coordination: { cap: { plugin: "coordination/cap.ts" } } }),
  }),
}));
vi.mock(
  "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/s3-plugin-importer",
  () => ({
    defaultS3PluginImporter: () => async () => ({}),
    executionPluginImporter: () => async () => {
      live.event = live.deleteOnImport
        ? undefined
        : { ...live.event, ...(live.preserveEnd ? {} : { endsAt: "2026-06-01T00:20:00.000Z" }) };
      return {};
    },
  }),
);
vi.mock(
  "../../lib/problem-deploy/handlers/participant-handler/coordination-tick",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../lib/problem-deploy/handlers/participant-handler/coordination-tick")
      >();
    return {
      ...original,
      handleCoordinationTickBatch: async (
        deps: Parameters<typeof original.handleCoordinationTickBatch>[0],
        batch: CoordinationTickBatch,
      ) => {
        for (const target of batch.targets) {
          try {
            const scoped = await deps.resolveCatalog?.(target, batch.nowIso);
            live.resolved.push({ endsAt: scoped?.event?.endsAt });
            live.configured.push(Boolean(scoped?.config[target.moduleRef]));
          } catch (error) {
            live.resolved.push({ error: String(error) });
          }
        }
        return { ticked: batch.targets.length, written: 0 };
      },
    };
  },
);

const { handler } = await import(
  "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/index"
);

const target = {
  tenantId: "t1",
  eventId: "e1",
  moduleRef: "cap",
  eventNowMs: 300_000,
  teamIds: [],
};
const tick = (over: Record<string, unknown>, nowIso = "2026-06-01T00:05:00.000Z") =>
  handler(
    {
      action: "coordination-tick",
      nowIso,
      targets: [{ ...target, ...over }],
    },
    undefined as never,
  );

beforeEach(() => {
  live.deleteOnImport = false;
  live.preserveEnd = false;
  live.configured = [];
  live.event = {
    tenantId: "t1",
    eventId: "e1",
    status: "READY",
    startsAt: "2026-06-01T00:00:00.000Z",
    endsAt: "2026-06-01T00:10:00.000Z",
  };
  live.resolved = [];
});

describe("coordination dispatcher catalog resolver", () => {
  it.each([
    ["a tick", {}],
    ["a reset recovered after the end", { drainOnly: true, initializeRunId: "run-2" }],
  ])("should hand %s the end as stored after the plugin is materialized", async (_case, over) => {
    await tick(over);
    expect(live.resolved).toEqual([{ endsAt: "2026-06-01T00:20:00.000Z" }]);
  });

  it("should refuse a tick for an event deleted while its plugin loaded", async () => {
    live.deleteOnImport = true;
    await tick({});
    expect(live.resolved).toEqual([
      { error: "Error: catalog_event_missing: saved event is unavailable" },
    ]);
  });

  it.each([{}, { drainOnly: true }])(
    "allows endpoint settlement after End Event for %j",
    async (over) => {
      live.event = { ...live.event, status: "ENDED", scoringLocked: true };
      live.preserveEnd = true;
      await tick(over, "2026-06-01T00:11:00.000Z");
      expect(live.configured).toEqual([true]);
      expect(live.resolved).toEqual([{ endsAt: "2026-06-01T00:10:00.000Z" }]);
    },
  );

  it("allows an ordinary queued tick after scheduled completion", async () => {
    live.preserveEnd = true;
    await tick({}, "2026-06-01T00:11:00.000Z");
    expect(live.configured).toEqual([true]);
  });

  it("does not enable an ordinary tick while READY scoring is locked", async () => {
    live.event = { ...live.event, scoringLocked: true };
    await tick({}, "2026-06-01T00:11:00.000Z");
    expect(live.configured).toEqual([false]);
  });

  it("should hand a drain the event it read, since a drain never runs the plugin", async () => {
    await tick({ drainOnly: true });
    expect(live.resolved).toEqual([{ endsAt: "2026-06-01T00:10:00.000Z" }]);
  });
});
