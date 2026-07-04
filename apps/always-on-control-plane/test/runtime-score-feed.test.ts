import { env } from "cloudflare:workers";
import { StatusCodes } from "http-status-codes";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ControlStore } from "../src/store.js";
import type { AppEnvironment } from "../src/types.js";

const RUNTIME_TOKEN = "runtime-feed-token-0123456789abcdef";
const envWithToken: AppEnvironment["Bindings"] = { ...env, RUNTIME_FEED_TOKEN: RUNTIME_TOKEN };

function post(
  eventId: string,
  body: unknown,
  token?: string,
  envBindings: AppEnvironment["Bindings"] = envWithToken,
) {
  return createApp().request(
    `https://control.example/v1/runtime/events/${eventId}/score-summaries`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    envBindings,
  );
}

async function seedTeam(eventId: string, teamId: string, displayName: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO events (event_id, tenant_id, name, status, created_at, updated_at)
     VALUES (?, 'tenant-a', ?, 'ACTIVE', ?, ?)`,
  )
    .bind(eventId, eventId, now, now)
    .run();
  await env.CONTROL_DB.prepare(
    `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
     VALUES (?, ?, 'tenant-a', ?, ?, ?)`,
  )
    .bind(teamId, eventId, displayName, `hash-${teamId}`, now)
    .run();
}

async function seedFlagScore(
  eventId: string,
  teamId: string,
  score: number,
  solved: number,
): Promise<void> {
  // The AFTER-INSERT-ON-teams trigger already seeded a 0-row; flag scoring updates it in place.
  await env.CONTROL_DB.prepare(
    `UPDATE score_summary SET score = ?, solved_checkpoints = ?, updated_at = '2026-07-04T10:00:00.000Z'
      WHERE event_id = ? AND team_id = ?`,
  )
    .bind(score, solved, eventId, teamId)
    .run();
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(`
    DELETE FROM runtime_score;
    DELETE FROM submissions;
    DELETE FROM score_summary;
    DELETE FROM challenge_checkpoints;
    DELETE FROM teams;
    DELETE FROM events;
  `);
});

describe("POST /v1/runtime/events/:eventId/score-summaries (#2294)", () => {
  it("should upsert uptime scores with a valid runtime-feed bearer", async () => {
    await seedTeam("evt", "team-1", "Alpha");
    const res = await post("evt", { scores: [{ teamId: "team-1", points: 42 }] }, RUNTIME_TOKEN);
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board).toEqual([
      expect.objectContaining({ teamId: "team-1", displayName: "Alpha", score: 42 }),
    ]);
  });

  it("should upsert (overwrite) on a second feed for the same team", async () => {
    await seedTeam("evt", "team-1", "Alpha");
    await post("evt", { scores: [{ teamId: "team-1", points: 10 }] }, RUNTIME_TOKEN);
    await post("evt", { scores: [{ teamId: "team-1", points: 55 }] }, RUNTIME_TOKEN);
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board[0]).toMatchObject({ teamId: "team-1", score: 55 });
  });

  it("should batch multiple teams in one call", async () => {
    await seedTeam("evt", "team-1", "Alpha");
    await seedTeam("evt", "team-2", "Bravo");
    const res = await post(
      "evt",
      {
        scores: [
          { teamId: "team-1", points: 30 },
          { teamId: "team-2", points: 70 },
        ],
      },
      RUNTIME_TOKEN,
    );
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board.map((row) => [row.teamId, row.score])).toEqual([
      ["team-2", 70],
      ["team-1", 30],
    ]);
  });

  it("should reject a missing, wrong, or unconfigured bearer", async () => {
    await seedTeam("evt", "team-1", "Alpha");
    expect((await post("evt", { scores: [{ teamId: "team-1", points: 1 }] })).status).toBe(
      StatusCodes.UNAUTHORIZED,
    );
    expect((await post("evt", { scores: [{ teamId: "team-1", points: 1 }] }, "wrong")).status).toBe(
      StatusCodes.UNAUTHORIZED,
    );
    expect(
      (await post("evt", { scores: [{ teamId: "team-1", points: 1 }] }, RUNTIME_TOKEN, env)).status,
    ).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });

  it("should reject malformed score bodies with 400", async () => {
    for (const body of [
      { scores: [] },
      { scores: "nope" },
      { scores: [{ teamId: "team-1" }] },
      { scores: [{ teamId: "team-1", points: -1 }] },
      { scores: [{ teamId: "team-1", points: 1.5 }] },
      { scores: [{ points: 5 }] },
      { scores: [42] },
    ]) {
      expect((await post("evt", body, RUNTIME_TOKEN)).status).toBe(StatusCodes.BAD_REQUEST);
    }
  });

  it("should reject a whitespace-only eventId with 400", async () => {
    expect(
      (await post("%20", { scores: [{ teamId: "team-1", points: 1 }] }, RUNTIME_TOKEN)).status,
    ).toBe(StatusCodes.BAD_REQUEST);
  });
});

describe("ControlStore.leaderboard flag + uptime coexistence (#2294)", () => {
  it("should sum flag score and uptime score per team", async () => {
    await seedTeam("evt", "flagteam", "Flags");
    await seedFlagScore("evt", "flagteam", 30, 2);
    await new ControlStore(env.CONTROL_DB).upsertRuntimeScore({
      eventId: "evt",
      teamId: "flagteam",
      points: 12,
    });
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board[0]).toMatchObject({ teamId: "flagteam", score: 42, solvedCheckpoints: 2 });
  });

  it("should include an uptime-only team (no flag submissions)", async () => {
    await seedTeam("evt", "uptimeonly", "Uptime");
    await new ControlStore(env.CONTROL_DB).upsertRuntimeScore({
      eventId: "evt",
      teamId: "uptimeonly",
      points: 15,
    });
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board).toEqual([
      expect.objectContaining({ teamId: "uptimeonly", score: 15, solvedCheckpoints: 0 }),
    ]);
  });

  it("should rank an uptime-fed team above a still-zero team", async () => {
    // Every team carries a score_summary 0-row (trigger), so both appear; ordering reflects the sum.
    await seedTeam("evt", "scored", "Scored");
    await seedTeam("evt", "zero", "Zero");
    await new ControlStore(env.CONTROL_DB).upsertRuntimeScore({
      eventId: "evt",
      teamId: "scored",
      points: 5,
    });
    const board = await new ControlStore(env.CONTROL_DB).leaderboard("evt");
    expect(board.map((row) => [row.teamId, row.score])).toEqual([
      ["scored", 5],
      ["zero", 0],
    ]);
  });
});
