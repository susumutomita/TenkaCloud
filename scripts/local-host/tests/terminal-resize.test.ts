import { expect, test } from "bun:test";
import type { TerminalSocket } from "../host-terminal";
import { terminalFixture } from "./terminal-fixture";

async function connection(
  f: Awaited<ReturnType<typeof terminalFixture>>,
  beforeOpen?: () => Promise<void>,
) {
  f.hooks.pty = true;
  f.hooks.beforeOpen = beforeOpen;
  const frames: unknown[] = [];
  let message: (raw: string) => void = (_raw) => {
    throw new Error("Socket was not attached");
  };
  let close: () => void = () => undefined;
  const socket: TerminalSocket = {
    send: (data) => frames.push(JSON.parse(data)),
    close: () => undefined,
    onMessage: (handler) => {
      message = handler;
    },
    onClose: (handler) => {
      close = handler;
    },
  };
  const ticket = await f.ticket();
  const grant = f.service.terminals.redeem("terminal-lab", ticket);
  const attached = f.service.terminals.attach(grant, socket);
  return {
    frames,
    attached,
    ticket,
    close: () => close(),
    send: (data: unknown) => message(JSON.stringify(data)),
  };
}

test("PTY resize is validated, coalesced during spawn, and bound to the current grant", async () => {
  const f = await terminalFixture();
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const a = await connection(f, async () => {
    entered.resolve(undefined);
    await gate.promise;
  });
  try {
    await entered.promise;
    a.send({ type: "resize", cols: 80, rows: 24 });
    a.send({ type: "resize", cols: 120, rows: 40 });
    gate.resolve(undefined);
    await a.attached;
    expect(f.shells[0]?.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(a.frames).toContainEqual({ type: "ready", mode: "pty" });
    a.send({ type: "input", data: "\u0003" });
    expect(f.shells[0]?.writes).toEqual(["\u0003"]);
    f.store.putJob({ ...f.a.job, unit: "replacement" });
    a.send({ type: "resize", cols: 140, rows: 50 });
    expect(f.shells[0]?.resizes).toHaveLength(1);
    expect(f.shells[0]?.kills).toBe(1);
    a.close();
    expect(f.shells[0]?.kills).toBe(1);
    expect(() => f.service.terminals.redeem("terminal-lab", a.ticket)).toThrow();
  } finally {
    gate.resolve(undefined);
    await a.attached;
    await f.close();
  }
});

for (const dimensions of [
  { cols: 0, rows: 24 },
  { cols: 257, rows: 24 },
  { cols: 80, rows: 129 },
  { cols: 80.5, rows: 24 },
  { cols: "80", rows: 24 },
  { cols: null, rows: 24 },
  { cols: 80, rows: 24, service: "another-team" },
])
  test(`invalid resize refuses dimensions/selectors ${JSON.stringify(dimensions)}`, async () => {
    const f = await terminalFixture();
    const a = await connection(f);
    try {
      await a.attached;
      a.send({ type: "resize", ...dimensions });
      expect(f.shells[0]?.resizes).toEqual([]);
      expect(f.shells[0]?.kills).toBe(1);
      expect(a.frames).toContainEqual({ type: "exit", code: null, reason: "invalid_input" });
    } finally {
      await f.close();
    }
  });

test("revocation while spawn is held prevents pending resize/input and reconnect needs a fresh grant", async () => {
  const f = await terminalFixture();
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  const a = await connection(f, async () => {
    entered.resolve(undefined);
    await gate.promise;
  });
  try {
    await entered.promise;
    a.send({ type: "resize", cols: 90, rows: 30 });
    f.store.putTeam({ ...f.a.team, loginKey: "rotated" });
    a.send({ type: "input", data: "must never execute" });
    gate.resolve(undefined);
    await a.attached;
    expect(f.shells).toHaveLength(0);
    expect(a.frames).toContainEqual({ type: "exit", code: null, reason: "not_running" });
  } finally {
    gate.resolve(undefined);
    await a.attached;
    await f.close();
  }
});

test("disconnect retains admission until remote cleanup resolves and shutdown drains it", async () => {
  const f = await terminalFixture();
  const remote = Promise.withResolvers<undefined>();
  f.hooks.closed = remote.promise;
  const a = await connection(f);
  await a.attached;
  a.close();
  expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(1);
  let drained = false;
  const drain = f.service.terminals.closeAll().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  remote.resolve(undefined);
  await drain;
  expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(0);
  await f.close();
});

test("cleanup failure retains admission and shutdown reports failure while closing HTTP", async () => {
  const f = await terminalFixture();
  const remote = Promise.withResolvers<undefined>();
  f.hooks.closed = remote.promise;
  const a = await connection(f);
  await a.attached;
  a.close();
  remote.reject(new Error("synthetic cleanup failure"));
  await expect(f.service.terminals.closeAll()).rejects.toThrow("Terminal cleanup is unconfirmed");
  expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(1);
  await expect(f.close()).rejects.toThrow("Terminal cleanup is unconfirmed");
  await expect(fetch(f.participant.origin)).rejects.toThrow();
});
