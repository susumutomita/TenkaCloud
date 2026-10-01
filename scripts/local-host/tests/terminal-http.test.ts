import { expect, test } from "bun:test";
import { WebSocket } from "ws";
import { terminalFixture } from "./terminal-fixture";

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Terminal condition timed out.");
    await Bun.sleep(5);
  }
}

async function connect(
  origin: string,
  ticket: string,
  requestOrigin: string | null = origin,
  problemId = "terminal-lab",
) {
  const url = `${origin.replace(/^http/u, "ws")}/api/portal/me/problems/${problemId}/terminal?ticket=${ticket}`;
  const socket = new WebSocket(url, {
    handshakeTimeout: 1000,
    ...(requestOrigin === null ? {} : { headers: { origin: requestOrigin } }),
  });
  const frames: { type: string; data?: string; code?: number | null; reason?: string }[] = [];
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket handshake timed out"));
    }, 1000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket handshake rejected"));
    });
  });
  return { socket, frames, closed };
}

test("real terminal WebSocket carries large input and refuses origin, admin and replay attempts", async () => {
  const f = await terminalFixture();
  try {
    const ticket = await f.ticket();
    await expect(connect(f.participant.origin, ticket, "http://other.example")).rejects.toThrow();
    await expect(connect(f.participant.origin, ticket, null)).rejects.toThrow();
    await expect(connect(f.admin.origin, ticket)).rejects.toThrow();
    const a = await connect(f.participant.origin, ticket);
    await waitUntil(() => f.shells.length === 1);
    const paste = `${"x".repeat(256 * 1024)}\n`;
    a.socket.send(JSON.stringify({ type: "input", data: paste }));
    await waitUntil(
      () => a.frames.map((frame) => frame.data ?? "").join("").length === paste.length,
    );
    expect(a.frames.map((frame) => frame.data ?? "").join("")).toBe(paste);
    expect(f.shells[0]?.job.teamId).toBe(f.a.team.teamId);
    expect(f.shells[0]?.writes).toEqual([paste]);
    await expect(connect(f.participant.origin, ticket)).rejects.toThrow();
    a.socket.close();
    await a.closed;
    await waitUntil(() => f.shells[0]?.kills === 1);
    expect(f.shells[0]?.kills).toBe(1);
  } finally {
    await f.close();
  }
});

test("terminal sessions revoke without client input and leave another team connected", async () => {
  const f = await terminalFixture();
  try {
    const a = await connect(f.participant.origin, await f.ticket());
    const b = await connect(f.participant.origin, await f.ticket(f.b.team.loginKey));
    await waitUntil(() => f.shells.length === 2);
    f.store.putTeam({ ...f.a.team, loginKey: "rotated-key" });
    await a.closed;
    await waitUntil(() => f.shells[0]?.kills === 1);
    expect(f.shells[0]?.kills).toBe(1);
    expect(f.shells[1]?.kills).toBe(0);
    b.socket.send(JSON.stringify({ type: "input", data: "still beta\n" }));
    await waitUntil(() => b.frames.some((frame) => frame.data === "still beta\n"));
    expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(0);
    expect(f.service.terminals.countFor(f.b.job.jobId)).toBe(1);
  } finally {
    await f.close();
  }
});

test("terminal timer closes idle sessions after event stop, lock, expiry or replacement", async () => {
  const mutations = [
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putEvent({ ...f.event, status: "ENDED" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putEvent({ ...f.event, scoringLocked: true }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putJob({ ...f.a.job, status: "STOPPED" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) =>
      f.store.putJob({ ...f.a.job, unit: "replacement" }),
    (f: Awaited<ReturnType<typeof terminalFixture>>) => f.advance(5 * 60_000 + 1),
  ];
  for (const update of mutations) {
    const f = await terminalFixture();
    try {
      const client = await connect(f.participant.origin, await f.ticket());
      await waitUntil(() => f.shells.length === 1);
      update(f);
      await client.closed;
      expect(f.shells[0]?.kills).toBe(1);
      expect(client.frames.some((frame) => frame.type === "exit")).toBe(true);
    } finally {
      await f.close();
    }
  }
}, 10_000);

test("terminal bounds sessions and malformed frames, and shutdown closes open sockets", async () => {
  const f = await terminalFixture();
  try {
    const clients = [];
    for (let i = 0; i < 5; i += 1)
      clients.push(await connect(f.participant.origin, await f.ticket()));
    await clients[4]?.closed;
    expect(clients[4]?.frames).toContainEqual({
      type: "exit",
      code: null,
      reason: "too_many_sessions",
    });
    expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(4);
    clients[0]?.socket.send("invalid JSON");
    await clients[0]?.closed;
    expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(3);
    clients[1]?.socket.send(Buffer.from("binary input"));
    await clients[1]?.closed;
    expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(2);
    clients[2]?.socket.send("x".repeat(1024 * 1024 + 1));
    await clients[2]?.closed;
    expect(f.service.terminals.countFor(f.a.job.jobId)).toBe(1);
    await f.close();
    await clients[3]?.closed;
    expect(f.shells.every((shell) => shell.kills === 1)).toBe(true);
  } finally {
    await f.close();
  }
});

test("input waits for bounded shell validation, and revocation during validation prevents spawn", async () => {
  const f = await terminalFixture();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  f.hooks.beforeOpen = async () => {
    entered.resolve(true);
    await release.promise;
  };
  try {
    const client = await connect(f.participant.origin, await f.ticket());
    await entered.promise;
    client.socket.send(JSON.stringify({ type: "input", data: "queued input\n" }));
    await Bun.sleep(10);
    expect(f.shells).toHaveLength(0);
    release.resolve(true);
    await waitUntil(() => client.frames.some((frame) => frame.data === "queued input\n"));
    expect(f.shells[0]?.writes).toEqual(["queued input\n"]);
  } finally {
    release.resolve(true);
    await f.close();
  }

  const revoked = await terminalFixture();
  const began = Promise.withResolvers<boolean>();
  const finish = Promise.withResolvers<boolean>();
  revoked.hooks.beforeOpen = async () => {
    began.resolve(true);
    await finish.promise;
  };
  try {
    const client = await connect(revoked.participant.origin, await revoked.ticket());
    await began.promise;
    revoked.store.putJob({ ...revoked.a.job, deployedAt: 999 });
    finish.resolve(true);
    await client.closed;
    expect(revoked.shells).toHaveLength(0);
  } finally {
    finish.resolve(true);
    await revoked.close();
  }
});
