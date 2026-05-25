import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvents } from "../src/commands/events.ts";
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
  tempDir = mkdtempSync(join(tmpdir(), "cli-events-"));
  process.env.HOME = tempDir;
  captured.length = 0;
  saveTokens({
    accessToken: "bearer-evt",
    idToken: "id-1",
    refreshToken: "rt-1",
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

describe("runEvents", () => {
  it("should GET /events with status query when --status given", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runEvents(["list", "--status", "RUNNING"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://tenant.example.com/events?status=RUNNING",
    );
  });

  it("should POST /events for create", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ eventId: "e1" }), { status: 200 }),
    );
    await runEvents(
      [
        "create",
        "--name",
        "Tournament",
        "--start",
        "2026-01-01T00:00Z",
        "--end",
        "2026-01-01T05:00Z",
        "--problemset",
        "ps-1",
      ],
      { auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never }, env: ENV, out },
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://tenant.example.com/events");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("should POST /events/<id>/end", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ eventId: "e1" }), { status: 200 }),
    );
    await runEvents(["end", "e1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://tenant.example.com/events/e1/end");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("should POST /events/<id>/archive", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ eventId: "e1" }), { status: 200 }),
    );
    await runEvents(["archive", "e1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://tenant.example.com/events/e1/archive",
    );
  });

  it("should print markdown from report", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ markdown: "# Report\n" }), { status: 200 }),
    );
    await runEvents(["report", "e1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(captured[0]).toContain("# Report");
  });
});
