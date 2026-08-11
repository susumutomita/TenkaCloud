import { describe, expect, it, vi } from "vitest";

/**
 * scoring-driven tick (#2324): 採点 pass → dispatcher の直接 Invoke client を pin する。
 * `InvocationType=Event` (= async fire-and-forget) で wire batch を JSON payload として送ることを観測する。
 */
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = mocks.send;
  },
  InvokeCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const { createLambdaTickInvoker } = await import(
  "../../lib/problem-deploy/handlers/generic-scoring-handler/coordination-tick-dispatch"
);

describe("createLambdaTickInvoker", () => {
  it("should async-invoke the dispatcher (InvocationType=Event) with the JSON batch payload", async () => {
    mocks.send.mockResolvedValue({});
    const invoke = createLambdaTickInvoker();
    const batch = {
      action: "coordination-tick" as const,
      nowIso: "2026-06-01T01:00:00.000Z",
      targets: [
        { tenantId: "t1", eventId: "e1", moduleRef: "cap", eventNowMs: 900_000, teamIds: ["a"] },
      ],
    };
    await invoke("coord-dispatcher", batch);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const cmd = mocks.send.mock.calls[0][0] as {
      input: { FunctionName: string; InvocationType: string; Payload: Uint8Array };
    };
    expect(cmd.input.FunctionName).toBe("coord-dispatcher");
    expect(cmd.input.InvocationType).toBe("Event");
    expect(JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"))).toEqual(batch);
  });

  it("should propagate an invoke error to the caller (surfaced, not swallowed here)", async () => {
    mocks.send.mockRejectedValueOnce(new Error("throttled"));
    const invoke = createLambdaTickInvoker();
    await expect(
      invoke("coord-dispatcher", { action: "coordination-tick", nowIso: "x", targets: [] }),
    ).rejects.toThrow(/throttled/);
  });
});
