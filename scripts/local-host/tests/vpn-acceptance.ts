/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-os-command-from-path -- Fixed synthetic addresses and native tools only inside the explicitly scoped disposable GitHub VM. */
/** Manual GitHub-hosted disposable VM acceptance. Never run on a workstation/shared runner.
 * No default route or shared firewall chain is flushed. Only named, exclusively created
 * resources are removed. WireGuard private keys exist only in the root-only /run directory.
 */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFile,
  execFileSync,
  fork,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import type { LocalComposeUnit } from "../container/container-runner";
import { DockerHostingEngine } from "../docker-engine";
import { type HttpHost, startHttpHost } from "../http";
import { LinuxNetworkGuard } from "../linux-network-guard";
import { requiredNetworkValue, segmentGateway } from "../local-network";
import type { Job, Team } from "../model";
import { HostingService } from "../service";
import { HostStore } from "../store";
import type { VpnRuntimeAdmission } from "../vpn/forward-policy";
import { NativeVpnIngress } from "../vpn/native-ingress";
import { type VpnPeerPlan, vpnPeerPlan } from "../vpn/peer-plan";
import { prepareFixture } from "./network-docker-smoke";

import {
  acceptanceUnitDescription,
  acceptanceUnitState,
  acceptanceWgUnitContent,
  acceptanceWgUnitPath,
  afterAcceptanceTransportRemoved,
  assertAcceptanceUnitAvailable,
  cleanupAcceptanceUnits,
  acceptanceSealUnit as sealUnit,
  acceptanceWgUnit as wgUnit,
} from "./vpn-acceptance-units";

import { awaitSyntheticCanary, syntheticCanaryScript } from "./vpn-canary";

const execute = promisify(execFile);
const iface = "tcwgac";
const namespaces = Array.from({ length: 6 }, (_, index) => `tcvpa${index}`);
const extraNamespaces = ["tcvlan", "tcvwan"];
const roots = [...namespaces.map((_, index) => `tcvu${index}`), "tcvlan0", "tcvwan0"];
const udpChain = "TCVA_UDP";
const canaryChain = "TCVA_CANARY";
const udpPort = 51870;
const server4 = "10.251.240.1";
const server6 = "fd55:240::1";
const adminPort = 19002;

const token = () => randomBytes(24).toString("hex");

