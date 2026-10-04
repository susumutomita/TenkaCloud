import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { randomToken } from "../auth";
import { resetLocalOrganizerKey, stopManagedLocal } from "../local";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sessionFile = "local-session.json";
const eventSchema = z.object({
  eventId: z.string(),
  teams: z.array(z.object({ teamId: z.string(), teamLoginKey: z.string() })),
});
const projectionSchema = z.object({
  projection: z.object({
    ready: z.object({ count: z.number(), total: z.number(), me: z.boolean() }),
    vault: z.unknown(),
    myContracts: z.array(z.object({ id: z.string(), allowedMethods: z.array(z.string()) })),
  }),
});
const boardSchema = z.object({
  entries: z.array(z.object({ teamId: z.string(), rank: z.number(), score: z.number() })),
});

function launch(target: string, args: string, interactive = false) {
  // Keep private PTY output only in memory; failure diagnostics must never contain keys.
  let terminalOutput = "";
  const child = Bun.spawn(["make", target, `LOCAL_ARGS=${args}`], {
    cwd: root,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
    ...(interactive
      ? {
          terminal: {
            data(_terminal: Bun.Terminal, bytes: Uint8Array) {
              terminalOutput += new TextDecoder().decode(bytes);
            },
          },
        }
      : {}),
  });
  const output = (
    interactive
      ? child.exited.then(() => terminalOutput)
      : Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
          (chunks) => chunks.join("\n"),
        )
  ).then((value) =>
    value
      .replace(/Host login key: .*/gu, "Host login key: [redacted]")
      .replace(/Organizer key \(shown once\): .*/gu, "Organizer key (shown once): [redacted]"),
  );
  return {
    child,
    output,
    organizerKey: () =>
      /Organizer key \(shown once\): ([A-Za-z0-9_-]{43})/u.exec(terminalOutput)?.[1],
    keyDisplays: () => [...terminalOutput.matchAll(/Organizer key \(shown once\):/gu)].length,
  };
}

async function command(target: string, args: string) {
  const run = launch(target, args);
  const code = await run.child.exited;
  return { code, output: await run.output };
}

async function waitUntil(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(25);
  }
  throw new Error("Local process did not reach the expected state within ten seconds.");
}

