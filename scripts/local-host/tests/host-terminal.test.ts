import { expect, test } from "bun:test";
import { terminalFixture } from "./terminal-fixture";

test("terminal tickets are bounded, one-use and scoped to a declared running team problem", async () => {
  const f = await terminalFixture();
  try {
    expect((await f.issue("invalid")).status).toBe(401);
    expect((await f.issue(f.a.team.loginKey, "no-terminal")).status).toBe(404);
    const first = await f.issue();
    expect(first.body.expiresInMs).toBe(30_000);
    const token = first.body.ticket ?? "";
    expect(token).not.toContain(f.a.team.loginKey);
    const grant = f.service.terminals.redeem("terminal-lab", token);
    expect(grant.teamId).toBe(f.a.team.teamId);
    expect(grant.jobId).toBe(f.a.job.jobId);
    expect(() => f.service.terminals.redeem("terminal-lab", token)).toThrow();
    const wrongProblem = await f.ticket();
    expect(() => f.service.terminals.redeem("no-terminal", wrongProblem)).toThrow();
    expect(() => f.service.terminals.redeem("terminal-lab", wrongProblem)).toThrow();
    const expired = await f.ticket();
    f.advance(30_001);
    expect(() => f.service.terminals.redeem("terminal-lab", expired)).toThrow();
    for (let i = 0; i < 8; i += 1) expect((await f.issue()).status).toBe(200);
    expect((await f.issue()).status).toBe(429);
    expect((await f.issue(f.b.team.loginKey)).status).toBe(200);
    expect(() => f.service.terminals.issue(f.request({ body: { service: "grader" } }))).toThrow();
    expect(() =>
      f.service.terminals.issue(
        f.request({ query: new URLSearchParams({ jobId: f.b.job.jobId }) }),
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});

test("terminal ticket redemption rechecks key rotation, event gates and deployment generation", async () => {
  const mutate = [
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putTeam({ ...f.a.team, loginKey: "rotated" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putEvent({ ...f.event, status: "ENDED" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putEvent({ ...f.event, scoringLocked: true }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putJob({ ...f.a.job, status: "STOPPED" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putJob({ ...f.a.job, unit: "replacement" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putJob({ ...f.a.job, deployedAt: 999 }),
  ];
  for (const update of mutate) {
    const f = await terminalFixture();
    try {
      const ticket = await f.ticket();
      update(f);
      expect(() => f.service.terminals.redeem("terminal-lab", ticket)).toThrow();
      expect(f.shells).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
});

test("host terminal capability is explicit and does not restore lifecycle controls", async () => {
  const f = await terminalFixture();
  try {
    const read = async () =>
      (
        await fetch(`${f.participant.origin}/api/portal/me`, {
          headers: { authorization: `Bearer ${f.a.team.loginKey}` },
        })
      ).json() as Promise<{
        problems: { problemId: string; terminal?: true; lifecycle?: unknown }[];
      }>;
    const view = await read();
    expect(view.problems.find((problem) => problem.problemId === "terminal-lab")?.terminal).toBe(
      true,
    );
    expect(view.problems.every((problem) => problem.lifecycle === undefined)).toBe(true);
    expect(
      view.problems.find((problem) => problem.problemId === "no-terminal")?.terminal,
    ).toBeUndefined();
    f.store.putEvent({ ...f.event, scoringLocked: true });
    expect((await read()).problems.every((problem) => problem.terminal === undefined)).toBe(true);
  } finally {
    await f.close();
  }
});
