import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ENDED_EVENT_RETENTION_MS, reconcileEvents } from "../src/reconcile.js";

const NOW = new Date("2026-07-04T12:00:00.000Z");

async function insertEvent(input: {
  eventId: string;
  status: string;
  startsAt?: string | null;
  endsAt?: string | null;
}): Promise<void> {
  await env.CONTROL_DB.prepare(
    `INSERT INTO events (event_id, tenant_id, name, status, starts_at, ends_at, created_at, updated_at)
     VALUES (?, 'tenant-a', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  )
    .bind(input.eventId, input.eventId, input.status, input.startsAt ?? null, input.endsAt ?? null)
    .run();
}

async function statusOf(eventId: string): Promise<string | null> {
  const row = await env.CONTROL_DB.prepare("SELECT status FROM events WHERE event_id = ?")
    .bind(eventId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(`
    DELETE FROM submissions;
    DELETE FROM score_summary;
    DELETE FROM challenge_checkpoints;
    DELETE FROM teams;
    DELETE FROM events;
  `);
});

describe("reconcileEvents (#2294)", () => {
  it("should activate DRAFT events whose start has passed", async () => {
    await insertEvent({ eventId: "past", status: "DRAFT", startsAt: "2026-07-04T11:00:00.000Z" });
    await insertEvent({ eventId: "future", status: "DRAFT", startsAt: "2026-07-04T13:00:00.000Z" });
    await insertEvent({ eventId: "nostart", status: "DRAFT", startsAt: null });

    const outcome = await reconcileEvents(env.CONTROL_DB, NOW);

    expect(outcome.activated).toBe(1);
    expect(await statusOf("past")).toBe("ACTIVE");
    expect(await statusOf("future")).toBe("DRAFT");
    expect(await statusOf("nostart")).toBe("DRAFT");
  });

  it("should end ACTIVE events whose end has passed", async () => {
    await insertEvent({ eventId: "over", status: "ACTIVE", endsAt: "2026-07-04T11:59:00.000Z" });
    await insertEvent({ eventId: "running", status: "ACTIVE", endsAt: "2026-07-04T13:00:00.000Z" });

    const outcome = await reconcileEvents(env.CONTROL_DB, NOW);

    expect(outcome.ended).toBe(1);
    expect(await statusOf("over")).toBe("ENDED");
    expect(await statusOf("running")).toBe("ACTIVE");
  });

  it("should carry a fully-elapsed DRAFT through to ENDED in one pass", async () => {
    await insertEvent({
      eventId: "elapsed",
      status: "DRAFT",
      startsAt: "2026-07-04T10:00:00.000Z",
      endsAt: "2026-07-04T11:00:00.000Z",
    });

    const outcome = await reconcileEvents(env.CONTROL_DB, NOW);

    expect(outcome.activated).toBe(1);
    expect(outcome.ended).toBe(1);
    expect(await statusOf("elapsed")).toBe("ENDED");
  });

  it("should prune long-ended events and their dependent rows", async () => {
    const longAgo = new Date(NOW.getTime() - ENDED_EVENT_RETENTION_MS - 1000).toISOString();
    await insertEvent({ eventId: "old", status: "ENDED", endsAt: longAgo });
    await env.CONTROL_DB.prepare(
      `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
       VALUES ('t1', 'old', 'tenant-a', 'Team', 'hash', '2026-01-01T00:00:00.000Z')`,
    ).run();
    // A recently-ended event must survive the retention window.
    await insertEvent({
      eventId: "recent",
      status: "ENDED",
      endsAt: "2026-07-04T11:00:00.000Z",
    });

    const outcome = await reconcileEvents(env.CONTROL_DB, NOW);

    expect(outcome.pruned).toBe(1);
    expect(await statusOf("old")).toBeNull();
    expect(await statusOf("recent")).toBe("ENDED");
    const orphanTeam = await env.CONTROL_DB.prepare("SELECT team_id FROM teams WHERE event_id = ?")
      .bind("old")
      .first();
    expect(orphanTeam).toBeNull();
  });

  it("should be a no-op when nothing is due", async () => {
    await insertEvent({ eventId: "future", status: "DRAFT", startsAt: "2026-07-04T13:00:00.000Z" });
    const outcome = await reconcileEvents(env.CONTROL_DB, NOW);
    expect(outcome).toEqual({ activated: 0, ended: 0, pruned: 0 });
  });
});