function command(program: string, args: readonly string[], input?: string): string {
  try {
    return execFileSync(program, [...args], {
      input,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `Acceptance command failed: ${program} ${args[0] ?? ""} (arguments/output withheld)`,
    );
  }
}
export function assertAcceptanceEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: string,
  uid: number | undefined,
): void {
  if (
    environment.TENKACLOUD_VPN_ACCEPTANCE !== "github-ephemeral-v1" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
    environment.RUNNER_OS !== "Linux" ||
    environment.ImageOS !== "ubuntu24" ||
    platform !== "linux" ||
    uid !== 0
  )
    throw new Error(
      "VPN acceptance requires explicit scope and a root GitHub-hosted ubuntu-24.04 VM.",
    );
}
function scope(exclusive = true): void {
  assertAcceptanceEnvironment(process.env, process.platform, process.getuid?.());
  if (command("findmnt", ["-n", "-o", "FSTYPE", "/run"]) !== "tmpfs")
    throw new Error("Private keys require /run tmpfs.");
  if (!exclusive) return;
  for (const path of [
    "/proc/sys/net/ipv4/ip_forward",
    "/proc/sys/net/ipv6/conf/all/forwarding",
    "/proc/sys/net/bridge/bridge-nf-call-iptables",
    "/proc/sys/net/bridge/bridge-nf-call-ip6tables",
  ])
    assert.equal(
      readFileSync(path, "utf8").trim(),
      "1",
      "VM forwarding/netfilter must be prepared before acceptance",
    );
  const links = JSON.parse(command("ip", ["-j", "link"])) as { ifname: string }[];
  assert.ok(
    !links.some((link) => [iface, ...roots].includes(link.ifname)),
    "Owned interface name is already in use",
  );
  const existing = command("ip", ["netns", "list"]);
  for (const name of [...namespaces, ...extraNamespaces])
    assert.ok(
      !existing.split("\n").some((line) => line.split(" ")[0] === name),
      "Owned namespace name is already in use",
    );
  assert.ok(!command("iptables", ["-S"]).includes(udpChain), "Owned UDP chain already exists");
  for (const family of ["iptables", "ip6tables"])
    assert.ok(!command(family, ["-S"]).includes(canaryChain), "Owned canary chain already exists");
  for (const unit of [sealUnit, wgUnit]) {
    const occupied = [
      `/etc/systemd/system/${unit}`,
      `/run/systemd/system/${unit}`,
      ...(unit === wgUnit ? [`/etc/wireguard/${iface}.conf`] : []),
    ].some(existsSync);
    assertAcceptanceUnitAvailable(unit, acceptanceUnitState(command, unit), occupied);
  }
  command("docker", ["image", "inspect", "oven/bun:1.3.11-alpine"]);
}
function privateKey(directory: string, name: string): { path: string; publicKey: string } {
  const path = join(directory, name);
  const fd = openSync(path, "wx", 0o600);
  try {
    const result = spawnSync("wg", ["genkey"], { stdio: ["ignore", fd, "pipe"], timeout: 5000 });
    assert.equal(result.status, 0, "Ephemeral WireGuard key generation failed");
  } finally {
    closeSync(fd);
  }
  // Public output only; the private value is never an argument or log line.
  const publicKey = command("wg", ["pubkey"], readFileSync(path, "utf8"));
  return { path, publicKey };
}
async function probe(
  namespace: string,
  url: string,
  options: { body?: unknown; bearer?: string; status?: number } = {},
): Promise<string> {
  const args = [
    "netns",
    "exec",
    namespace,
    "curl",
    "--silent",
    "--show-error",
    "--noproxy",
    "*",
    "--connect-timeout",
    "2",
    "--max-time",
    "8",
    "--write-out",
    "\n%{http_code}",
  ];
  if (options.bearer) args.push("-H", `Authorization: Bearer ${options.bearer}`);
  if (options.body !== undefined)
    args.push(
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      JSON.stringify(options.body),
    );
  args.push(url);
  let result: string;
  try {
    result = (
      await execute("ip", args, { encoding: "utf8", timeout: 12_000, maxBuffer: 1024 * 1024 })
    ).stdout;
  } catch {
    throw new Error(`Peer probe transport failed in ${namespace} (request withheld)`);
  }
  const position = result.lastIndexOf("\n");
  assert.equal(
    Number(result.slice(position + 1)),
    options.status ?? 200,
    "Unexpected peer HTTP status",
  );
  return result.slice(0, position);
}
async function denied(namespace: string, address: string, port: number): Promise<void> {
  const script = `const s=require('node:net').connect({host:${JSON.stringify(address)},port:${port}});const t=setTimeout(()=>{s.destroy();process.exit(2)},1500);s.on('connect',()=>{clearTimeout(t);s.destroy();console.log('CONNECTED')});s.on('error',()=>{clearTimeout(t);s.destroy();process.exit(2)});`;
  let connected: boolean;
  try {
    const result = await execute(
      "ip",
      ["netns", "exec", namespace, process.execPath, "--eval", script],
      { timeout: 5000, maxBuffer: 1024 },
    );
    connected = result.stdout.trim() === "CONNECTED";
    assert.equal(connected, true, "TCP probe must explicitly report a connection");
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 2)
      throw error;
    connected = false;
  }
  assert.equal(connected, false, "Forbidden peer transport connected");
}
async function udpProbe(
  namespace: string | undefined,
  address: string,
  expected: boolean,
): Promise<void> {
  const kind = address.includes(":") ? "udp6" : "udp4";
  const script = `const s=require('node:dgram').createSocket('${kind}');const t=setTimeout(()=>{s.close();process.exit(2)},1500);s.on('message',m=>{clearTimeout(t);s.close();if(m.toString()!=='owned-dns-canary')process.exit(3);console.log('UDP_OK')});s.on('error',()=>{clearTimeout(t);s.close();process.exit(2)});s.send(Buffer.from('owned-dns-canary'),53,${JSON.stringify(address)});`;
  const args = namespace
    ? ["netns", "exec", namespace, process.execPath, "--eval", script]
    : ["--eval", script];
  let replied = false;
  try {
    const result = await execute(namespace ? "ip" : process.execPath, args, {
      timeout: 5000,
      maxBuffer: 1024,
    });
    assert.equal(result.stdout.trim(), "UDP_OK");
    replied = true;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 2)
      throw error;
  }
  assert.equal(replied, expected, "Unexpected UDP DNS canary connectivity");
}
function httpAddress(address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${port}`;
}
interface Target {
  web4: string;
  web6: string;
  db4: string;
  db6: string;
  gateway4: string;
  gateway6: string;
}
function target(job: Job): Target {
  const unit = JSON.parse(requiredNetworkValue(job.unit)) as LocalComposeUnit;
  const rows = JSON.parse(
    command("docker", [
      "inspect",
      ...command("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${unit.composeProjectName}`,
      ]).split("\n"),
    ]),
  ) as {
    HostConfig: { Memory: number; NanoCpus: number; PidsLimit: number };
    Config: { Labels: Record<string, string> };
    NetworkSettings: { Networks: Record<string, { IPAddress: string; GlobalIPv6Address: string }> };
  }[];
  for (const row of rows) {
    assert.equal(row.HostConfig.Memory, 128 * 1024 * 1024);
    assert.equal(row.HostConfig.NanoCpus, 500_000_000);
    assert.equal(row.HostConfig.PidsLimit, 128);
  }
  const network = (service: string) =>
    requiredNetworkValue(
      requiredNetworkValue(
        rows.find((row) => row.Config.Labels["com.docker.compose.service"] === service),
      ).NetworkSettings.Networks[`${unit.composeProjectName}_default`],
    );
  const web = network("web");
  const db = network("db");
  const plan = Reflect.get(engineRequired, "guardPlan") as (
    job: Job,
    unit: LocalComposeUnit,
  ) => { segments: { name: string; bridge: string; ipv4: string; ipv6: string }[] };
  const segment = requiredNetworkValue(plan.call(engineRequired, job, unit).segments[0]);
  return {
    web4: web.IPAddress,
    web6: web.GlobalIPv6Address,
    db4: db.IPAddress,
    db6: db.GlobalIPv6Address,
    gateway4: segmentGateway(segment, false),
    gateway6: segmentGateway(segment, true),
  };
}
let engineRequired: DockerHostingEngine;

