import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScoreboard, runScoreEvents } from "../src/commands/scoreboard.ts";
import { saveTokens } from "../src/credential-store.ts";

const ENV = { TENKACLOUD_API_BASE_EVENT: "https://event.example.com" };

let originalHome: string | undefined;
let tempDir: string;
const captured: string[] = [];
const out = (s: string) => {
  captured.push(s);
};

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-score-"));
  process.env.HOME = tempDir;
  captured.length = 0;
  saveTokens({
    accessToken: "bearer-s",
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

describe("runScoreboard", () => {
  it("should GET /events/<id>/scoreboard", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify([{ teamId: "t1", score: 100 }]), { status: 200 }),
    );
    await runScoreboard(["e1"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://event.example.com/events/e1/scoreboard",
    );
    expect(captured.join("\n")).toContain("t1");
  });

  it("should output csv when --csv flag", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify([{ teamId: "t1", score: 1 }]), { status: 200 }),
    );
    await runScoreboard(["e1", "--csv"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    expect(captured[0]).toContain("rank,teamId");
  });
});

describe("runScoreEvents", () => {
  it("should GET /events/<id>/score-events with filters", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await runScoreEvents(["e1", "--team", "t1", "--from", "2026-01-01", "--to", "2026-01-02"], {
      auth: { hostedUiDomain: "https://auth", fetchImpl: fetchImpl as never },
      env: ENV,
      out,
    });
    const url = String(fetchImpl.mock.calls[0]?.[0] ?? "");
    expect(url.startsWith("https://event.example.com/events/e1/score-events?")).toBe(true);
    expect(url).toContain("team=t1");
    expect(url).toContain("from=2026-01-01");
    expect(url).toContain("to=2026-01-02");
  });
});
