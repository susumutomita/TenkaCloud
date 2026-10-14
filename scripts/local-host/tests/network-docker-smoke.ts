/** Execute ONLY inside the explicitly approved, ephemeral, network:none privileged lab.
 * The outer wrapper has no published ports or host bind mounts. Images are loaded
 * offline by the caller. This script never creates that wrapper or changes host settings.
 */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { LocalComposeUnit } from "../container/container-runner";
import { DockerHostingEngine } from "../docker-engine";
import { type HttpHost, startHttpHost } from "../http";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { localNetworkPlan, requiredNetworkValue, segmentGateway } from "../local-network";
import type { HostedEvent, Job, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";

function command(args: string[], input?: string): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixed native tool in the explicitly approved isolated lab
  return execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function execContainer(id: string, script: string): { succeeded: boolean; output: string } {
  try {
    return { succeeded: true, output: command(["exec", id, "/bin/sh", "-c", script]) };
  } catch {
    return { succeeded: false, output: "" };
  }
}
function inspect(job: Job): {
  web: string;
  db: string;
  db4: string;
  db6: string;
  ipv4: string;
  ipv6: string;
  gateway4: string;
  gateway6: string;
} {
  const unit = JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit;
  const ids = command([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${unit.composeProjectName}`,
  ]).split("\n");
  const containers = JSON.parse(command(["inspect", ...ids]));
  for (const container of containers) {
    assert.equal(container.HostConfig.Memory, 128 * 1024 * 1024);
    assert.equal(container.HostConfig.NanoCpus, 500_000_000);
    assert.equal(container.HostConfig.PidsLimit, 128);
  }
  const web = containers.find(
    (container: { Config: { Labels: Record<string, string> } }) =>
      container.Config.Labels["com.docker.compose.service"] === "web",
  );
  const db = containers.find(
    (container: { Config: { Labels: Record<string, string> } }) =>
      container.Config.Labels["com.docker.compose.service"] === "db",
  );
  const network = web.NetworkSettings.Networks[`${unit.composeProjectName}_default`];
  const plan = localNetworkPlan(unit.composeProjectName, requiredNetworkValue(unit.networkSubnets));
  const segment = requiredNetworkValue(plan.segments[0]);
  return {
    web: web.Id,
    db: db.Id,
    db4: db.NetworkSettings.Networks[`${unit.composeProjectName}_default`].IPAddress,
    db6: db.NetworkSettings.Networks[`${unit.composeProjectName}_default`].GlobalIPv6Address,
    ipv4: network.IPAddress,
    ipv6: network.GlobalIPv6Address,
    gateway4: segmentGateway(segment, false),
    gateway6: segmentGateway(segment, true),
  };
}
async function terminal(portal: HttpHost, team: Team): Promise<WebSocket> {
  const response = await fetch(
    `${portal.origin}/api/portal/me/problems/network-fixture/terminal-handoff`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${team.loginKey}` },
    },
  );
  assert.equal(response.status, 200);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new WebSocket(
    `${portal.origin.replace("http:", "ws:")}/api/portal/me/problems/network-fixture/terminal?ticket=${ticket}`,
    { headers: { origin: portal.origin } },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
async function terminalEcho(socket: WebSocket, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Live participant terminal timed out.")),
      20_000,
    );
    const receive = (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === "data" && frame.data?.includes(marker)) {
        clearTimeout(timer);
        socket.off("message", receive);
        resolve();
      } else if (frame.type === "exit") {
        clearTimeout(timer);
        reject(new Error("Live participant terminal exited."));
      }
    };
    socket.on("message", receive);
    socket.send(JSON.stringify({ type: "input", data: `printf '%s\\n' '${marker}'\n` }));
  });
}

