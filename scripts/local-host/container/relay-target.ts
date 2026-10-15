import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { LinuxNetworkGuard } from "../linux-network-guard";
import type { LocalNetworkPlan } from "../local-network";

export interface RelayBinding {
  readonly service: string;
  readonly hostPort: number;
  readonly port: number;
  readonly networks: readonly string[];
}
export interface RelayRequest {
  readonly project: string;
  readonly binding: RelayBinding;
  readonly plan?: LocalNetworkPlan;
}
export interface RelayTarget {
  readonly host: string;
  readonly port: number;
  readonly identity: string;
}
interface RelayIO {
  run(command: string, args: readonly string[]): string;
  daemon(): string;
  verify(plan: LocalNetworkPlan): void;
}
const nativeIO: RelayIO = {
  run: (command, args) =>
    execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  daemon: () => {
    if (
      process.platform !== "linux" ||
      (process.env.DOCKER_HOST && process.env.DOCKER_HOST !== "unix:///var/run/docker.sock")
    )
      throw new Error("Internal transports require a native local Linux Docker Engine.");
    const socket = statSync("/var/run/docker.sock");
    const pid = readFileSync("/var/run/docker.pid", "utf8").trim();
    if (
      !socket.isSocket() ||
      socket.uid !== 0 ||
      !/^[1-9]\d*$/u.test(pid) ||
      readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "dockerd" ||
      readlinkSync(`/proc/${pid}/ns/net`) !== readlinkSync("/proc/self/ns/net")
    )
      throw new Error("Unverified local Docker daemon namespace.");
    const info = JSON.parse(nativeIO.run("docker", ["info", "--format", "{{json .}}"]));
    if (
      info.OSType !== "linux" ||
      !/^28\.4\.\d+$/u.test(info.ServerVersion) ||
      /desktop/iu.test(info.OperatingSystem) ||
      !Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some((value: unknown) => /rootless/iu.test(String(value)))
    )
      throw new Error("Internal transports require native rootful Docker Engine 28.4.x.");
    const startTime = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[19];
    if (!startTime || !info.ID) throw new Error("Missing Docker daemon identity.");
    return `${pid}:${startTime}:${socket.ino}:${info.ID}`;
  },
  verify: (plan) => new LinuxNetworkGuard().verifyNetworks(plan),
};
/** Worker-only inventory. No browser-supplied address, port, container ID or network is accepted. */
export function resolveRelayTarget(
  request: RelayRequest,
  expected?: RelayTarget,
  io: RelayIO = nativeIO,
): RelayTarget {
  const daemon = io.daemon();
  if (request.plan) io.verify(request.plan);
  const container = relayContainer(request, io);
  const { host, identities } = relayAddresses(request, container, io);
  const target = {
    host,
    port: request.binding.port,
    identity: JSON.stringify([daemon, container.Id, identities]),
  };
  if (expected && JSON.stringify(target) !== JSON.stringify(expected))
    throw new Error("Internal service generation changed.");
  return target;
}

function relayContainer(request: RelayRequest, io: RelayIO) {
  const { binding, project } = request;
  if (
    !/^[a-z0-9][a-z0-9_-]+$/u.test(project) ||
    !/^[a-zA-Z0-9_-]+$/u.test(binding.service) ||
    !Number.isInteger(binding.port) ||
    binding.port < 1 ||
    binding.port > 65535 ||
    !binding.networks.length
  )
    throw new Error("Invalid internal transport declaration.");
  const ids = io
    .run("docker", [
      "ps",
      "--no-trunc",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${binding.service}`,
    ])
    .split(/\s+/u);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0] ?? ""))
    throw new Error("Internal service instance is not unique.");
  const rows = JSON.parse(io.run("docker", ["inspect", ids[0] as string]));
  const container = rows[0];
  if (
    rows.length !== 1 ||
    container.Id !== ids[0] ||
    container.State?.Running !== true ||
    container.Config?.Labels?.["com.docker.compose.project"] !== project ||
    container.Config?.Labels?.["com.docker.compose.service"] !== binding.service ||
    container.HostConfig?.Privileged !== false ||
    container.HostConfig?.NetworkMode === "host" ||
    (container.HostConfig?.CapAdd ?? []).length
  )
    throw new Error("Internal service ownership changed.");
  return container;
}

function relayAddresses(
  request: RelayRequest,
  container: ReturnType<typeof relayContainer>,
  io: RelayIO,
) {
  const { binding, project } = request;
  const attachments = container.NetworkSettings?.Networks ?? {};
  const names = binding.networks
    .map((name) => `${project}_${name}`)
    .sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(Object.keys(attachments).sort((left, right) => left.localeCompare(right))) !==
    JSON.stringify(names)
  )
    throw new Error("Internal service network attachments changed.");
  const networks = JSON.parse(io.run("docker", ["network", "inspect", ...names]));
  if (networks.length !== names.length) throw new Error("Missing internal network.");
  const identities: string[] = [];
  let host: string | undefined;
  for (const name of names) {
    const network = networks.find((value: { Name: string }) => value.Name === name);
    const endpoint = attachments[name];
    if (
      !network ||
      !/^[a-f0-9]{64}$/u.test(network.Id) ||
      network.Internal !== true ||
      network.Driver !== "bridge" ||
      network.Labels?.["com.docker.compose.project"] !== project ||
      endpoint.NetworkID !== network.Id
    )
      throw new Error("Internal network ownership changed.");
    const address = relayAddress(network, endpoint.IPAddress, io);
    identities.push(`${name}:${network.Id}:${address}`);
    host ??= address;
  }
  if (!host) throw new Error("Internal service has no address.");
  return { host, identities };
}

interface RelayNetwork {
  Id: string;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
  Options?: Record<string, string>;
}
function relayAddress(network: RelayNetwork, address: string, io: RelayIO): string {
  const allowed = new BlockList();
  for (const config of network.IPAM?.Config ?? []) {
    if (typeof config.Subnet !== "string" || config.Subnet.includes(":")) continue;
    const [base, prefix] = config.Subnet.split("/");
    if (!base || prefix === undefined) throw new Error("Invalid internal network subnet.");
    allowed.addSubnet(base, Number(prefix), "ipv4");
    if (address === config.Gateway) throw new Error("Internal service resolved to a gateway.");
  }
  if (isIP(address) !== 4 || !allowed.check(address, "ipv4"))
    throw new Error("Invalid internal service address.");
  const bridge =
    network.Options?.["com.docker.network.bridge.name"] || `br-${network.Id.slice(0, 12)}`;
  const routes = JSON.parse(io.run("ip", ["-j", "route", "get", address]));
  if (routes.length !== 1 || routes[0].dev !== bridge || routes[0].gateway)
    throw new Error("Internal service route leaves its owned bridge.");
  return address;
}
