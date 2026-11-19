import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { localCompetitionEngine } from "../application";
import { startManagedSimulator } from "../managed-simulator";
import { parseOptions } from "../options";
import { startLocalHost } from "../server";
import { connectSimulatorHosting } from "../simulator-hosting";

/**
 * Opt-in rehearsal: the unchanged `hello-world-battle` through this host's real HTTP APIs on a
 * real Simulator Battle VM runtime (managed startup with --battle-bundle, native bootstrap,
 * deployment, participant registration, scoring, the catalog disruption, participant recovery
 * through the guest terminal, teardown). No real AWS endpoint is contacted.
 *
 *   bun run test:simulator-battle --simulator-binary /abs/tenkacloud-simulator --battle-bundle /abs/bundle
 *
 * It takes about 10 minutes under QEMU TCG and waits for real scoring minutes.
 */
const MINUTE = 60_000;
const log = (message: string) => console.log(`[battle ${new Date().toISOString()}] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A currently free loopback port (the host requires explicit ports from 1024). */
async function freePort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert(address && typeof address === "object");
  return String(address.port);
}

async function http(origin: string, path: string, token: string, method = "GET", body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : undefined;
}

async function until<T>(label: string, timeoutMs: number, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    assert(Date.now() < deadline, `Timed out waiting for ${label}.`);
    await sleep(5_000);
  }
}

/** The Simulator's participant terminal, driven the way its browser page does. */
class GuestTerminal {
  private socket?: Socket;
  private sessionId?: string;
  private buffer = Buffer.alloc(0);
  private output = "";
  private constructor(
    private readonly origin: string,
    private readonly cookie: string,
  ) {}

  static async redeem(terminalUrl: string, code: string): Promise<GuestTerminal> {
    const origin = new URL(terminalUrl).origin;
    const response = await fetch(`${origin}/_simulator/terminal-redeem`, {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Code: code }).toString(),
    });
    const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    assert(response.status === 303 && cookie.includes("="), "Terminal code was not accepted.");
    return new GuestTerminal(origin, cookie);
  }

  private async control(action: string, value: unknown) {
    const response = await fetch(`${this.origin}/_simulator/v1/terminal-control`, {
      method: "POST",
      headers: {
        cookie: this.cookie,
        origin: this.origin,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AmazonSSM.${action}`,
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(60_000),
    });
    assert(response.ok, `${action} failed: ${response.status}`);
    return response.json() as Promise<Record<string, string>>;
  }

  async start(): Promise<void> {
    const context = z.object({ Target: z.string() }).parse(
      await (
        await fetch(`${this.origin}/_simulator/v1/terminal-context`, {
          headers: { cookie: this.cookie },
        })
      ).json(),
    );
    const started = await this.control("StartSession", { Target: context.Target });
    this.sessionId = started.SessionId;
    const url = new URL(this.origin);
    const socket = connect(Number(url.port), url.hostname);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve).once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
      `GET /_simulator/v1/terminal-channel/${started.SessionId} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${this.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nCookie: ${this.cookie}\r\n\r\n`,
    );
    await until("terminal upgrade", 30_000, async () => {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return undefined;
      assert(this.buffer.subarray(0, end).toString().includes(" 101 "), "Upgrade refused.");
      this.buffer = this.buffer.subarray(end + 4);
      return true;
    });
    this.send({ type: "open", token: started.TokenValue });
    const ready = await this.next(30_000);
    assert(ready?.type === "ready", "Guest terminal did not become ready.");
  }

  private send(value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    const mask = randomBytes(4);
    const header =
      data.length < 126
        ? Buffer.from([0x81, 0x80 | data.length])
        : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 0xff]);
    const masked = Buffer.from(data.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
    this.socket?.write(Buffer.concat([header, mask, masked]));
  }

  /** One complete unfragmented frame from the buffer, or undefined until it has arrived. */
  private takeFrame(): { op: number; data: Buffer } | undefined {
    if (this.buffer.length < 2) return undefined;
    const op = (this.buffer[0] ?? 0) & 15;
    let size = (this.buffer[1] ?? 0) & 127;
    let offset = 2;
    if (size === 126) {
      if (this.buffer.length < 4) return undefined;
      size = this.buffer.readUInt16BE(2);
      offset = 4;
    }
    if (this.buffer.length < offset + size) return undefined;
    const data = this.buffer.subarray(offset, offset + size);
    this.buffer = this.buffer.subarray(offset + size);
    return { op, data };
  }

  private async next(timeoutMs: number): Promise<Record<string, string> | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.takeFrame();
      if (frame?.op === 1) return JSON.parse(frame.data.toString()) as Record<string, string>;
      if (frame?.op === 8) throw new Error("Guest terminal closed.");
      if (frame?.op === 9) {
        // Answer liveness pings as a browser does.
        const mask = randomBytes(4);
        const masked = Buffer.from(frame.data.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
        this.socket?.write(
          Buffer.concat([Buffer.from([0x8a, 0x80 | frame.data.length]), mask, masked]),
        );
      }
      if (frame) continue;
      if (Date.now() >= deadline) return undefined;
      await sleep(50);
    }
  }

  async run(command: string, timeoutMs = 120_000): Promise<{ code: number; text: string }> {
    const marker = `TCDONE${randomBytes(4).toString("hex")}`;
    const begin = this.output.length;
    this.send({
      type: "input",
      data: Buffer.from(`${command}; echo ${marker}:$?:\n`).toString("base64"),
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = new RegExp(`${marker}:(\\d+):`, "u").exec(this.output.slice(begin));
      if (match) return { code: Number(match[1]), text: this.output.slice(begin) };
      assert(Date.now() < deadline, `Terminal command timed out: ${command}`);
      const message = await this.next(5_000);
      if (message?.type === "output")
        this.output += Buffer.from(message.data ?? "", "base64").toString();
    }
  }

  /** End the session as the terminal page's sign-out does; a dropped socket leaves it retained. */
  async close(): Promise<void> {
    try {
      if (this.sessionId) await this.control("TerminateSession", { SessionId: this.sessionId });
    } finally {
      this.socket?.destroy();
    }
  }
}