function prepareFixture() {
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- private unpredictable synthetic fixture directory, created only inside the disposable lab
  const root = mkdtempSync("/tmp/tenkacloud-network-lab-");
  const directory = join(root, "data");
  const problem = join(root, "problems", "challenges", "network-fixture");
  const local = join(problem, "local");
  mkdirSync(local, { recursive: true });
  writeFileSync(
    join(problem, "metadata.json"),
    JSON.stringify({
      name: "Network fixture",
      runtime: {
        provider: "docker",
        engine: "compose",
        entry: "local/compose.yml",
        challengeEndpoints: { Web: "http://127.0.0.1:18080" },
        verifyUrl: "http://127.0.0.1:18080/verify",
        secretEnv: [],
        terminal: { service: "web" },
        publicServices: [
          {
            id: "public-web",
            service: "db",
            port: 8080,
            purpose: "Synthetic dedicated Web capability",
          },
        ],
      },
      scoring: { kind: "verify", points: 100, wrongAnswerPenalty: 5, hints: [] },
    }),
  );
  writeFileSync(
    join(local, "server.ts"),
    `
if (process.env.LAB_ROLE === "db") {
  Bun.listen({ hostname: "::", port: 5432, socket: { data(socket, data) { socket.write(data); } } });
  Bun.serve({ hostname: "::", port: 8080, fetch() { return new Response("public-network-fixture"); } });
} else {
  Bun.serve({ hostname: "::", port: 8080, async fetch(request) {
    if (new URL(request.url).pathname === "/verify" && request.method === "POST") {
      const body = await request.json(); return Response.json({ correct: body.submission === "TC{lab}" });
    }
    return new Response("network-fixture");
  } });
}
`,
  );
  writeFileSync(
    join(local, "Dockerfile"),
    'FROM oven/bun:1.3.11-alpine AS participant\nUSER root\nCOPY server.ts /exercise/server.ts\nENTRYPOINT ["bun","/exercise/server.ts"]\n',
  );
  writeFileSync(
    join(local, "compose.yml"),
    `services:
  web:
    build: { context: ., target: participant }
    ports: ["127.0.0.1:18080:8080"]
    mem_limit: 128m
    cpus: 0.5
    pids_limit: 128
  db:
    build: { context: ., target: participant }
    environment: { LAB_ROLE: db }
    mem_limit: 128m
    cpus: 0.5
    pids_limit: 128
networks:
  default: { internal: true }
`,
  );
  return { root, directory };
}
function verifyTargets(targets: ReturnType<typeof inspect>[]): void {
  for (const target of targets) {
    assert.equal(execContainer(target.web, "id -u").output, "0");
    assert.equal(execContainer(target.web, "printf own-db | nc -w 1 db 5432").output, "own-db");
    assert.equal(execContainer(target.web, `nc -zw 1 ${target.gateway4} 19000`).succeeded, false);
    assert.equal(execContainer(target.web, `nc -zw 1 ${target.gateway6} 19000`).succeeded, false);
    assert.equal(
      execContainer(target.web, "timeout 3 nslookup unapproved.invalid 127.0.0.11").succeeded,
      false,
    );
  }
}
async function verifyDmz(
  portal: HttpHost,
  teams: Team[],
  jobs: Job[],
  targets: ReturnType<typeof inspect>[],
  store: HostStore,
): Promise<void> {
  const peer = requiredNetworkValue(targets[1]);
  const client = requiredNetworkValue(targets[0]);
  const probe = (address: string, port: number, expected: boolean) => {
    const result = execContainer(
      client.web,
      `printf 'GET / HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n' | nc -w 2 ${address} ${port}`,
    );
    assert.equal(result.output.includes("public-network-fixture"), expected);
  };
  let lastPublication = 0;
  const publish = async (published: boolean) => {
    // Exercise the real one-request-per-second contract without relaxing admission limits.
    const remaining = 1000 - (Date.now() - lastPublication);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const response = await fetch(
      `${portal.origin}/api/portal/me/problems/network-fixture/network`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requiredNetworkValue(teams[1]).loginKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ serviceId: "public-web", published }),
      },
    );
    assert.equal(response.status, 200, await response.text());
    lastPublication = Date.now();
  };
  for (const address of [peer.db4, peer.db6]) probe(address, 8080, false);
  await publish(true);
  for (const address of [peer.db4, peer.db6]) {
    probe(address, 8080, true);
    assert.equal(execContainer(client.web, `nc -zw 1 ${address} 5432`).succeeded, false);
  }
  assert.equal(execContainer(client.web, `nc -zw 1 ${client.gateway4} 19000`).succeeded, false);
  assert.equal(execContainer(client.web, `nc -zw 1 ${client.gateway6} 19000`).succeeded, false);
  await publish(false);
  for (const address of [peer.db4, peer.db6]) probe(address, 8080, false);
  for (const job of jobs) Object.assign(job, store.job(job.jobId));
}
async function cleanupJobs(
  jobs: readonly Job[],
  old: Job,
  engine: DockerHostingEngine,
  oldEngine: DockerHostingEngine,
  store: HostStore,
): Promise<void> {
  for (const job of [...jobs, old])
    if (job.unit) {
      try {
        await (job === old ? oldEngine : engine).stop(job);
        job.unit = null;
        if (job !== old && store.jobs(job.eventId).some((entry) => entry.jobId === job.jobId))
          store.putJob({ ...store.job(job.jobId), unit: null, status: "DELETED" });
      } catch (error) {
        console.error("Lab ownership cleanup failed", error);
        process.exitCode = 1;
      }
    }
}
async function main(): Promise<void> {
  if (process.env.TENKACLOUD_ISOLATION_LAB !== "1" || process.getuid?.() !== 0)
    throw new Error(
      "This physical check requires the explicitly approved isolated lab, not an ordinary workstation.",
    );
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- fixed native tool in the explicitly approved isolated lab
  const routes = JSON.parse(execFileSync("ip", ["-j", "route"], { encoding: "utf8" }));
  if (routes.some((route: { dst: string }) => route.dst === "default"))
    throw new Error("The lab must have no external default route.");
  const { root, directory } = prepareFixture();
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic isolated lab allocation, not a deployment destination
  const oldEngine = new DockerHostingEngine(root, directory, "10.248.0.0/24");
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- synthetic isolated lab allocation, not a deployment destination
  let engine = new DockerHostingEngine(root, directory, "10.248.0.0/24", true);
  const definition = requiredNetworkValue(engine.catalog()[0]);
  const makeJob = (index: number, isolated = true): Job => ({
    jobId: `networklab${index}`,
    eventId: "networklab-event",
    teamId: `networklab-team-${index}`,
    problemId: definition.problemId,
    definition: definition.definition,
    offset: 0,
    runtimePorts: { "18080": 21000 + index },
    status: "IN_PROGRESS",
    ...(isolated ? { networkIsolationVersion: 1 as const } : {}),
    unit: null,
  });
  const old = makeJob(9, false);
  const jobs = Array.from({ length: 6 }, (_, index) => makeJob(index));
  const host = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve, reject) => {
    host.once("error", reject);
    host.listen(19000, "::", resolve);
  });
  const store = new HostStore(new Database(":memory:"));
  let portal: HttpHost | undefined;
  let service: HostingService | undefined;
  const sockets: WebSocket[] = [];
  const checks: string[] = [];
  let passed = false;
  try {
    await oldEngine.start(old, (unit) => {
      old.unit = unit;
    });
    const baseline = inspect(old);
    assert.equal(
      execContainer(baseline.web, `nc -zw 1 ${baseline.gateway4} 19000`).succeeded,
      true,
    );
    await oldEngine.stop(old);
    old.unit = null;
    checks.push(
      "Old production adapter + internal:true reaches the synthetic host service (IPv4 baseline)",
    );
    for (const job of jobs) {
      await engine.start(job, (unit) => {
        job.unit = unit;
      });
      job.status = "COMPLETE";
      job.deployedAt = Date.now();
    }
    const targets = jobs.map(inspect);
    verifyTargets(targets);
    checks.push(
      "All twelve workload containers retain 128 MiB memory, 0.5 CPU and 128 pids limits",
    );
    checks.push(
      "Six root workloads retain same-team DB + embedded service DNS; host TCP denied in IPv4/IPv6, unapproved name resolution fails",
    );
    const event: HostedEvent = {
      eventId: old.eventId,
      name: "Network lab",
      status: "READY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [definition],
    };
    store.putEvent(event);
    const teams: Team[] = jobs.map((job, index) => ({
      teamId: job.teamId,
      eventId: event.eventId,
      internalSlug: `team-${index}`,
      displayName: `team-${index}`,
      loginKey: `transient-lab-team-${index}`,
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    }));
    for (const [index, team] of teams.entries()) {
      store.putTeam(team);
      store.putJob(requiredNetworkValue(jobs[index]));
    }
    service = new HostingService(store, engine, "transient-lab-host-key");
    portal = await startHttpHost({
      kind: "participant",
      hostname: "127.0.0.1",
      port: 0,
      staticRoot: root,
      service,
    });
    await verifyDmz(requiredNetworkValue(portal), teams, jobs, targets, store);
    checks.push(
      "Declared DMZ Web succeeds in both families; private peer DB/host remain denied; withdrawal revokes access",
    );
    for (const team of teams) {
      const socket = await terminal(portal, team);
      sockets.push(socket);
    }
    await Promise.all(sockets.map((socket, index) => terminalEcho(socket, `LIVE_TEAM_${index}`)));
    requiredNetworkValue(sockets[0]).close();
    const reconnect = await terminal(portal, requiredNetworkValue(teams[0]));
    sockets.push(reconnect);
    await terminalEcho(reconnect, "RECONNECTED_TEAM_0");
    checks.push(
      "Six real authenticated HTTP/WebSocket/Compose shell sessions execute independently; fresh-ticket reconnect succeeds (non-PTY)",
    );
    for (const team of teams) {
      const response: Response = await fetch(`${portal.origin}/api/portal/me/submit-flag`, {
        method: "POST",
        headers: { authorization: `Bearer ${team.loginKey}`, "content-type": "application/json" },
        body: JSON.stringify({ problemId: definition.problemId, flag: "TC{lab}" }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal(store.team(team.teamId).score, 100);
    }
    checks.push("Six real verifier submissions commit scores through existing HostingService");
    for (const socket of sockets) socket.close();
    await portal.close();
    portal = undefined;
    const before = requiredNetworkValue(jobs[0]).unit;
    await engine.pause(requiredNetworkValue(jobs[0]));
    await engine.resume(requiredNetworkValue(jobs[0]));
    assert.equal(requiredNetworkValue(jobs[0]).unit, before);
    await engine.closeTransports();
    engine = new DockerHostingEngine(root, directory); // persisted isolation cannot be disabled by dropping the CLI option
    for (const job of jobs) await engine.recover(job);
    assert.equal(
      execContainer(
        inspect(requiredNetworkValue(jobs[0])).web,
        `nc -zw 1 ${requiredNetworkValue(targets[0]).gateway4} 19000`,
      ).succeeded,
      false,
    );
    checks.push(
      "Stop/resume and controller reconstruction preserve generation, ports, dual-stack guard even without the option",
    );
    const unit = JSON.parse(
      requiredNetworkValue(requiredNetworkValue(jobs[0]).unit),
    ) as LocalComposeUnit;
    const plan = localNetworkPlan(
      unit.composeProjectName,
      requiredNetworkValue(unit.networkSubnets),
      {
        composeText: JSON.parse(requiredNetworkValue(jobs[0]).definition).composeText,
        definition: requiredNetworkValue(jobs[0]).definition,
      },
    );
    command(["network", "connect", "bridge", inspect(requiredNetworkValue(jobs[0])).web]);
    await assert.rejects(() => engine.recover(requiredNetworkValue(jobs[0])));
    assert.equal(
      JSON.parse(command(["inspect", inspect(requiredNetworkValue(jobs[0])).web]))[0].State.Running,
      false,
    );
    command(["network", "disconnect", "bridge", inspect(requiredNetworkValue(jobs[0])).web]);
    await engine.resume(requiredNetworkValue(jobs[0]));
    checks.push("An added unowned attachment prevents adoption and stops the owned workload");
    const guard = new LinuxNetworkGuard();
    guard.verifyNetworks(plan);
    console.log(
      JSON.stringify(
        {
          checks,
          status: "passed",
          note: "Physical nested Docker lab; no Internet/real LAN/VM escape/browser-UI claim",
        },
        null,
        2,
      ),
    );
    passed = true;
  } finally {
    for (const socket of sockets) socket.terminate();
    await portal?.close();
    await service?.drain();
    await Promise.all([engine.closeTransports(), oldEngine.closeTransports()]);
    await cleanupJobs(jobs, old, engine, oldEngine, store);
    store.close();
    host.close();
    if (passed && [...jobs, old].every((job) => job.unit === null))
      rmSync(root, { recursive: true });
    else console.error(`Synthetic lab source retained for diagnostics: ${root}`);
  }
}
await main();