async function api(origin: string, path: string, token = "", method = "GET", body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function temporary() {
  return mkdtempSync(join(tmpdir(), "tenka-local-process-"));
}

test("make local/down preserves a real scored Battle and refuses duplicate owners", async () => {
  const data = temporary();
  const one = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const two = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const admin = `http://127.0.0.1:${String(one.port)}`;
  const participant = `http://127.0.0.1:${String(two.port)}`;
  const args = `--no-build --data ${data} --admin-port ${String(one.port)} --participant-port ${String(two.port)} --gateway-ports 61000-61039`;
  await one.stop(true);
  await two.stop(true);
  let running: ReturnType<typeof launch> | undefined;
  async function start(interactive = false) {
    running = launch("local", args, interactive);
    await waitUntil(async () => {
      if (running?.child.exitCode !== null)
        throw new Error(`Local startup exited: ${await running?.output}`);
      if (interactive && !running.organizerKey()) return false;
      return fetch(`${admin}/api/host/bootstrap-status`).then(
        (response) => response.ok,
        () => false,
      );
    });
  }
  async function down() {
    const result = await command("down", args);
    expect(result.output).toContain("Event data and stopped Docker runtime data are retained");
    expect(result.code).toBe(0);
    expect(await running?.child.exited).toBe(0);
    running?.child.terminal?.close();
    expect(existsSync(join(data, sessionFile))).toBe(false);
    running = undefined;
  }
  try {
    await start(true);
    const signingKey = readFileSync(join(data, "host-key"), "utf8").trim();
    let key = running?.organizerKey();
    if (!key) throw new Error("Interactive startup did not display an organizer key.");
    expect(running?.keyDisplays()).toBe(1);
    const bootstrap = await api(admin, "/host/login", "", "POST", { key });
    expect(bootstrap.status).toBe(200);
    const token = z.object({ idToken: z.string() }).parse(bootstrap.body).idToken;
    const copied = temporary();
    try {
      cpSync(data, copied, { recursive: true });
      const copyBefore = readFileSync(join(copied, "hosting.sqlite"));
      const refusedReset = await resetLocalOrganizerKey(copied).then(
        () => false,
        () => true,
      );
      expect(refusedReset).toBe(true);
      const refusedDown = await stopManagedLocal(copied).then(
        () => false,
        () => true,
      );
      expect(refusedDown).toBe(true);
      expect(readFileSync(join(copied, "hosting.sqlite")).equals(copyBefore)).toBe(true);
      expect((await api(admin, "/host/me", token)).status).toBe(200);
      expect((await api(admin, "/host/login", "", "POST", { key })).status).toBe(200);
    } finally {
      rmSync(copied, { recursive: true, force: true });
    }
    const redirectedReset = await command("local-reset", args);
    expect(redirectedReset.code).not.toBe(0);
    expect(redirectedReset.output).toContain("interactive terminal");
    expect(redirectedReset.output.includes(key)).toBe(false);
    expect((await api(admin, "/host/login", "", "POST", { key })).status).toBe(200);
    const initialSession = readFileSync(join(data, sessionFile), "utf8");
    const duplicate = await command("local", args);
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.output).toContain("local controller lock");
    expect(readFileSync(join(data, sessionFile), "utf8") === initialSession).toBe(true);
    const session = z.object({ port: z.number() }).parse(JSON.parse(initialSession));
    expect(
      (await fetch(`http://127.0.0.1:${String(session.port)}/down`, { method: "POST" })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${String(session.port)}/reset-organizer-key`, {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect((await api(admin, "/host/bootstrap-status")).status).toBe(200);

    const created = await api(admin, "/events", token, "POST", {
      name: "Native process retention rehearsal",
      teams: [{ internalSlug: "alpha" }, { internalSlug: "beta" }],
      problems: [{ problemId: "ac26-crypto-battle" }],
    });
    expect(created.status).toBe(201);
    const event = eventSchema.parse(created.body);
    expect((await api(admin, `/events/${event.eventId}/deploy`, token, "POST", {})).status).toBe(
      202,
    );
    await waitUntil(
      async () =>
        z
          .object({ status: z.string() })
          .parse((await api(admin, `/events/${event.eventId}`, token)).body).status === "READY",
    );
    expect(
      (await api(admin, `/events/${event.eventId}/schedule`, token, "PATCH", { startNow: true }))
        .status,
    ).toBe(200);
    for (const team of event.teams)
      expect(
        (
          await api(participant, "/portal/me/coordination/op", team.teamLoginKey, "POST", {
            op: { kind: "ready" },
          })
        ).status,
      ).toBe(200);
    const team = event.teams[0];
    if (!team) throw new Error("The two-team event returned no participant.");
    const before = projectionSchema.parse(
      (await api(participant, "/portal/me/coordination/projection", team.teamLoginKey)).body,
    ).projection;
    const order = before.myContracts.find((item) => item.allowedMethods.includes("leak"));
    if (!order) throw new Error("Native Battle did not issue a LEAK order.");
    expect(
      (
        await api(participant, "/portal/me/coordination/op", team.teamLoginKey, "POST", {
          op: { kind: "leak", contractId: order.id },
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(admin, `/events/${event.eventId}/lock-scoring`, token, "POST", {})).status,
    ).toBe(200);
    const leaderboard = boardSchema.parse(
      (await api(participant, "/portal/leaderboard", team.teamLoginKey)).body,
    );
    expect(leaderboard.entries[0]?.teamId).toBe(team.teamId);
    expect(leaderboard.entries[0]?.score).toBeGreaterThan(0);
    const saved = projectionSchema.parse(
      (await api(participant, "/portal/me/coordination/projection", team.teamLoginKey)).body,
    ).projection;
    const oldKey = key;
    key = await resetLocalOrganizerKey(data);
    expect(key === oldKey).toBe(false);
    expect((await api(admin, "/host/login", "", "POST", { key: oldKey })).status).toBe(401);
    expect((await api(admin, `/events/${event.eventId}`, token)).status).toBe(401);
    expect((await api(admin, "/host/login", "", "POST", { key })).status).toBe(200);
    expect(
      boardSchema.parse((await api(participant, "/portal/leaderboard", team.teamLoginKey)).body),
    ).toEqual(leaderboard);
    expect(existsSync(join(data, sessionFile))).toBe(true);
    await down();
    expect(readFileSync(join(data, "host-key"), "utf8").trim() === signingKey).toBe(true);
    const database = new Database(join(data, "hosting.sqlite"), { readonly: true });
    try {
      expect(database.query("SELECT id FROM host_events").all()).toHaveLength(1);
      expect(database.query("SELECT id FROM host_teams").all()).toHaveLength(2);
    } finally {
      database.close();
    }
    await start();
    expect((await api(admin, "/host/bootstrap-status")).body).toEqual({
      bootstrapCompleted: true,
      authMode: "host-key",
    });
    const login = await api(admin, "/host/login", "", "POST", { key });
    expect(login.status).toBe(200);
    const restored = projectionSchema.parse(
      (await api(participant, "/portal/me/coordination/projection", team.teamLoginKey)).body,
    ).projection;
    expect(restored.ready).toEqual(saved.ready);
    expect(restored.vault).toEqual(saved.vault);
    expect(
      boardSchema.parse((await api(participant, "/portal/leaderboard", team.teamLoginKey)).body),
    ).toEqual(leaderboard);
    expect(readFileSync(join(data, "host-key"), "utf8").trim() === signingKey).toBe(true);
    await down();
    await start(true);
    const startupKey = running?.organizerKey();
    if (!startupKey) throw new Error("Interactive restart did not display an organizer key.");
    expect(running?.keyDisplays()).toBe(1);
    expect(startupKey === key).toBe(false);
    expect((await api(admin, "/host/login", "", "POST", { key })).status).toBe(401);
    const priorSession = z.object({ idToken: z.string() }).parse(login.body).idToken;
    expect((await api(admin, "/host/me", priorSession)).status).toBe(401);
    const currentLogin = await api(admin, "/host/login", "", "POST", { key: startupKey });
    expect(currentLogin.status).toBe(200);
    const currentSession = z.object({ idToken: z.string() }).parse(currentLogin.body).idToken;
    const interactiveReset = launch("local-reset", args, true);
    try {
      expect(await interactiveReset.child.exited).toBe(0);
      const rotatedKey = interactiveReset.organizerKey();
      if (!rotatedKey) throw new Error("Live reset did not display an organizer key.");
      expect(interactiveReset.keyDisplays()).toBe(1);
      expect(rotatedKey === startupKey).toBe(false);
      expect((await api(admin, "/host/login", "", "POST", { key: startupKey })).status).toBe(401);
      expect((await api(admin, "/host/me", currentSession)).status).toBe(401);
      expect((await api(admin, "/host/login", "", "POST", { key: rotatedKey })).status).toBe(200);
      key = rotatedKey;
    } finally {
      interactiveReset.child.terminal?.close();
    }
    expect(
      boardSchema.parse((await api(participant, "/portal/leaderboard", team.teamLoginKey)).body),
    ).toEqual(leaderboard);
    expect(
      projectionSchema.parse(
        (await api(participant, "/portal/me/coordination/projection", team.teamLoginKey)).body,
      ).projection.vault,
    ).toEqual(saved.vault);
    expect(readFileSync(join(data, "host-key"), "utf8").trim() === signingKey).toBe(true);
    await down();
    const recoveredKey = await resetLocalOrganizerKey(data);
    expect(recoveredKey === key).toBe(false);
    await start();
    expect((await api(admin, "/host/login", "", "POST", { key })).status).toBe(401);
    expect((await api(admin, "/host/login", "", "POST", { key: recoveredKey })).status).toBe(200);
    expect(
      boardSchema.parse((await api(participant, "/portal/leaderboard", team.teamLoginKey)).body),
    ).toEqual(leaderboard);
    await down();
    expect((await command("down", args)).output).toContain("No managed local host is running");
    const clear = await command("local-clear", `--data ${data} --yes`);
    expect(clear.code).toBe(0);
    expect(clear.output).toContain("Local event history and owned Docker work data cleared");
    expect(clear.output.includes(recoveredKey)).toBe(false);
    expect(clear.output.includes(team.teamLoginKey)).toBe(false);
    await start();
    expect((await api(admin, "/host/login", "", "POST", { key: recoveredKey })).status).toBe(200);
    expect((await api(participant, "/portal/leaderboard", team.teamLoginKey)).status).toBe(401);
    expect(readFileSync(join(data, "host-key"), "utf8").trim() === signingKey).toBe(true);
    await down();
    const cleared = new Database(join(data, "hosting.sqlite"), { readonly: true });
    try {
      expect(cleared.query("SELECT id FROM host_events").all()).toEqual([]);
      expect(cleared.query("SELECT id FROM host_teams").all()).toEqual([]);
    } finally {
      cleared.close();
    }
  } finally {
    if (running) await command("down", args);
    running?.child.terminal?.close();
    rmSync(data, { recursive: true, force: true });
  }
}, 30_000);

test("down never signals an unrelated live PID or accepts a different controller session", async () => {
  const data = temporary();
  const sentinel = join(data, "retained-data");
  writeFileSync(sentinel, "keep");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ sessionId: randomToken(), code: 0 }),
  });
  const session = {
    protocol: 2,
    pid: process.pid,
    port: server.port,
    token: randomToken(),
    sessionId: randomToken(),
  };
  writeFileSync(join(data, sessionFile), JSON.stringify(session), { mode: 0o600 });
  try {
    await expect(stopManagedLocal(data)).rejects.toThrow("no PID was signalled");
    expect(process.kill(process.pid, 0)).toBe(true);
    expect(readFileSync(join(data, sessionFile), "utf8") === JSON.stringify(session)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    await server.stop(true);
    rmSync(data, { recursive: true, force: true });
  }
});

test("down removes dead-owner metadata without touching retained data", async () => {
  const data = temporary();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  const sentinel = join(data, "retained-data");
  writeFileSync(sentinel, "keep");
  writeFileSync(
    join(data, sessionFile),
    JSON.stringify({ pid: child.pid, port: 65530, token: randomToken(), sessionId: randomToken() }),
    { mode: 0o600 },
  );
  try {
    await stopManagedLocal(data);
    expect(existsSync(join(data, sessionFile))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("key recovery rejects absent or unrelated state without creating host records", async () => {
  const data = temporary();
  const path = join(data, "hosting.sqlite");
  try {
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("No existing local host database");
    expect(existsSync(join(data, "local-launcher.sqlite"))).toBe(false);
    const unrelated = new Database(path);
    unrelated.run("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retain');");
    unrelated.close();
    const before = readFileSync(path);
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("not an existing TenkaCloud");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(join(data, "local-launcher.sqlite"))).toBe(false);
    expect(existsSync(join(data, "host-key"))).toBe(false);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("legacy controllers are refused before sending a reset or shutdown request", async () => {
  const data = temporary();
  const database = new Database(join(data, "hosting.sqlite"));
  database.run("CREATE TABLE host_schema(version INTEGER); INSERT INTO host_schema VALUES (5);");
  database.close();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json({});
    },
  });
  writeFileSync(
    join(data, sessionFile),
    JSON.stringify({
      pid: process.pid,
      port: server.port,
      token: randomToken(),
      sessionId: randomToken(),
    }),
    { mode: 0o600 },
  );
  try {
    await expect(resetLocalOrganizerKey(data)).rejects.toThrow("original terminal");
    await expect(stopManagedLocal(data)).rejects.toThrow("original terminal");
    expect(requests).toBe(0);
  } finally {
    await server.stop(true);
    rmSync(data, { recursive: true, force: true });
  }
});
