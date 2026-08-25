import { describe, expect, it } from "vitest";
import { runFinders } from "../src/finder-orchestration.js";
import type { FinderTaskCheckpoint } from "../src/finder-orchestration.js";
import type {
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
} from "../src/model-provider.js";
import type { ReconFinderAssignment } from "../src/recon.js";

function validClaimText(focusArea: string, witnessId = "w"): string {
  return JSON.stringify({
    witness: {
      type: "http-sequence",
      witnessId,
      focusArea,
      steps: [{ method: "GET", path: "/x", expectStatus: 200 }],
    },
  });
}

function buildPrompt(): { systemPrompt: string; userPrompt: string; maxOutputTokens: number } {
  return { systemPrompt: "sys", userPrompt: "user", maxOutputTokens: 100 };
}

const NO_WAIT = (): Promise<void> => Promise.resolve();

function scriptedProvider(
  script: Readonly<Record<string, ModelProviderResult[]>>,
): { provider: ModelProvider; requests: ModelProviderRequest[] } {
  const requests: ModelProviderRequest[] = [];
  const cursors = new Map<string, number>();
  const provider: ModelProvider = {
    providerId: "test-scripted",
    providerVersion: "1.0.0",
    async complete(request) {
      requests.push(request);
      const entries = script[request.focusArea] ?? [];
      const cursor = cursors.get(request.focusArea) ?? 0;
      cursors.set(request.focusArea, cursor + 1);
      const entry = entries[Math.min(cursor, entries.length - 1)];
      if (entry === undefined) {
        throw new Error(`test bug: no scripted entry for ${request.focusArea}`);
      }
      return entry;
    },
  };
  return { provider, requests };
}

