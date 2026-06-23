import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTenants } from "../src/commands/tenants.ts";
import { saveTokens } from "../src/credential-store.ts";

const ENV = {
  TENKACLOUD_API_BASE_CONTROL: "https://control.example.com",
};

let originalHome: string | undefined;
let tempDir: string;
const captured: string[] = [];
const out = (s: string) => {
  captured.push(s);
};

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-tenants-"));
  process.env.HOME = tempDir;
  captured.length = 0;
  saveTokens({
    accessToken: "bearer-123",
    idToken: "id-1",
    refreshToken: "rt-1",
    expiresAt: Math.floor(Date.now() / 1000) + 10000,
    issuer: "https://cognito-idp.local/userpool",
    clientId: "client-1",
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runTenants list", () => {
  it("should GET /tenants and render pretty table", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ tenantId: "t-1", tenantName: "A", tier: "BASIC" }] }),
          { status: 200 },
        ),
    );
    const code = await runTenants(["list"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://control.example.com/tenants");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer bearer-123",
    );
    expect(captured.join("\n")).toContain("t-1");
  });

  it("should output JSON when --json flag set", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ tenantId: "t-1" }] }), { status: 200 }),
    );
    await runTenants(["list", "--json"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(captured[0]?.trim().startsWith("[")).toBe(true);
  });
});

describe("runTenants get/create/delete", () => {
  it("should GET /tenants/<id>", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ tenantId: "t-1" }), { status: 200 }),
    );
    await runTenants(["get", "t-1"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://control.example.com/tenants/t-1");
  });

  it("should POST /tenants for create", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ tenantId: "t-1" }), { status: 200 }),
    );
    await runTenants(["create", "--name", "Acme", "--tier", "BASIC", "--admin-email", "a@b.c"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://control.example.com/tenants");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe('{"tenantName":"Acme","tier":"BASIC","email":"a@b.c"}');
  });

  it("should DELETE /tenants/<id>", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await runTenants(["delete", "t-1"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect((init as RequestInit).method).toBe("DELETE");
    expect(String(url)).toBe("https://control.example.com/tenants/t-1");
  });

  it("should fail loudly when --name missing on create", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTenants(["create", "--tier", "BASIC", "--admin-email", "a@b.c"], {
        auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--name/);
  });

  it("should fail loudly when --tier missing on create", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTenants(["create", "--name", "Acme", "--admin-email", "a@b.c"], {
        auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--tier/);
  });

  it("should require <tenantId> on get", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTenants(["get"], {
        auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<tenantId>/);
  });

  it("should require <tenantId> on delete", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runTenants(["delete"], {
        auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<tenantId>/);
  });

  it("should print Deleted message on delete", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await runTenants(["delete", "t-7"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(captured.join("\n")).toContain("Deleted: t-7");
  });
});

describe("runTenants usage / fallback", () => {
  it("should print usage and return 0 when no subcommand", async () => {
    const fetchImpl = vi.fn();
    const code = await runTenants([], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
    expect(captured.join("\n")).toContain("Usage: tenkacloud tenants");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should print usage and return 1 on unknown subcommand", async () => {
    const fetchImpl = vi.fn();
    const code = await runTenants(["nope"], {
      auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(1);
    expect(captured.join("\n")).toContain("create --name");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should fall back to console.log + process.env when out/env omitted", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.TENKACLOUD_API_BASE_CONTROL = "https://control.fallback.com";
    try {
      const code = await runTenants(["list"], {
        auth: { hostedUiDomain: "https://auth.example.com", fetchImpl: fetchImpl as never },
      });
      expect(code).toBe(0);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://control.fallback.com/tenants");
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      delete process.env.TENKACLOUD_API_BASE_CONTROL;
    }
  });
});