async function peerTerminal(path: string): Promise<void> {
  assert.ok(path.startsWith("/run/tc-vpn-acceptance-"));
  const request = JSON.parse(readFileSync(path, "utf8")) as {
    bearer: string;
    problemId: string;
    marker: string;
  };
  const origin = `http://${server4}:5175`;
  const response = await fetch(
    `${origin}/api/portal/me/problems/${request.problemId}/terminal-handoff`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${request.bearer}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(response.status, 200);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new WebSocket(
    `${origin.replace("http:", "ws:")}/api/portal/me/problems/${request.problemId}/terminal?ticket=${ticket}`,
    { headers: { origin } },
  );
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket.terminate();
      reject(new Error("Peer terminal deadline"));
    }, 15_000);
    socket.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    socket.once("open", () =>
      socket.send(JSON.stringify({ type: "input", data: `printf '%s\\n' '${request.marker}'\n` })),
    );
    socket.on("message", (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === "data" && frame.data?.includes(request.marker)) {
        clearTimeout(deadline);
        socket.close();
        resolve();
      }
    });
  });
  socket.terminate();
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}
function installCanaryGuard(): void {
  for (const family of ["iptables", "ip6tables"]) {
    command(family, ["-N", canaryChain]);
    for (const link of ["lo", iface, ...roots])
      command(family, ["-A", canaryChain, "-i", link, "-j", "RETURN"]);
    command(family, ["-A", canaryChain, "-j", "DROP"]);
    command(family, [
      "-I",
      "INPUT",
      "1",
      "-p",
      "tcp",
      "--dport",
      String(adminPort),
      "-j",
      canaryChain,
    ]);
  }
}
function cleanupCanaryGuard(): void {
  for (const family of ["iptables", "ip6tables"]) {
    const inventory = command(family, ["-S"]);
    if (!inventory.split("\n").includes(`-N ${canaryChain}`)) continue;
    if (inventory.includes(`-j ${canaryChain}`))
      command(family, [
        "-D",
        "INPUT",
        "-p",
        "tcp",
        "--dport",
        String(adminPort),
        "-j",
        canaryChain,
      ]);
    command(family, ["-F", canaryChain]);
    command(family, ["-X", canaryChain]);
  }
}
function cleanupOptionalPolicy(plan: VpnPeerPlan | undefined): void {
  if (plan) cleanupPolicy(plan);
}
async function terminalProcess(namespace: string, path: string): Promise<void> {
  try {
    await execute(
      "ip",
      ["netns", "exec", namespace, process.execPath, import.meta.filename, "--peer-terminal", path],
      { timeout: 25_000, encoding: "utf8", maxBuffer: 1024 },
    );
  } catch {
    throw new Error("Real VPN authenticated terminal failed (request withheld)");
  }
}
async function crashWriter(): Promise<void> {
  const path = requiredNetworkValue(process.env.TENKACLOUD_VPN_WRITER_SNAPSHOT);
  assert.ok(path.startsWith("/run/tc-vpn-acceptance-"), "Writer snapshot outside private tmpfs");
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
    registration: unknown;
    runtimes: VpnRuntimeAdmission[];
  };
  const ingress = new NativeVpnIngress(vpnPeerPlan(snapshot.registration));
  await ingress.reconcile(snapshot.runtimes);
  process.send?.({ ready: true });
  // The live IPC channel keeps this policy writer alive until the parent SIGKILLs it.
  await new Promise<void>(() => {
    process.on("disconnect", () => process.exit(1));
  });
}