export async function runSimulatorBattle(options: { binary: string; bundle: string }) {
  const root = realpathSync(join(import.meta.dirname, "../../.."));
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates a unique owner-only directory.
  const temp = realpathSync(mkdtempSync("/tmp/tc-battle-acceptance-"));
  const data = join(temp, "host");
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const simulator = await startManagedSimulator({
    binary: options.binary,
    dataDirectory: data,
    battleBundle: options.bundle,
  });
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  let clean = false;
  try {
    log(`Simulator ready at ${simulator.settings.endpoint}`);
    const settings = parseOptions(
      [
        "--data",
        data,
        "--no-build",
        "--no-simulator",
        "--admin-port",
        await freePort(),
        "--participant-port",
        await freePort(),
      ],
      root,
    );
    const connection = await connectSimulatorHosting(root, data, simulator.settings);
    assert(connection, "Simulator connection failed.");
    host = await startLocalHost(
      root,
      { ...settings, accountConnection: connection },
      (directory, store) =>
        localCompetitionEngine(
          root,
          directory,
          settings,
          { available: false },
          connection.engine((job) => store.team(job.teamId)),
        ),
      () => undefined,
    );
    const admin = host.admin.origin;
    const portal = host.participant.origin;
    assert(host.organizerKey, "Organizer key is missing.");
    const token = z.object({ idToken: z.string() }).parse(
      await (
        await fetch(`${admin}/api/host/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: host.organizerKey }),
        })
      ).json(),
    ).idToken;
    await http(admin, "/admin/competitor-accounts", token, "POST", {
      awsAccountId: "000000000000",
      competitorRoleName: "TenkaCloud-SimulatorDeploy-Role",
    });
    await http(admin, "/admin/competitor-accounts/000000000000/verify", token, "POST");
    const catalog = z
      .object({ items: z.array(z.object({ problemId: z.string() })) })
      .parse(await http(admin, "/host/catalog", token));
    assert(catalog.items.some((item) => item.problemId === "hello-world-battle"));
    const event = z
      .object({ eventId: z.string(), teams: z.array(z.object({ teamLoginKey: z.string() })) })
      .parse(
        await http(admin, "/events", token, "POST", {
          name: "Simulator Hello World Battle acceptance",
          teams: [{ internalSlug: "alpha", awsAccountId: "000000000000" }],
          problems: [{ problemId: "hello-world-battle" }],
        }),
      );
    const team = event.teams[0]?.teamLoginKey ?? "";
    const deployStarted = Date.now();
    await http(admin, `/events/${event.eventId}/deploy`, token, "POST", {});
    await until("deployment", 20 * MINUTE, async () => {
      const detail = z
        .object({
          deploymentsByProblem: z.record(
            z.string(),
            z.array(z.object({ jobId: z.string(), status: z.string() })),
          ),
        })
        .parse(await http(admin, `/events/${event.eventId}`, token));
      const job = detail.deploymentsByProblem["hello-world-battle"]?.[0];
      assert(job?.status !== "FAILED", "Deployment failed.");
      return job?.status === "COMPLETE" ? job : undefined;
    });
    report.deploySeconds = Math.round((Date.now() - deployStarted) / 1000);
    log(`Deployed in ${String(report.deploySeconds)} s`);
    await http(admin, `/events/${event.eventId}/schedule`, token, "PATCH", { startNow: true });
    const viewSchema = z.object({
      problems: z.array(
        z.object({
          jobId: z.string(),
          problemId: z.string(),
          score: z.number(),
          stackOutputs: z.record(z.string(), z.string()),
          accessCapabilities: z.array(z.string()).optional(),
        }),
      ),
    });
    const problem = async () => {
      const view = viewSchema.parse(await http(portal, "/portal/me", team));
      const found = view.problems.find((entry) => entry.problemId === "hello-world-battle");
      assert(found, "Battle is missing from the participant view.");
      return found;
    };
    const initial = await problem();
    assert.deepEqual(initial.accessCapabilities, ["guest-terminal", "cli-credentials"]);
    const hint = initial.stackOutputs.Ec2HostHint ?? "";
    assert.match(hint, /\.simulator\.invalid$/u);
    for (const [slot, url] of [
      ["frontend", `http://${hint}`],
      ["api", `http://${hint}:8080`],
    ] as const)
      await http(portal, `/portal/me/problems/hello-world-battle/endpoints/${slot}`, team, "POST", {
        url,
      });
    log("Participant registered both endpoints; waiting for the guest and the first scored minute");
    const firstPoints = await until("first uptime points", 15 * MINUTE, async () => {
      const current = await problem();
      return current.score > 0 ? current.score : undefined;
    });
    report.firstScore = firstPoints;
    log(`Score ${String(firstPoints)} after the first healthy minute`);
    await http(admin, `/events/${event.eventId}/disruptions/fire`, token, "POST", {
      disruptionId: "frontend-down",
      problemId: "hello-world-battle",
      scope: "all",
      requestId: randomUUID(),
    });
    const afterDisruption = await until("disruption penalty", 5 * MINUTE, async () => {
      const current = await problem();
      return current.score < firstPoints ? current.score : undefined;
    });
    report.afterDisruption = afterDisruption;
    log(`Score ${String(afterDisruption)} after the frontend-down disruption`);
    const handoff = z
      .object({ code: z.string(), terminalUrl: z.string(), expiresAt: z.string() })
      .parse(await http(portal, `/portal/me/guest-terminal?jobId=${initial.jobId}`, team));
    const terminal = await GuestTerminal.redeem(handoff.terminalUrl, handoff.code);
    try {
      await terminal.start();
      const recovered = await terminal.run(
        "systemctl is-active nginx; sudo systemctl start nginx && systemctl is-active nginx",
      );
      assert.equal(recovered.code, 0, `Recovery failed: ${recovered.text.slice(-300)}`);
    } finally {
      await terminal.close();
    }
    log("Participant restarted nginx through the guest terminal");
    const afterRecovery = await until("recovery points", 5 * MINUTE, async () => {
      const current = await problem();
      return current.score > afterDisruption ? current.score : undefined;
    });
    report.afterRecovery = afterRecovery;
    log(`Score ${String(afterRecovery)} after recovery`);
    await http(admin, `/events/${event.eventId}`, token, "DELETE");
    await until("teardown", 5 * MINUTE, async () => {
      const detail = z
        .object({ teardownStatus: z.string().optional() })
        .parse(await http(admin, `/events/${event.eventId}`, token));
      return detail.teardownStatus === "complete" ? true : undefined;
    });
    log("Torn down");
    clean = true;
  } finally {
    await host?.stop();
    await simulator.stop();
    const exit = await simulator.exited;
    report.simulatorExit = exit.code;
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report));
    if (clean && exit.code === 0) rmSync(temp, { recursive: true, force: true });
    else log(`Kept ${temp} for inspection.`);
  }
  assert.equal(report.simulatorExit, 0, "Simulator did not exit cleanly.");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "simulator-binary": { type: "string" },
      "battle-bundle": { type: "string" },
    },
  });
  if (!values["simulator-binary"] || !values["battle-bundle"]) {
    console.error(
      "Usage: bun run test:simulator-battle --simulator-binary /abs/simulator --battle-bundle /abs/bundle",
    );
    process.exit(2);
  }
  await runSimulatorBattle({
    binary: values["simulator-binary"],
    bundle: values["battle-bundle"],
  });
}