describe("runFinders: parallel fan-out and per-task isolation", () => {
  it("should issue every task's first adapter call before awaiting any one task's result (genuine parallel fan-out, not a sequential loop)", async () => {
    let bStarted = false;
    let aObservedBAlreadyStarted = false;
    const provider: ModelProvider = {
      providerId: "test",
      providerVersion: "1.0.0",
      async complete(request) {
        if (request.focusArea === "area-a") {
          // Bounded spin on microtasks (no real timer, no clock) waiting for area-b's task to
          // have already issued its own call. If runFinders awaited each task one at a time
          // instead of fanning out with Promise.all, area-b's call would never be issued while
          // this is still pending, and this loop would exhaust without ever observing it.
          for (let i = 0; i < 50 && !bStarted; i += 1) {
            await Promise.resolve();
          }
          aObservedBAlreadyStarted = bStarted;
          return {
            ok: true,
            response: {
              outputText: validClaimText("area-a"),
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          };
        }
        bStarted = true;
        return {
          ok: true,
          response: {
            outputText: validClaimText("area-b"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
    };
    const assignments: ReconFinderAssignment[] = [
      { finderIndex: 0, focusArea: "area-a" },
      { finderIndex: 1, focusArea: "area-b" },
    ];
    const { checkpoints } = await runFinders({
      runId: "run-parallel",
      assignments,
      adapter: provider,
      buildPrompt,
      wait: NO_WAIT,
    });
    expect(aObservedBAlreadyStarted).toBe(true);
    expect(checkpoints.every((c) => c.status === "succeeded")).toBe(true);
  });

  it("should give each task a distinct, deterministic sessionId and never share a request object between tasks", async () => {
    const { provider, requests } = scriptedProvider({
      "area-a": [
        {
          ok: true,
          response: {
            outputText: validClaimText("area-a"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ],
      "area-b": [
        {
          ok: true,
          response: {
            outputText: validClaimText("area-b"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ],
    });
    await runFinders({
      runId: "run-iso",
      assignments: [
        { finderIndex: 0, focusArea: "area-a" },
        { finderIndex: 1, focusArea: "area-b" },
      ],
      adapter: provider,
      buildPrompt,
      wait: NO_WAIT,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.sessionId).toBe("run-iso-finder-0");
    expect(requests[1]?.sessionId).toBe("run-iso-finder-1");
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
  });
});

describe("runFinders: rate limit / timeout / model error checkpoint and resume", () => {
  it("should retry a retryable rate-limited call and succeed once the adapter recovers", async () => {
    const waitCalls: number[] = [];
    const { provider } = scriptedProvider({
      area: [
        { ok: false, error: { kind: "rate_limited", message: "429", retryable: true } },
        { ok: false, error: { kind: "rate_limited", message: "429", retryable: true } },
        {
          ok: true,
          response: {
            outputText: validClaimText("area"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ],
    });
    const { checkpoints } = await runFinders({
      runId: "run-retry",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      retryPolicy: { maxAttempts: 3 },
      wait: async (attempt) => {
        waitCalls.push(attempt);
      },
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.status).toBe("succeeded");
    expect(checkpoints[0]?.attempts).toBe(3);
    expect(checkpoints[0]?.handoff).toBeDefined();
    expect(waitCalls).toEqual([1, 2]);
  });

  // This is the "no false pass" mutation-tested case: exhausting the retry budget on a retryable
  // error must NEVER produce status "succeeded". See the mutation demonstration in the PR/report.
  it("should end with a non-succeeded status when rate limiting persists past the retry budget — never fall back to success", async () => {
    const { provider } = scriptedProvider({
      area: [
        { ok: false, error: { kind: "rate_limited", message: "429", retryable: true } },
        { ok: false, error: { kind: "rate_limited", message: "429", retryable: true } },
        { ok: false, error: { kind: "rate_limited", message: "429", retryable: true } },
      ],
    });
    const { checkpoints } = await runFinders({
      runId: "run-exhausted",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      retryPolicy: { maxAttempts: 3 },
      wait: NO_WAIT,
    });
    expect(checkpoints[0]?.status).toBe("rate_limited");
    expect(checkpoints[0]?.status).not.toBe("succeeded");
    expect(checkpoints[0]?.attempts).toBe(3);
    expect(checkpoints[0]?.handoff).toBeUndefined();
  });

  it("should end after exactly one attempt on a non-retryable transport error, without waiting or retrying", async () => {
    const waitCalls: number[] = [];
    const { provider } = scriptedProvider({
      area: [{ ok: false, error: { kind: "transport_error", message: "500", retryable: false } }],
    });
    const { checkpoints } = await runFinders({
      runId: "run-nonretryable",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      retryPolicy: { maxAttempts: 5 },
      wait: async (attempt) => {
        waitCalls.push(attempt);
      },
    });
    expect(checkpoints[0]?.status).toBe("model_error");
    expect(checkpoints[0]?.attempts).toBe(1);
    expect(waitCalls).toEqual([]);
  });

  it("should end with timed_out status (not succeeded) when every attempt times out", async () => {
    const { provider } = scriptedProvider({
      area: [
        { ok: false, error: { kind: "timeout", message: "deadline exceeded", retryable: true } },
        { ok: false, error: { kind: "timeout", message: "deadline exceeded", retryable: true } },
      ],
    });
    const { checkpoints } = await runFinders({
      runId: "run-timeout",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      retryPolicy: { maxAttempts: 2 },
      wait: NO_WAIT,
    });
    expect(checkpoints[0]?.status).toBe("timed_out");
    expect(checkpoints[0]?.handoff).toBeUndefined();
  });

  it("should record invalid_output (not succeeded) when the model call succeeds but the output fails the PoC-only handoff schema", async () => {
    const { provider } = scriptedProvider({
      area: [
        {
          ok: true,
          response: {
            outputText: JSON.stringify({
              witness: { type: "http-sequence", witnessId: "w", focusArea: "area", steps: [] },
            }),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ],
    });
    const { checkpoints } = await runFinders({
      runId: "run-invalid",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      wait: NO_WAIT,
    });
    expect(checkpoints[0]?.status).toBe("invalid_output");
    expect(checkpoints[0]?.handoff).toBeUndefined();
    expect(checkpoints[0]?.errors.length).toBeGreaterThan(0);
  });

  it("should never call the adapter for a task whose checkpoint already succeeded (resume reuses completed work)", async () => {
    const previousHandoffCheckpoint: FinderTaskCheckpoint = {
      finderIndex: 0,
      focusArea: "area-done",
      status: "succeeded",
      attempts: 1,
      handoff: {
        focusArea: "area-done",
        finderIndex: 0,
        witness: {
          type: "http-sequence",
          witnessId: "already-confirmed",
          focusArea: "area-done",
          steps: [{ method: "GET", path: "/x", expectStatus: 200 }],
        },
        targetMetadata: {},
      },
      errors: [],
    };
    const calls: string[] = [];
    const provider: ModelProvider = {
      providerId: "test",
      providerVersion: "1.0.0",
      async complete(request) {
        calls.push(request.focusArea);
        if (request.focusArea === "area-done") {
          throw new Error("must not be called again — this task already succeeded");
        }
        return {
          ok: true,
          response: {
            outputText: validClaimText("area-pending"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        };
      },
    };
    const { checkpoints } = await runFinders({
      runId: "run-resume",
      assignments: [
        { finderIndex: 0, focusArea: "area-done" },
        { finderIndex: 1, focusArea: "area-pending" },
      ],
      adapter: provider,
      buildPrompt,
      resumeFrom: [previousHandoffCheckpoint],
      wait: NO_WAIT,
    });
    expect(calls).toEqual(["area-pending"]);
    expect(checkpoints.find((c) => c.finderIndex === 0)).toEqual(previousHandoffCheckpoint);
    expect(checkpoints.find((c) => c.finderIndex === 1)?.status).toBe("succeeded");
  });

  it("should retry a task fresh on resume when its previous checkpoint was not succeeded", async () => {
    const previousFailure: FinderTaskCheckpoint = {
      finderIndex: 0,
      focusArea: "area",
      status: "rate_limited",
      attempts: 3,
      errors: ["429"],
    };
    const { provider } = scriptedProvider({
      area: [
        {
          ok: true,
          response: {
            outputText: validClaimText("area"),
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ],
    });
    const { checkpoints } = await runFinders({
      runId: "run-resume-retry",
      assignments: [{ finderIndex: 0, focusArea: "area" }],
      adapter: provider,
      buildPrompt,
      resumeFrom: [previousFailure],
      wait: NO_WAIT,
    });
    expect(checkpoints[0]?.status).toBe("succeeded");
  });
});

describe("runFinders: cancellation stops new work", () => {
  it("should never call the adapter for any task when cancellation is requested from the start", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      providerId: "test",
      providerVersion: "1.0.0",
      async complete() {
        calls += 1;
        return {
          ok: true,
          response: { outputText: "{}", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
        };
      },
    };
    const { checkpoints } = await runFinders({
      runId: "run-cancel",
      assignments: [
        { finderIndex: 0, focusArea: "a" },
        { finderIndex: 1, focusArea: "b" },
      ],
      adapter: provider,
      buildPrompt,
      wait: NO_WAIT,
      shouldCancel: () => true,
    });
    expect(calls).toBe(0);
    expect(checkpoints.every((c) => c.status === "cancelled")).toBe(true);
  });
});
