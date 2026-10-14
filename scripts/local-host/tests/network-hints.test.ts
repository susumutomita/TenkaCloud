import { expect, test } from "bun:test";
import { startHttpHost } from "../http";
import { requiredNetworkValue } from "../local-network";
import { HostingService } from "../service";
import { networkEngineFixture } from "./network-engine-fixture";

test("another problem's expired proof cannot block a hint or erase its retained progress", async () => {
  const f = networkEngineFixture();
  const peer = f.add("expired-peer", 0, 1).job;
  f.setNow(61_002);
  const own = f.add("hint-target").job;
  peer.teamId = own.teamId;
  f.store.putJob(peer);
  const context = {
    event: f.store.event("event"),
    team: {
      ...f.store.team(own.teamId),
      snapshot: JSON.stringify({
        version: 1,
        teamName: "team",
        runtimes: {
          [peer.problemId]: {
            solved: [],
            revealedHints: [],
            wrongCounts: [],
            score: 37,
          },
        },
        simulatedRuntimes: {},
        scoreEvents: [],
      }),
    },
    jobs: [peer, own],
    now: 61_002,
  };
  const hint = JSON.parse(own.definition).problem.scoring.hints[0];
  try {
    const result = await f.engine.hint(context, own.problemId, hint.id);
    expect(result.status).toBe(200);
    expect(result.body.content).toBeString();
    expect(JSON.parse(requiredNetworkValue(result.snapshot)).runtimes[peer.problemId].score).toBe(
      37,
    );
    expect(result.score).toBe(37 - hint.penalty);
    context.team.snapshot = requiredNetworkValue(result.snapshot);
    const repeated = await f.engine.hint(context, own.problemId, hint.id);
    expect(repeated.body.kind).toBe("already_revealed");
    expect(repeated.score).toBe(result.score);
    expect(f.engine.terminalSupported(own)).toBe(true);
    expect(f.engine.terminalSupported(peer)).toBe(false);
  } finally {
    await f.close();
  }
});

test("hint and submission to an expired target remain refused", async () => {
  const f = networkEngineFixture();
  const own = f.add("expired-target").job;
  f.setNow(61_002);
  const context = {
    event: f.store.event("event"),
    team: f.store.team(own.teamId),
    jobs: [own],
    now: 61_002,
  };
  try {
    await expect(f.engine.hint(context, own.problemId, "hint-1")).rejects.toThrow(
      "verification expired",
    );
    expect(f.engine.terminalSupported(own)).toBe(false);
    const result = await f.engine.submit(context, { problemId: own.problemId, flag: "anything" });
    expect(result.status).toBe(409);
  } finally {
    await f.close();
  }
});

test("local hint HTTP API retains authentication, progression and repeated-reveal contracts", async () => {
  const f = networkEngineFixture();
  const peer = f.add("http-expired-peer", 0, 1).job;
  f.setNow(61_002);
  const own = f.add("http-hint-target").job;
  const foreignKey = f.store.team(peer.teamId).loginKey;
  peer.teamId = own.teamId;
  f.store.putJob(peer);
  const event = f.store.event("event");
  f.store.putEvent({ ...event, startsAt: new Date(0).toISOString(), expiresAt: 3600 });
  const service = new HostingService(f.store, f.engine, "synthetic-key", () => 61_002);
  const host = await startHttpHost({
    kind: "participant",
    hostname: "127.0.0.1",
    port: 0,
    staticRoot: process.cwd(),
    service,
  });
  const hint = JSON.parse(own.definition).problem.scoring.hints[0];
  const endpoint = `${host.origin}/api/portal/me/problems/${own.problemId}/hints/${hint.id}/reveal`;
  const reveal = (key: string) =>
    fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}` } });
  try {
    expect((await reveal("invalid-key")).status).toBe(401);
    expect((await reveal(foreignKey)).status).toBe(409);
    const key = f.store.team(own.teamId).loginKey;
    const first = await reveal(key);
    expect(first.status).toBe(200);
    expect((await first.json()).kind).toBe("ok");
    const score = f.store.team(own.teamId).score;
    const repeated = await Promise.all([reveal(key), reveal(key)]);
    for (const response of repeated) {
      expect(response.status).toBe(200);
      expect((await response.json()).kind).toBe("already_revealed");
    }
    expect(f.store.team(own.teamId).score).toBe(score);
    f.store.putEvent({ ...f.store.event("event"), scoringLocked: true });
    expect((await reveal(key)).status).toBe(409);
  } finally {
    await host.close();
    await service.drain();
    await f.close();
  }
});

test("local metadata still opens when one problem's network proof expires", async () => {
  const f = networkEngineFixture();
  const peer = f.add("view-expired-peer", 0, 1).job;
  f.setNow(61_002);
  const own = f.add("view-target").job;
  peer.teamId = own.teamId;
  f.store.putJob(peer);
  const context = {
    event: f.store.event("event"),
    team: f.store.team(own.teamId),
    jobs: [peer, own],
    now: 61_002,
  };
  try {
    const view = await f.engine.view(context);
    expect(view.problems).toBeArrayOfSize(2);
    expect(f.engine.terminalSupported(own)).toBe(true);
    expect(f.engine.terminalSupported(peer)).toBe(false);
  } finally {
    await f.close();
  }
});
