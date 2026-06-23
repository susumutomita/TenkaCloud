import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAudit } from "../src/commands/audit.ts";
import { saveTokens } from "../src/credential-store.ts";

const ENV = { TENKACLOUD_API_BASE_TENANT: "https://tenant.example.com" };

let originalHome: string | undefined;
let tempDir: string;
const captured: string[] = [];
const out = (s: string) => {
  captured.push(s);
};

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-audit-"));
  process.env.HOME = tempDir;
  captured.length = 0;
  saveTokens({
    accessToken: "bearer",
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

describe("runAudit query", () => {
  it("should GET /audit with filters", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runAudit(
      ["query", "--from", "2026-01-01", "--to", "2026-01-02", "--principal", "alice"],
      { auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never }, env: ENV, out },
    );
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url.startsWith("https://tenant.example.com/audit?")).toBe(true);
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("principal=alice");
  });
});

describe("runAudit export", () => {
  it("should write CSV to specified path", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([{ timestamp: "2026-01-01T00:00", principal: "alice", action: "create" }]),
          { status: 200 },
        ),
    );
    const writes: Array<[string, string]> = [];
    await runAudit(
      ["export", "--from", "2026-01-01", "--to", "2026-01-02", "--out", "/tmp/x.csv"],
      {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
        writeFile: (p, c) => writes.push([p, c]),
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe("/tmp/x.csv");
    expect(writes[0]?.[1]).toContain("alice");
    expect(captured.join(" ")).toContain("1 entries");
  });

  it("should require --out", async () => {
    await expect(
      runAudit(["export", "--from", "a", "--to", "b"], {
        auth: { hostedUiDomain: "https://auth" },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--out/);
  });

  it("should require --from", async () => {
    await expect(
      runAudit(["export", "--to", "b", "--out", "/tmp/x.csv"], {
        auth: { hostedUiDomain: "https://auth" },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--from/);
  });

  it("should fall back to writeFileSync when writeFile dep omitted", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([{ timestamp: "2026-01-01T00:00", principal: "bob", action: "delete" }]),
          { status: 200 },
        ),
    );
    const outPath = join(tempDir, "audit-real.csv");
    const code = await runAudit(
      ["export", "--from", "2026-01-01", "--to", "2026-01-02", "--out", outPath],
      { auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never }, env: ENV, out },
    );
    expect(code).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("bob");
  });
});

describe("runAudit usage / fallback", () => {
  it("should print usage and return 0 when no subcommand", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const code = await runAudit([], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
    expect(captured.join("\n")).toContain("Usage: tenkacloud audit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should print usage and return 1 on unknown subcommand", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const code = await runAudit(["bogus"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(1);
    expect(captured.join("\n")).toContain("query");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should fall back to console.log + process.env when out/env omitted", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.TENKACLOUD_API_BASE_TENANT = "https://tenant.fallback.com";
    try {
      const code = await runAudit(["query"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      });
      expect(code).toBe(0);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://tenant.fallback.com/audit");
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      delete process.env.TENKACLOUD_API_BASE_TENANT;
    }
  });
});
