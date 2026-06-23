import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIdp } from "../src/commands/idp.ts";
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
  tempDir = mkdtempSync(join(tmpdir(), "cli-idp-"));
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

describe("runIdp", () => {
  it("should GET /idp for list", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runIdp(["list"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://tenant.example.com/idp");
  });

  it("should POST /idp for create", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ idpId: "i1" }), { status: 200 }),
    );
    await runIdp(["create", "--name", "Okta", "--metadata-url", "https://x/m.xml"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"Okta","metadataUrl":"https://x/m.xml"}');
  });

  it("should PATCH /idp/<id> for update", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ idpId: "i1" }), { status: 200 }),
    );
    await runIdp(["update", "i1", "--metadata-url", "https://x/m2.xml"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://tenant.example.com/idp/i1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("should DELETE /idp/<id>", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await runIdp(["delete", "i1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).method).toBe("DELETE");
    expect(captured.join("\n")).toContain("Deleted: i1");
  });

  it("should require --name on create", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runIdp(["create", "--metadata-url", "https://x/m.xml"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--name/);
  });

  it("should require --metadata-url on create", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runIdp(["create", "--name", "Okta"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/--metadata-url/);
  });

  it("should require <idpId> on update", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runIdp(["update", "--metadata-url", "https://x/m.xml"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<idpId>/);
  });

  it("should require <idpId> on delete", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runIdp(["delete"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
        env: ENV,
        out,
      }),
    ).rejects.toThrow(/<idpId>/);
  });
});

describe("runIdp usage / fallback", () => {
  it("should print usage and return 0 when no subcommand", async () => {
    const fetchImpl = vi.fn();
    const code = await runIdp([], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(0);
    expect(captured.join("\n")).toContain("Usage: tenkacloud idp");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should print usage and return 1 on unknown subcommand", async () => {
    const fetchImpl = vi.fn();
    const code = await runIdp(["wat"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(code).toBe(1);
    expect(captured.join("\n")).toContain("create --name");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should fall back to console.log + process.env when out/env omitted", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.TENKACLOUD_API_BASE_TENANT = "https://tenant.fallback.com";
    try {
      const code = await runIdp(["list"], {
        auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      });
      expect(code).toBe(0);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://tenant.fallback.com/idp");
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      delete process.env.TENKACLOUD_API_BASE_TENANT;
    }
  });
});