async function main(): Promise<void> {
  scope();
  const privateDirectory = mkdtempSync("/run/tc-vpn-acceptance-");
  const fixture = prepareFixture();
  const store = new HostStore(new Database(":memory:"));
  const engine = new DockerHostingEngine(fixture.root, fixture.directory, "10.248.0.0/24", true);
  engineRequired = engine;
  const createdNamespaces: string[] = [];
  const createdLinks: string[] = [];
  let udpCreated = false;
  let plan: VpnPeerPlan | undefined;
  let ingress: NativeVpnIngress | undefined;
  let portal: HttpHost | undefined;
  let service: HostingService | undefined;
  let admin: ReturnType<typeof Bun.serve> | undefined;
  const canaries: ChildProcess[] = [];
  let auditTimer: ReturnType<typeof setInterval> | undefined;
  let auditWork: Promise<void> | undefined;
  const jobs: Job[] = [];
  const checks: string[] = [];
  const failures: unknown[] = [];
  const journalPath = join(privateDirectory, "journal.json");
  const journal = () =>
    writeFileSync(
      journalPath,
      JSON.stringify({
        registration: plan
          ? {
              version: plan.version,
              interface: plan.interface,
              serverPublicKey: plan.serverPublicKey,
              serverIpv4: plan.serverIpv4,
              serverIpv6: plan.serverIpv6,
              participantPort: plan.participantPort,
              peers: plan.peers,
            }
          : undefined,
        root: fixture.root,
        jobs,
      }),
      { mode: 0o600 },
    );
  journal();
  const beginAudits = () => {
    auditTimer = setInterval(() => {
      if (auditWork) return;
      auditWork = engine
        .auditNetworks()
        .then(() => engine.drainNetworkChecks())
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => {
          auditWork = undefined;
        });
    }, 5000);
  };
  const defaultRoutes = command("ip", ["-j", "route", "show", "default"]);
  const defaultRoutes6 = command("ip", ["-j", "-6", "route", "show", "default"]);
  const finish = async () => {
    const clean = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    clearInterval(auditTimer);
    await clean(async () => {
      await auditWork;
      await portal?.close();
      await service?.drain();
      await engine.closeTransports();
    });
    for (const job of jobs)
      await clean(async () => {
        Object.assign(job, store.job(job.jobId));
        if (job.unit) {
          await engine.stop(job);
          store.putJob({ ...store.job(job.jobId), unit: null, status: "DELETED" });
          job.unit = null;
        }
      });
    await clean(() => ingress?.seal());
    await admin?.stop(true);
    for (const canary of canaries) await clean(() => killChild(canary));
    await clean(() => cleanupUnits(privateDirectory));
    for (const name of createdNamespaces.toReversed())
      await clean(() => {
        command("ip", ["netns", "delete", name]);
      });
    for (const name of createdLinks.toReversed())
      await clean(() => {
        const present = JSON.parse(command("ip", ["-j", "link"])).some(
          (link: { ifname: string }) => link.ifname === name,
        );
        if (present) command("ip", ["link", "delete", name]);
      });
    await clean(() => cleanupDetached(() => cleanupOptionalPolicy(plan)));
    if (udpCreated) await clean(() => cleanupDetached(cleanupUdpStrict));
    await clean(() => cleanupDetached(cleanupCanaryGuard));
    await clean(() => {
      assert.equal(command("docker", ["ps", "-aq", "--filter", "name=tch-vpnacceptance"]), "");
      assert.equal(command("ip", ["-j", "route", "show", "default"]), defaultRoutes);
      assert.equal(command("ip", ["-j", "-6", "route", "show", "default"]), defaultRoutes6);
    });
    store.close();
    if (!failures.length) {
      rmSync(privateDirectory, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };
  try {
    installCanaryGuard();
    const server = privateKey(privateDirectory, "server.key");
    const peers = namespaces.map((_, index) => privateKey(privateDirectory, `peer-${index}.key`));
    const registration = {
      version: 1,
      interface: iface,
      serverPublicKey: server.publicKey,
      serverIpv4: server4,
      serverIpv6: server6,
      participantPort: 5175,
      peers: peers.map((peer, index) => ({
        publicKey: peer.publicKey,
        eventId: "vpn-acceptance",
        teamId: `vpn-team-${index}`,
        ipv4: `10.251.240.${index + 2}`,
        ipv6: `fd55:240::${index + 2}`,
      })),
    };
    plan = vpnPeerPlan(registration);
    journal();
    const configPath = join(privateDirectory, "peers.json");
    writeFileSync(configPath, JSON.stringify(registration), { mode: 0o600, flag: "wx" });
    command("iptables", ["-N", udpChain]);
    udpCreated = true;
    command("iptables", ["-A", udpChain, "-j", "DROP"]);
    command("iptables", [
      "-I",
      "INPUT",
      "1",
      "-p",
      "udp",
      "--dport",
      String(udpPort),
      "-j",
      udpChain,
    ]);
    // Deny IPv6 underlay altogether; encrypted test transport uses the six owned veths.
    command("ip6tables", [
      "-I",
      "INPUT",
      "1",
      "-p",
      "udp",
      "--dport",
      String(udpPort),
      "-m",
      "comment",
      "--comment",
      "tc-vpn-acceptance-udp",
      "-j",
      "DROP",
    ]);
    command("systemd-run", [
      "--quiet",
      `--unit=${sealUnit}`,
      `--description=${acceptanceUnitDescription(privateDirectory)}`,
      "--service-type=oneshot",
      "--property=RemainAfterExit=yes",
      process.execPath,
      join(process.cwd(), "scripts/local-host/vpn/boot-seal.ts"),
      "--config",
      configPath,
    ]);
    command("systemctl", ["is-active", sealUnit]);
    // An explicit owned runtime instance overrides only this unused instance,
    // never the vendor wg-quick template or production configuration.
    writeFileSync(acceptanceWgUnitPath, acceptanceWgUnitContent(privateDirectory), {
      mode: 0o644,
      flag: "wx",
    });
    command("systemctl", ["daemon-reload"]);
    command("systemctl", ["start", wgUnit]);
    command("systemctl", ["is-active", wgUnit]);
    command("ip", ["link", "add", iface, "type", "wireguard"]);
    createdLinks.push(iface);
    command("ip", ["address", "add", `${server4}/32`, "dev", iface]);
    command("ip", ["-6", "address", "add", `${server6}/128`, "dev", iface]);
    command("wg", ["set", iface, "private-key", server.path, "listen-port", String(udpPort)]);
    command("ip", ["link", "set", iface, "up"]);
    for (const [index, namespace] of namespaces.entries()) {
      const rootLink = requiredNetworkValue(roots[index]);
      const peer = requiredNetworkValue(peers[index]);
      const rootAddress = `172.30.240.${index * 4 + 1}`;
      const peerAddress = `172.30.240.${index * 4 + 2}`;
      command("ip", ["netns", "add", namespace]);
      createdNamespaces.push(namespace);
      command("ip", ["link", "add", rootLink, "type", "veth", "peer", "name", "tcvpeer"]);
      createdLinks.push(rootLink);
      command("ip", ["link", "set", "tcvpeer", "netns", namespace]);
      command("ip", ["address", "add", `${rootAddress}/30`, "dev", rootLink]);
      command("ip", ["link", "set", rootLink, "up"]);
      const ns = (args: string[]) => command("ip", ["netns", "exec", namespace, ...args]);
      ns(["ip", "link", "set", "lo", "up"]);
      ns(["ip", "address", "add", `${peerAddress}/30`, "dev", "tcvpeer"]);
      ns(["ip", "link", "set", "tcvpeer", "up"]);
      ns(["ip", "link", "add", "wgpeer", "type", "wireguard"]);
      ns(["ip", "address", "add", `10.251.240.${index + 2}/32`, "dev", "wgpeer"]);
      ns(["ip", "-6", "address", "add", `fd55:240::${index + 2}/128`, "dev", "wgpeer"]);
      ns([
        "wg",
        "set",
        "wgpeer",
        "private-key",
        peer.path,
        "peer",
        server.publicKey,
        "allowed-ips",
        "0.0.0.0/0,::/0",
        "endpoint",
        `${rootAddress}:${udpPort}`,
        "persistent-keepalive",
        "1",
      ]);
      ns(["ip", "link", "set", "wgpeer", "up"]);
      ns(["ip", "route", "add", "default", "dev", "wgpeer"]);
      ns(["ip", "-6", "route", "add", "default", "dev", "wgpeer"]);
      command("wg", [
        "set",
        iface,
        "peer",
        peer.publicKey,
        "allowed-ips",
        `10.251.240.${index + 2}/32,fd55:240::${index + 2}/128`,
      ]);
      command("ip", ["route", "add", `10.251.240.${index + 2}/32`, "dev", iface]);
      command("ip", ["-6", "route", "add", `fd55:240::${index + 2}/128`, "dev", iface]);
      command("iptables", [
        "-I",
        udpChain,
        "1",
        "-i",
        rootLink,
        "-s",
        peerAddress,
        "-d",
        rootAddress,
        "-j",
        "ACCEPT",
      ]);
    }
    // Reachable synthetic LAN/WAN destinations, never the real LAN or Internet.
    const setupCanaries = async () => {
      for (const [index, namespace] of extraNamespaces.entries()) {
        const link = requiredNetworkValue(roots[index + 6]);
        const subnet = index ? "198.19.240" : "198.18.240";
        command("ip", ["netns", "add", namespace]);
        createdNamespaces.push(namespace);
        command("ip", ["link", "add", link, "type", "veth", "peer", "name", "tcvpeer"]);
        createdLinks.push(link);
        command("ip", ["link", "set", "tcvpeer", "netns", namespace]);
        command("ip", ["address", "add", `${subnet}.1/30`, "dev", link]);
        command("ip", ["link", "set", link, "up"]);
        command("ip", ["netns", "exec", namespace, "ip", "link", "set", "lo", "up"]);
        command("ip", [
          "netns",
          "exec",
          namespace,
          "ip",
          "address",
          "add",
          `${subnet}.2/30`,
          "dev",
          "tcvpeer",
        ]);
        command("ip", ["netns", "exec", namespace, "ip", "link", "set", "tcvpeer", "up"]);
        const subnet6 = `fd66:${index + 1}`;
        command("ip", ["-6", "address", "add", `${subnet6}::1/64`, "dev", link]);
        command("ip", [
          "netns",
          "exec",
          namespace,
          "ip",
          "-6",
          "address",
          "add",
          `${subnet6}::2/64`,
          "dev",
          "tcvpeer",
        ]);
        command("ip", [
          "netns",
          "exec",
          namespace,
          "ip",
          "-6",
          "route",
          "add",
          "fd55:240::/64",
          "via",
          `${subnet6}::1`,
        ]);
        command("ip", [
          "netns",
          "exec",
          namespace,
          "ip",
          "route",
          "add",
          "10.251.240.0/24",
          "via",
          `${subnet}.1`,
        ]);
        const script = syntheticCanaryScript({
          httpPort: adminPort,
          dnsPort: 53,
          marker: `synthetic-${namespace}`,
        });
        const canary = spawn(
          "ip",
          ["netns", "exec", namespace, process.execPath, "--eval", script],
          {
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        canaries.push(canary);
        const ready = await awaitSyntheticCanary(canary);
        assert.equal(ready.httpPort, adminPort);
        assert.equal(ready.dnsPort, 53);
        for (const address of [`${subnet}.2`, `${subnet6}::2`]) {
          assert.equal(
            await (
              await fetch(httpAddress(address, adminPort), { signal: AbortSignal.timeout(1000) })
            ).text(),
            `synthetic-${namespace}`,
          );
          assert.equal(
            await (
              await fetch(httpAddress(address, 53), { signal: AbortSignal.timeout(1000) })
            ).text(),
            "owned-dns-canary",
          );
        }
        await udpProbe(undefined, `${subnet}.2`, true);
        await udpProbe(undefined, `${subnet6}::2`, true);
      }
    };
    await setupCanaries();
    admin = Bun.serve({
      hostname: "::",
      port: adminPort,
      fetch: () => new Response("owned-host-canary"),
    });
    // Root-side canaries prove the host service exists; forbidden tests cannot pass from no listener.
    assert.equal(await (await fetch(`http://127.0.0.1:${adminPort}`)).text(), "owned-host-canary");
    const definition = requiredNetworkValue(engine.catalog()[0]);
    store.putEvent({
      eventId: "vpn-acceptance",
      name: "Ephemeral VPN acceptance",
      status: "READY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [definition],
    });
    const teams: Team[] = namespaces.map((_, index) => ({
      teamId: `vpn-team-${index}`,
      eventId: "vpn-acceptance",
      internalSlug: `team-${index}`,
      displayName: `Team ${index}`,
      loginKey: token(),
      snapshot: null,
      score: 0,
      completedProblems: 0,
      scoreEvents: [],
    }));
    for (const team of teams) store.putTeam(team);
    service = new HostingService(store, engine, token());
    beginAudits();
    for (const [index, team] of teams.entries()) {
      const job: Job = {
        jobId: `vpnacceptance${index}`,
        teamId: team.teamId,
        eventId: team.eventId,
        problemId: definition.problemId,
        definition: definition.definition,
        offset: 0,
        runtimePorts: { "18080": 21200 + index },
        status: "IN_PROGRESS",
        networkIsolationVersion: 1,
        unit: null,
      };
      jobs.push(job);
      store.putJob(job);
      journal();
      await engine.start(job, (unit) => {
        job.unit = unit;
        store.putJob(job);
        journal();
      });
      job.status = "COMPLETE";
      job.deployedAt = Date.now();
      store.putJob(job);
      journal();
    }
    ingress = new NativeVpnIngress(plan);
    engine.bindVpnIngress(ingress);
    await engine.auditNetworks();
    portal = await startHttpHost({
      kind: "participant",
      hostname: server4,
      port: 5175,
      staticRoot: fixture.root,
      service,
      authorizePeer: (remote, bearer) =>
        requiredNetworkValue(ingress).authorize(remote, store.authenticateTeam(bearer)),
      authorizeTerminalPeer: (remote, grant) =>
        requiredNetworkValue(ingress).authorize(remote, grant),
    });
    const targets = jobs.map(target);
    clearInterval(auditTimer);
    auditTimer = undefined;
    await auditWork;
    const verifyPeers = async () => {
      for (const [index, namespace] of namespaces.entries()) {
        // No periodic policy writer runs during a negative batch: denial must be the
        // installed policy, rather than a temporary all-closed reconciliation seal.
        await engine.auditNetworks();
        await engine.drainNetworkChecks();
        await engine.auditNetworks();
        const own = requiredNetworkValue(targets[index]);
        for (const address of [own.web4, own.web6])
          assert.equal(await probe(namespace, httpAddress(address, 8080)), "network-fixture");
        const team = requiredNetworkValue(teams[index]);
        await probe(namespace, `http://${server4}:5175/api/portal/me/submit-flag`, {
          bearer: team.loginKey,
          body: { problemId: definition.problemId, flag: "TC{lab}" },
        });
        assert.equal(store.team(team.teamId).score, 100);
        await probe(namespace, `http://${server4}:5175/api/portal/me`, {
          bearer: requiredNetworkValue(teams[(index + 1) % 6]).loginKey,
          status: 403,
        });
        const terminalPath = join(privateDirectory, `terminal-${index}.json`);
        writeFileSync(
          terminalPath,
          JSON.stringify({
            bearer: team.loginKey,
            problemId: definition.problemId,
            marker: `VPN_TERMINAL_${index}`,
          }),
          { mode: 0o600 },
        );
        await terminalProcess(namespace, terminalPath);
        const peer = requiredNetworkValue(targets[(index + 1) % 6]);
        for (const address of [peer.web4, peer.web6, peer.db4, peer.db6])
          await denied(namespace, address, 8080);
        for (const address of [
          server4,
          server6,
          own.gateway4,
          own.gateway6,
          "198.18.240.2",
          "198.19.240.2",
          "fd66:1::2",
          "fd66:2::2",
        ])
          await denied(namespace, address, adminPort);
        for (const address of ["198.18.240.2", "198.19.240.2", "fd66:1::2", "fd66:2::2"]) {
          await denied(namespace, address, 53);
          await udpProbe(namespace, address, false);
        }
        assert.equal(await probe(namespace, httpAddress(own.web4, 8080)), "network-fixture");
      }
    };
    await verifyPeers();
    checks.push(
      "six-real-wireguard-peers-own-private-dual-stack-and-authenticated-verifier-scores",
    );
    checks.push("six-real-peer-authenticated-websocket-compose-terminals");
    checks.push("other-team-private-host-admin-gateway-and-synthetic-lan-wan-denied");
    checks.push("synthetic-lan-wan-tcp-udp-dns-denied-both-families-with-root-positive-controls");
    const first = requiredNetworkValue(namespaces[0]);
    const publisher = requiredNetworkValue(teams[1]);
    const publicTarget = requiredNetworkValue(targets[1]);
    const publish = async (published: boolean) =>
      probe(
        requiredNetworkValue(namespaces[1]),
        `http://${server4}:5175/api/portal/me/problems/${definition.problemId}/network`,
        { bearer: publisher.loginKey, body: { serviceId: "public-web", published } },
      );
    await publish(true);
    for (const job of jobs) Object.assign(job, store.job(job.jobId));
    journal();
    for (const address of [publicTarget.db4, publicTarget.db6]) {
      assert.equal(await probe(first, httpAddress(address, 8080)), "public-network-fixture");
      await denied(first, address, 5432);
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await publish(false);
    for (const job of jobs) Object.assign(job, store.job(job.jobId));
    journal();
    for (const address of [publicTarget.db4, publicTarget.db6]) await denied(first, address, 8080);
    checks.push("exact-public-dmz-dual-stack-port-and-withdrawal");
    // A separate real policy-writer process dies without cleanup; kernel leases must expire.
    // This is a policy-writer crash test, not a cold boot or full application crash claim.
    await engine.auditNetworks();
    clearInterval(auditTimer);
    auditTimer = undefined;
    await auditWork;
    const admissions = Reflect.get(engine, "vpnSnapshot") as () => VpnRuntimeAdmission[];
    const snapshotPath = join(privateDirectory, "writer.json");
    writeFileSync(
      snapshotPath,
      JSON.stringify({ registration, runtimes: admissions.call(engine) }),
      { mode: 0o600 },
    );
    const writer = fork(import.meta.filename, [], {
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TENKACLOUD_VPN_WRITER_SNAPSHOT: snapshotPath },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("Policy writer readiness timeout")),
          30_000,
        );
        writer.once("exit", () => {
          clearTimeout(deadline);
          reject(new Error("Policy writer failed before readiness"));
        });
        writer.once("message", () => {
          clearTimeout(deadline);
          resolve();
        });
        writer.once("error", reject);
      });
      assert.equal(
        await probe(first, `http://${requiredNetworkValue(targets[0]).web4}:8080`),
        "network-fixture",
      );
      await new Promise<void>((resolve) => {
        writer.once("exit", () => resolve());
        writer.kill("SIGKILL");
      });
      // Kernel timeouts are bounded by 60s; keep the controller event loop alive while waiting.
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      await denied(first, requiredNetworkValue(targets[0]).web4, 8080);
      await denied(first, server4, 5175);
      await engine.auditNetworks();
      await engine.drainNetworkChecks();
      beginAudits();
      for (const job of jobs) {
        Object.assign(job, store.job(job.jobId));
        if (job.status === "STOPPED") {
          await engine.resume(job);
          job.status = "COMPLETE";
          store.putJob(job);
        }
      }
      await engine.auditNetworks();
      journal();
      assert.equal(
        await probe(first, `http://${requiredNetworkValue(targets[0]).web4}:8080`),
        "network-fixture",
      );
      checks.push("killed-policy-writer-kernel-lease-expiry-and-reconciliation");
    } finally {
      await killChild(writer);
    }
    console.log(
      JSON.stringify({
        status: "checks-passed-cleanup-pending",
        checks,
        exclusions: ["cold-boot", "real-home-lan", "internet", "external-udp"],
      }),
    );
  } catch (error) {
    failures.push(error);
  } finally {
    await finish();
  }
  if (failures.length)
    throw new AggregateError(failures, "VPN acceptance failed or owned cleanup was not confirmed.");
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      cleanup: "OWNED_VPN_LAB_ABSENT",
      physical: "GitHub disposable VM encrypted namespace traffic; no cold-boot or real-LAN claim",
    }),
  );
}
function removeOwnedHooks(
  program: string,
  inventory: string,
  chains: readonly string[],
  generation: string,
): void {
  for (const line of inventory.split("\n")) {
    if (!line.startsWith("-A ")) continue;
    const args = line.replaceAll('"', "").split(" ");
    if (
      ["INPUT", "FORWARD", "DOCKER-USER"].includes(args[1] ?? "") &&
      (chains.some((chain) => line.endsWith(`-j ${chain}`)) ||
        line.includes(`tc-vpn-seal-v1:${generation}`))
    )
      command(program, ["-D", ...args.slice(1)]);
  }
}
function rememberPolicySets(inventory: string, chains: readonly string[], sets: Set<string>): void {
  for (const line of inventory.split("\n"))
    if (chains.some((chain) => line.startsWith(`-A ${chain} `)))
      for (const match of line.matchAll(/--match-set (TCV_[a-f0-9]{16}_P?[46]) /gu))
        sets.add(requiredNetworkValue(match[1]));
}
function cleanupPolicy(plan: VpnPeerPlan): void {
  const id = createHash("sha256").update(plan.generation).digest("hex").slice(0, 16);
  const chains = [`TCV_${id}_I`, `TCV_${id}_F`];
  const sets = new Set<string>();
  for (const program of ["iptables", "ip6tables"]) {
    const inventory = command(program, ["-S"]);
    rememberPolicySets(inventory, chains, sets);
    removeOwnedHooks(program, inventory, chains, plan.generation);
    for (const chain of chains)
      if (inventory.split("\n").includes(`-N ${chain}`)) {
        command(program, ["-F", chain]);
        command(program, ["-X", chain]);
      }
  }
  for (const name of sets) command("ipset", ["destroy", name]);
}
function cleanupSavedJob(root: string, job: Job): void {
  assert.match(job.jobId, /^vpnacceptance[0-5]$/u);
  if (!job.unit) return;
  const unit = JSON.parse(job.unit) as LocalComposeUnit;
  assert.equal(unit.composeProjectName, `tch-${job.jobId}`);
  assert.ok(unit.composePath.startsWith(`${root}/data/`));
  const adapter = new DockerHostingEngine(root, join(root, "data"));
  const getPlan = Reflect.get(adapter, "guardPlan") as (
    job: Job,
    unit: LocalComposeUnit,
  ) => import("../local-network").LocalNetworkPlan;
  const owned = getPlan.call(adapter, job, unit);
  const guard = new LinuxNetworkGuard();
  guard.stopOwnedSync(owned);
  const ids = command("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${unit.composeProjectName}`,
  ])
    .split("\n")
    .filter(Boolean);
  if (ids.length) {
    const rows = JSON.parse(command("docker", ["inspect", ...ids])) as {
      Config: { Labels: Record<string, string> };
    }[];
    for (const row of rows)
      assert.equal(row.Config.Labels["tenkacloud.isolation.owner"], owned.owner);
    command("docker", ["rm", "-f", ...ids]);
  }
  const names = command("docker", ["network", "ls", "--format", "{{.Name}}"]);
  for (const segment of owned.segments) {
    const network = `${owned.project}_${segment.name}`;
    if (!names.split("\n").includes(network)) continue;
    const rows = JSON.parse(command("docker", ["network", "inspect", network]));
    assert.equal(rows[0].Labels["tenkacloud.isolation.owner"], owned.owner);
    assert.equal(Object.keys(rows[0].Containers ?? {}).length, 0);
    command("docker", ["network", "rm", network]);
  }
  guard.remove(owned);
}
function cleanupNamespaceResources(attempt: (work: () => void) => void): void {
  const presentNamespaces = command("ip", ["netns", "list"])
    .split("\n")
    .map((line) => line.split(" ")[0]);
  for (const namespace of [...namespaces, ...extraNamespaces])
    if (presentNamespaces.includes(namespace))
      attempt(() => {
        for (const pid of command("ip", ["netns", "pids", namespace]).split("\n").filter(Boolean))
          process.kill(Number(pid), "SIGKILL");
        command("ip", ["netns", "delete", namespace]);
      });
  const presentLinks = JSON.parse(command("ip", ["-j", "link"])) as { ifname: string }[];
  for (const link of [iface, ...roots])
    if (presentLinks.some((item) => item.ifname === link))
      attempt(() => {
        command("ip", ["link", "delete", link]);
      });
}
function cleanupUdpGuard(attempt: (work: () => void) => void): void {
  if (command("iptables", ["-S"]).split("\n").includes(`-N ${udpChain}`))
    attempt(() => {
      const input = command("iptables", ["-S", "INPUT"]);
      if (input.includes(`-j ${udpChain}`))
        command("iptables", [
          "-D",
          "INPUT",
          "-p",
          "udp",
          "--dport",
          String(udpPort),
          "-j",
          udpChain,
        ]);
      command("iptables", ["-F", udpChain]);
      command("iptables", ["-X", udpChain]);
    });
  if (command("ip6tables", ["-S", "INPUT"]).includes("tc-vpn-acceptance-udp"))
    attempt(() => {
      command("ip6tables", [
        "-D",
        "INPUT",
        "-p",
        "udp",
        "--dport",
        String(udpPort),
        "-m",
        "comment",
        "--comment",
        "tc-vpn-acceptance-udp",
        "-j",
        "DROP",
      ]);
    });
}
function cleanupUdpStrict(): void {
  cleanupUdpGuard((work) => work());
}
function cleanupDetached(work: () => void): void {
  afterAcceptanceTransportRemoved(
    () => JSON.parse(command("ip", ["-j", "link"])) as { ifname: string }[],
    work,
  );
}
function cleanupUnits(directory: string): void {
  cleanupAcceptanceUnits(directory, {
    run: command,
    exists: existsSync,
    read: (path) => readFileSync(path, "utf8"),
    remove: (path) => rmSync(path),
  });
}
/** Independent always-step recovery uses only the root-created ownership journal. */
async function cleanupSaved(): Promise<void> {
  const errors: unknown[] = [];
  for (const name of readdirSync("/run")) {
    if (!/^tc-vpn-acceptance-[A-Za-z0-9]+$/u.test(name)) continue;
    const directory = join("/run", name);
    const path = join(directory, "journal.json");
    if (!existsSync(path)) continue;
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      registration?: unknown;
      root: string;
      jobs: Job[];
    };
    assert.match(saved.root, /^\/tmp\/tenkacloud-network-lab-[A-Za-z0-9]+$/u);
    const attempt = (work: () => void) => {
      try {
        work();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const job of saved.jobs) attempt(() => cleanupSavedJob(saved.root, job));
    attempt(() => cleanupUnits(directory));
    cleanupNamespaceResources(attempt);
    attempt(() =>
      cleanupDetached(() => {
        if (saved.registration) cleanupPolicy(vpnPeerPlan(saved.registration));
        cleanupUdpGuard(attempt);
        cleanupCanaryGuard();
      }),
    );
    if (!errors.length) {
      rmSync(saved.root, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (errors.length) throw new AggregateError(errors, "Independent owned VPN cleanup failed.");
  console.log(JSON.stringify({ cleanup: "OWNED_VPN_LAB_ABSENT" }));
}
if (import.meta.main) {
  if (process.argv[2] === "--cleanup") {
    scope(false);
    await cleanupSaved();
  } else if (process.argv[2] === "--peer-terminal") {
    scope(false);
    await peerTerminal(requiredNetworkValue(process.argv[3]));
  } else if (process.env.TENKACLOUD_VPN_WRITER_SNAPSHOT) {
    scope(false);
    await crashWriter();
  } else await main();
}
