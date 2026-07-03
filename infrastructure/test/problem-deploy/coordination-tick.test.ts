import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { tickCoordinationState } from "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick.js";

interface WindowState {
  readonly closed: boolean;
}

const plugin: CoordinationPlugin<WindowState, never> = {
  initialState: () => ({ closed: false }),
  validateOp: () => ({ ok: false, error: "unused" }),
  applyOp: (state) => state,
  projectForTeam: (state) => state,
  tick: (state, nowMs) => (nowMs >= 1_000 ? { closed: true } : state),
};

function fakeStore(options: { state?: WindowState; version?: number; conflict?: boolean }) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetCommand) {
      return options.state ? { Item: { state: options.state, version: options.version ?? 0 } } : {};
    }
    if (command instanceof PutCommand) {
      if (options.conflict) {
        throw new ConditionalCheckFailedException({ message: "conflict", $metadata: {} });
      }
      return {};
    }
    throw new Error("unexpected command");
  });
  return { send, store: { ddb: { send } as never, tableName: "Deployments" } };
}

const input = {
  tenantId: "tenant-1",
  eventId: "event-1",
  moduleRef: "sector-control",
  ctx: { eventId: "event-1", teamIds: ["team-1", "team-2"] },
  nowIso: "2026-07-03T00:00:00.000Z",
};

describe("coordination scoring tick (#2324)", () => {
  it("should persist a time-driven transition with the current optimistic version", async () => {
    const { send, store } = fakeStore({ state: { closed: false }, version: 4 });

    await expect(
      tickCoordinationState(async () => ({ default: plugin }), store, {
        ...input,
        eventNowMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "updated" });

    const put = send.mock.calls.map((call) => call[0]).find((value) => value instanceof PutCommand);
    expect(put?.input.Item).toMatchObject({ state: { closed: true }, version: 5 });
  });

  it("should initialize a missing coordination row at version zero", async () => {
    const { send, store } = fakeStore({});

    await expect(
      tickCoordinationState(async () => ({ default: plugin }), store, {
        ...input,
        eventNowMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "updated" });

    const put = send.mock.calls.map((call) => call[0]).find((value) => value instanceof PutCommand);
    expect(put?.input.Item).toMatchObject({ state: { closed: true }, version: 1 });
    expect(put?.input.ConditionExpression).toContain("attribute_not_exists");
  });

  it("should not write when runTick returns the existing state", async () => {
    const { send, store } = fakeStore({ state: { closed: false }, version: 2 });

    await expect(
      tickCoordinationState(async () => ({ default: plugin }), store, {
        ...input,
        eventNowMs: 999,
      }),
    ).resolves.toEqual({ kind: "noop" });
    expect(send.mock.calls.some((call) => call[0] instanceof PutCommand)).toBe(false);
  });

  it("should surface an optimistic-lock conflict for retry on the next minute", async () => {
    const { store } = fakeStore({ state: { closed: false }, conflict: true });

    await expect(
      tickCoordinationState(async () => plugin, store, { ...input, eventNowMs: 1_000 }),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("should leave state untouched when the plugin cannot be loaded", async () => {
    const { send, store } = fakeStore({});

    await expect(
      tickCoordinationState(
        async () => {
          throw new Error("missing");
        },
        store,
        { ...input, eventNowMs: 1_000 },
      ),
    ).resolves.toEqual({ kind: "plugin_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
});
