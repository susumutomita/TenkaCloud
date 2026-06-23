import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDeploy } from "../src/commands/deploy.ts";
import { saveTokens } from "../src/credential-store.ts";

const ENV = { TENKACLOUD_API_BASE_DEPLOY: "https://deploy.example.com" };

let originalHome: string | undefined;
let tempDir: string;
const captured: string[] = [];
const out = (s: string) => {
  captured.push(s);
};

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-deploy-"));
  process.env.HOME = tempDir;
  captured.length = 0;
  saveTokens({
    accessToken: "bearer-d",
    idToken: "id",
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 10000,
    issuer: "i",
    clientId: "c",
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runDeploy", () => {
  it("should POST /deployments with positional triple", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ deploymentId: "d1" }), { status: 200 }),
    );
    await runDeploy(["evt-1", "team-1", "prob-1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://deploy.example.com/deployments");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      eventId: "evt-1",
      teamId: "team-1",
      problemId: "prob-1",
    });
  });

  it("should POST /deployments/bulk for bulk", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runDeploy(["bulk", "evt-1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://deploy.example.com/deployments/bulk",
    );
  });

  it("should GET /deployments/<id> for status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ deploymentId: "d1", status: "DEPLOYED" }), { status: 200 }),
    );
    await runDeploy(["status", "d1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://deploy.example.com/deployments/d1");
  });

  it("should GET /deployments/<id>/logs for logs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runDeploy(["logs", "d1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://deploy.example.com/deployments/d1/logs",
    );
  });

  it("should require <eventId> for bulk", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(
      runDeploy(["bulk"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<eventId>/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should require <deploymentId> for status", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runDeploy(["status"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<deploymentId>/);
  });

  it("should require <deploymentId> for logs", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runDeploy(["logs"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<deploymentId>/);
  });

  it("should require <teamId> when only eventId is given", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runDeploy(["evt-1"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<teamId>/);
  });
});

describe("runDeploy help", () => {
  it.each(["help", "--help", "-h"])("should print usage and return 0 for '%s'", async (token) => {
    const fetchImpl = vi.fn();
    const code = await runDeploy([token], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
    expect(captured.join("\n")).toContain("Usage: tenkacloud deploy");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should print usage and return 0 when called with no args", async () => {
    const fetchImpl = vi.fn();
    const code = await runDeploy([], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
  });

  it("should fall back to console.log + process.env when out/env omitted", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ deploymentId: "d9" }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.TENKACLOUD_API_BASE_DEPLOY = "https://deploy.fallback.com";
    try {
      const code = await runDeploy(["evt-9", "team-9", "prob-9", "--json"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      });
      expect(code).toBe(0);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://deploy.fallback.com/deployments");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]?.[0])).toContain("d9");
    } finally {
      logSpy.mockRestore();
      delete process.env.TENKACLOUD_API_BASE_DEPLOY;
    }
  });
});
