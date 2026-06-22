import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalEvalApp } from "../src/local.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLocalEvalApp", () => {
  it("should build an app that answers healthz", async () => {
    const app = createLocalEvalApp({ signingSecret: "s" });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("should warn when no signing secret is provided (dev default)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLocalEvalApp();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("should accept a localhost endpoint when local targets are allowed (default)", async () => {
    const app = createLocalEvalApp({ signingSecret: "s" });
    const create = await app.request("/runs", {
      method: "POST",
      body: JSON.stringify({ challengeId: "cloudflare-api-security-001" }),
      headers: { "Content-Type": "application/json" },
    });
    const run = (await create.json()) as { runId: string };
    // localhost は unreachable なので評価は失敗するが、 SSRF ガードでは弾かれない (= 400 でない)。
    const res = await app.request(`/runs/${run.runId}/evaluations`, {
      method: "POST",
      body: JSON.stringify({ stage: "0-deploy", endpoint: "http://localhost:8787/" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { passed: boolean }).passed).toBe(false);
  });

  it("should reject a localhost endpoint when local targets are disabled", async () => {
    const app = createLocalEvalApp({ signingSecret: "s", allowLocalTargets: false });
    const create = await app.request("/runs", {
      method: "POST",
      body: JSON.stringify({ challengeId: "cloudflare-api-security-001" }),
      headers: { "Content-Type": "application/json" },
    });
    const run = (await create.json()) as { runId: string };
    const res = await app.request(`/runs/${run.runId}/evaluations`, {
      method: "POST",
      body: JSON.stringify({ stage: "0-deploy", endpoint: "http://localhost:8787/" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});
