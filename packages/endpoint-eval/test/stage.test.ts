import { describe, expect, it, vi } from "vitest";
import type { ProbeContext } from "../src/probe.js";
import { evaluateStage, type StageDefinition } from "../src/stage.js";

const BASE = new URL("https://team.example.workers.dev");

const stage: StageDefinition = {
  id: "1-input-validation",
  title: "Input validation",
  probes: [
    {
      id: "rejects-bad-json",
      request: { method: "POST", path: "/profiles", body: "not json" },
      expect: { status: 400 },
      description: "不正 JSON を 400 で拒否すること",
    },
    {
      id: "rejects-long-value",
      request: { method: "POST", path: "/profiles", body: '{"name":"loooong"}' },
      expect: { status: 400 },
      description: "過長な値を拒否すること",
    },
  ],
};

function ctx(fetchFn: typeof fetch): ProbeContext {
  return { fetchFn, values: {}, timeoutMs: 1_000, maxBodyBytes: 4096 };
}

describe("evaluateStage", () => {
  it("should pass only when every probe passes", async () => {
    const fetchFn = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;
    const result = await evaluateStage(BASE, stage, ctx(fetchFn));
    expect(result.passed).toBe(true);
    expect(result.stageId).toBe("1-input-validation");
    expect(result.probes).toHaveLength(2);
  });

  it("should fail the stage when any probe fails", async () => {
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      return new Response("", { status: call === 1 ? 400 : 200 });
    }) as unknown as typeof fetch;
    const result = await evaluateStage(BASE, stage, ctx(fetchFn));
    expect(result.passed).toBe(false);
    expect(result.probes.filter((p) => p.passed)).toHaveLength(1);
  });
});
