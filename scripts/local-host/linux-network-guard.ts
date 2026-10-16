import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import {
  type LocalNetworkPlan,
  type LocalPublicEndpoint,
  requiredNetworkValue,
  segmentGateway,
} from "./local-network";
import {
  auditNetwork,
  emergencyNetwork,
  installNetwork,
  networkEndpoints,
  publishNetwork,
  removeNetwork,
  stopNetwork,
} from "./network-audit";
import { withNetworkHookLock } from "./network-hook-lock";
import { vpnAdmissionHook, vpnSealHook, workloadQuarantineHook } from "./vpn/firewall-scope";

export interface LocalNetworkGuard {
  preflight(): void;
  install(plan: LocalNetworkPlan): void;
  verify(plan: LocalNetworkPlan): void;
  verifyNetworks(plan: LocalNetworkPlan): void;
  remove(plan: LocalNetworkPlan): void;
  /** Host routes, minus the bridge routes that `owned` itself creates inside its subnets. */
  occupiedRoutes(owned?: LocalNetworkPlan): readonly string[];
  update(plan: LocalNetworkPlan, previous: LocalNetworkPlan): void;
  endpoints(plan: LocalNetworkPlan, service: string, port: number): readonly LocalPublicEndpoint[];
  routePublications(plan: LocalNetworkPlan): void;
  resetStopped(plan: LocalNetworkPlan): void;
  quarantine(plan: LocalNetworkPlan): void;
  stopOwned(plan: LocalNetworkPlan): Promise<void>;
  installAsync?(plan: LocalNetworkPlan): Promise<void>;
  removeAsync?(plan: LocalNetworkPlan): Promise<void>;
  audit?(plan: LocalNetworkPlan): Promise<void>;
  quarantineAsync?(plan: LocalNetworkPlan): Promise<void>;
  resetStoppedAsync?(plan: LocalNetworkPlan): Promise<void>;
  publishAsync?(plan: LocalNetworkPlan, previous: LocalNetworkPlan): Promise<void>;
  endpointsAsync?(
    plan: LocalNetworkPlan,
    service: string,
    port: number,
  ): Promise<readonly LocalPublicEndpoint[]>;
}
interface GuardCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
}
interface GuardIO {
  readonly run: (command: GuardCommand) => string;
  readonly read: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly link: (path: string) => string;
  readonly platform: string;
  readonly dockerHost?: string;
  readonly socketOwned?: () => boolean;
}
const nativeIO: GuardIO = {
  platform: process.platform,
  dockerHost: process.env.DOCKER_HOST,
  socketOwned: () => {
    const socket = statSync("/var/run/docker.sock");
    return socket.isSocket() && socket.uid === 0;
  },
  read: (path) => readFileSync(path, "utf8"),
  exists: existsSync,
  link: readlinkSync,
  run: ({ command, args, input }) => {
    try {
      return execFileSync(command, [...args], {
        input,
        encoding: "utf8",
        timeout: 15_000,
        env:
          command === "docker"
            ? { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "" }
            : process.env,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      throw new Error(
        `Competition network ${command} operation failed; no unrestricted fallback is available.`,
      );
    }
  },
};
type Rule = readonly string[];
const OWNED_SANDBOX = /^\/var\/run\/docker\/netns\/[a-f0-9]{12,64}$/u;
interface OwnedContainer {
  readonly Id: string;
  readonly Config?: { Labels?: Record<string, string> };
  readonly HostConfig?: { Privileged?: boolean; NetworkMode?: string; CapAdd?: string[] };
  readonly State?: { Running?: boolean; Pid?: number };
  readonly NetworkSettings: {
    readonly SandboxKey: string;
    readonly Networks: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
  };
}
interface VpnReplyRoute {
  readonly sandbox: string;
  readonly destination: string;
  readonly gateway: string;
  readonly device: string;
  readonly ipv6: boolean;
}

function inputRules(plan: LocalNetworkPlan, ipv6: boolean): Rule[] {
  const rules: Rule[] = [
    ["-m", "comment", "--comment", plan.owner],
    ...plan.segments.map((segment) => [
      "-i",
      segment.bridge,
      "-s",
      segmentGateway(segment, ipv6),
      "-j",
      "DROP",
    ]),
  ];
  for (const segment of plan.segments) {
    const subnet = ipv6 ? segment.ipv6 : segment.ipv4;
    // Both trusted ingress and the ORIGINAL connection's reply source are bound
    // to this segment. A reply tuple from another team's bridge is not sufficient.
    rules.push([
      "-i",
      segment.bridge,
      "-s",
      subnet,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED",
      "--ctdir",
      "REPLY",
      "--ctreplsrc",
      subnet,
      "-j",
      "ACCEPT",
    ]);
    if (ipv6)
      for (const type of ["135", "136"])
        rules.push([
          "-i",
          segment.bridge,
          "-p",
          "ipv6-icmp",
          "-m",
          "icmp6",
          "--icmpv6-type",
          type,
          "-m",
          "hl",
          "--hl-eq",
          "255",
          "-j",
          "ACCEPT",
        ]);
  }
  return [...rules, ["-j", "DROP"]];
}
function forwardRules(plan: LocalNetworkPlan, ipv6: boolean): Rule[] {
  const rules: Rule[] = [
    ["-m", "comment", "--comment", plan.owner],
    ...plan.segments.map((segment) => [
      "-m",
      "conntrack",
      "--ctorigdst",
      segmentGateway(segment, ipv6),
      "-j",
      "DROP",
    ]),
    ...(ipv6
      ? plan.segments.flatMap((segment) =>
          ["135", "136"].map((type) => [
            "-i",
            segment.bridge,
            "-o",
            segment.bridge,
            "-p",
            "ipv6-icmp",
            "-m",
            "icmp6",
            "--icmpv6-type",
            type,
            "-m",
            "hl",
            "--hl-eq",
            "255",
            "-j",
            "ACCEPT",
          ]),
        )
      : []),
    ...plan.segments.flatMap((from) =>
      plan.segments.flatMap((to) => [
        [
          "-i",
          from.bridge,
          "-o",
          to.bridge,
          "-m",
          "conntrack",
          "--ctdir",
          "ORIGINAL",
          "--ctorigsrc",
          ipv6 ? from.ipv6 : from.ipv4,
          "--ctorigdst",
          ipv6 ? to.ipv6 : to.ipv4,
          "-j",
          "ACCEPT",
        ],
        [
          "-i",
          to.bridge,
          "-o",
          from.bridge,
          "-m",
          "conntrack",
          "--ctdir",
          "REPLY",
          "--ctstate",
          "ESTABLISHED",
          "--ctorigsrc",
          ipv6 ? from.ipv6 : from.ipv4,
          "--ctorigdst",
          ipv6 ? to.ipv6 : to.ipv4,
          "-j",
          "ACCEPT",
        ],
      ]),
    ),
  ];
  for (const route of plan.publicRoutes.filter((entry) => isIP(entry.address) === (ipv6 ? 6 : 4))) {
    const subnet = ipv6 ? route.from.ipv6 : route.from.ipv4;
    const address = `${route.address}/${ipv6 ? 128 : 32}`;
    rules.push([
      "-i",
      route.from.bridge,
      "-o",
      route.to.bridge,
      "-s",
      subnet,
      "-d",
      address,
      "-p",
      "tcp",
      "-m",
      "tcp",
      "--dport",
      String(route.port),
      "-m",
      "conntrack",
      "--ctdir",
      "ORIGINAL",
      "--ctorigsrc",
      subnet,
      "--ctorigdst",
      address,
      "--ctorigdstport",
      String(route.port),
      "-j",
      "ACCEPT",
    ]);
    rules.push([
      "-i",
      route.to.bridge,
      "-o",
      route.from.bridge,
      "-s",
      address,
      "-d",
      subnet,
      "-p",
      "tcp",
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED",
      "--ctdir",
      "REPLY",
      "--ctorigsrc",
      subnet,
      "--ctorigdst",
      address,
      "--ctorigdstport",
      String(route.port),
      "--ctreplsrc",
      address,
      "--ctrepldst",
      subnet,
      "-j",
      "ACCEPT",
    ]);
  }
  return [...rules, ["-j", "DROP"]];
}
function hooks(plan: LocalNetworkPlan, ipv6: boolean): { parent: string; rule: Rule }[] {
  const parent = ipv6 ? "FORWARD" : "DOCKER-USER";
  return plan.segments.flatMap((segment) => [
    { parent: "INPUT", rule: ["-i", segment.bridge, "-j", plan.inputChain] },
    { parent, rule: ["-i", segment.bridge, "-j", plan.forwardChain] },
    { parent, rule: ["-o", segment.bridge, "-j", plan.forwardChain] },
  ]);
}
function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}
function ownedHook(line: string): boolean {
  if (vpnAdmissionHook(line)) return true;
  return /^-A (INPUT|FORWARD|DOCKER-USER) -[io] tci[a-f0-9]{12} -j TCI_[a-f0-9]{16}_[IF]$/u.test(
    line,
  );
}

/** Native Linux only. Never sudo, load modules, change sysctls or alter daemon configuration. */
export class LinuxNetworkGuard implements LocalNetworkGuard {
  constructor(private readonly io: GuardIO = nativeIO) {}
  private command(command: string, args: readonly string[], input?: string): string {
    return this.io.run({ command, args, ...(input !== undefined ? { input } : {}) });
  }
  private firewall(ipv6: boolean, args: readonly string[]): string {
    return this.command(ipv6 ? "ip6tables" : "iptables", ["--wait", "5", ...args]);
  }
  private assertDaemon(): void {
    if (
      this.io.platform !== "linux" ||
      (this.io.dockerHost && this.io.dockerHost !== "unix:///var/run/docker.sock")
    )
      throw new Error(
        "Competition networking requires a native local Linux Docker Engine and host firewall privileges.",
      );
    const endpoint = this.command("docker", [
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
    if (
      endpoint !== "unix:///var/run/docker.sock" ||
      (this.io.socketOwned && !this.io.socketOwned())
    )
      throw new Error("Remote Docker is not supported for competition networking.");
    const pid = this.io.read("/var/run/docker.pid").trim();
    if (
      !/^[1-9]\d{0,9}$/u.test(pid) ||
      this.io.read(`/proc/${pid}/comm`).trim() !== "dockerd" ||
      this.io.link(`/proc/${pid}/ns/net`) !== this.io.link("/proc/self/ns/net")
    )
      throw new Error(
        "The controller and local Docker daemon must share the verified host network namespace.",
      );
    const info = JSON.parse(this.command("docker", ["info", "--format", "{{json .}}"]));
    if (
      info.OSType !== "linux" ||
      !/^28\.4\.\d+$/u.test(String(info.ServerVersion)) ||
      /desktop/iu.test(String(info.OperatingSystem)) ||
      !Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some((entry: unknown) => /rootless/iu.test(String(entry)))
    )
      throw new Error(
        "Competition networking currently supports native, rootful Linux Docker Engine 28.4.x only.",
      );
  }
  preflight(): void {
    this.assertDaemon();
    for (const path of [
      "/proc/sys/net/bridge/bridge-nf-call-iptables",
      "/proc/sys/net/bridge/bridge-nf-call-ip6tables",
    ])
      if (this.io.read(path).trim() !== "1")
        throw new Error(
          "Both bridge netfilter families must already be enabled; configuration was not changed.",
        );
    const forward = lines(this.firewall(false, ["-S", "FORWARD"])).filter((line) =>
      line.startsWith("-A "),
    );
    if (forward[this.quarantinePrefix("FORWARD", false)] !== "-A FORWARD -j DOCKER-USER")
      throw new Error(
        "Docker's verified DOCKER-USER admission hook must precede all forwarding rules.",
      );
    this.firewall(false, ["-S", "DOCKER-USER"]);
    this.firewall(true, ["-S", "FORWARD"]);
  }
  occupiedRoutes(owned?: LocalNetworkPlan): readonly string[] {
    const result: string[] = [];
    for (const ipv6 of [false, true]) {
      const rows: unknown = JSON.parse(
        this.command("ip", ["-j", ...(ipv6 ? ["-6"] : []), "route", "show", "table", "all"]),
      );
      if (!Array.isArray(rows) || rows.length > 16384)
        throw new Error("Invalid host route inventory.");
      result.push(...routeDestinations(rows, ipv6, owned?.segments ?? []));
    }
    return result;
  }
  private networkNames(): string[] {
    return lines(this.command("docker", ["network", "ls", "--format", "{{.Name}}"]));
  }
  private assertOwnership(plan: LocalNetworkPlan, requirePresent: boolean): void {
    const names = new Set(this.networkNames());
    for (const segment of plan.segments) {
      const name = `${plan.project}_${segment.name}`;
      const path = `/sys/class/net/${segment.bridge}/bridge`;
      if (!names.has(name)) {
        if (requirePresent || this.io.exists(path))
          throw new Error("Competition bridge is missing or belongs to another runtime.");
        continue;
      }
      const rows = JSON.parse(this.command("docker", ["network", "inspect", name]));
      const network = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
      this.assertNetwork(network, plan, segment, path);
    }
  }
  private assertNetwork(
    network:
      | {
          Driver?: string;
          Internal?: boolean;
          EnableIPv6?: boolean;
          Options?: Record<string, string>;
          Labels?: Record<string, string>;
          IPAM?: { Config?: { Subnet?: string }[] };
        }
      | undefined,
    plan: LocalNetworkPlan,
    segment: LocalNetworkPlan["segments"][number],
    path: string,
  ): void {
    if (
      network?.Driver !== "bridge" ||
      network.Internal !== true ||
      network.EnableIPv6 !== true ||
      network.Options?.["com.docker.network.bridge.name"] !== segment.bridge ||
      network.Labels?.["com.docker.compose.project"] !== plan.project ||
      network.Labels?.["tenkacloud.isolation.owner"] !== plan.owner ||
      !this.io.exists(path) ||
      !Array.isArray(network.IPAM?.Config) ||
      network.IPAM.Config.length !== 2 ||
      !network.IPAM.Config.some((entry: { Subnet?: string }) => entry.Subnet === segment.ipv4) ||
      !network.IPAM.Config.some((entry: { Subnet?: string }) => entry.Subnet === segment.ipv6)
    )
      throw new Error("Actual competition network does not match its pinned owned plan.");
  }
  install(plan: LocalNetworkPlan): void {
    this.preflight();
    this.assertOwnership(plan, false);
    for (const ipv6 of [false, true]) {
      const inventory = lines(this.firewall(ipv6, ["-S"]));
      if (
        inventory.includes(`-N ${plan.inputChain}`) ||
        inventory.includes(`-N ${plan.forwardChain}`)
      ) {
        this.repairStoppedHooks(plan, ipv6);
        continue;
      }
      if (
        this.command("docker", [
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${plan.project}`,
        ]).trim()
      )
        throw new Error(
          "A running unguarded workload must be halted before installing competition rules.",
        );
      withNetworkHookLock(() => {
        const body = [
          "*filter",
          `:${plan.inputChain} - [0:0]`,
          `:${plan.forwardChain} - [0:0]`,
          ...inputRules(plan, ipv6).map((rule) => `-A ${plan.inputChain} ${rule.join(" ")}`),
          ...forwardRules(plan, ipv6).map((rule) => `-A ${plan.forwardChain} ${rule.join(" ")}`),
          ...hooks(plan, ipv6).map((hook) =>
            this.hookInsertion(plan, ipv6, hook.parent, hook.rule),
          ),
          "COMMIT",
          "",
        ].join("\n");
        this.command(
          ipv6 ? "ip6tables-restore" : "iptables-restore",
          ["--wait", "5", "--noflush"],
          body,
        );
      });
      this.verifyFamily(plan, ipv6);
    }
  }
  private repairStoppedHooks(plan: LocalNetworkPlan, ipv6: boolean): void {
    this.verifyBodies(plan, ipv6);
    try {
      this.verifyFamily(plan, ipv6);
    } catch (error) {
      if (
        this.command("docker", [
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${plan.project}`,
        ]).trim()
      )
        throw error;
      withNetworkHookLock(() => {
        const missing = hooks(plan, ipv6).filter(
          ({ parent, rule }) =>
            !lines(this.firewall(ipv6, ["-S", parent])).includes(`-A ${parent} ${rule.join(" ")}`),
        );
        if (!missing.length) throw error;
        const body = [
          "*filter",
          ...missing.map(({ parent, rule }) => this.hookInsertion(plan, ipv6, parent, rule)),
          "COMMIT",
          "",
        ].join("\n");
        this.command(
          ipv6 ? "ip6tables-restore" : "iptables-restore",
          ["--wait", "5", "--noflush"],
          body,
        );
      });
      this.verifyFamily(plan, ipv6);
    }
  }
  private verifyBodies(plan: LocalNetworkPlan, ipv6: boolean): void {
    for (const [chain, rules] of [
      [plan.inputChain, inputRules(plan, ipv6)],
      [plan.forwardChain, forwardRules(plan, ipv6)],
    ] as const) {
      const actual = lines(this.firewall(ipv6, ["-S", chain])).filter((line) =>
        line.startsWith("-A "),
      );
      if (actual.length !== rules.length || actual.at(-1) !== `-A ${chain} -j DROP`)
        throw new Error("Competition guard changed; runtime admission is refused.");
      if (
        actual.some(
          (line, index) =>
            ruleFingerprint(line.split(" ").slice(2).join(" ")) !==
            ruleFingerprint(rules[index]?.join(" ") ?? ""),
        )
      )
        throw new Error("Competition guard rule order changed; runtime admission is refused.");
      for (const rule of rules) this.firewall(ipv6, ["-C", chain, ...rule]);
    }
  }
  private verifyFamily(plan: LocalNetworkPlan, ipv6: boolean): void {
    this.verifyBodies(plan, ipv6);
    for (const { parent, rule } of hooks(plan, ipv6)) {
      this.firewall(ipv6, ["-C", parent, ...rule]);
      const actual = lines(this.firewall(ipv6, ["-S", parent])).filter((line) =>
        line.startsWith("-A "),
      );
      this.quarantinePrefix(parent, ipv6);
      const position = actual.indexOf(`-A ${parent} ${rule.join(" ")}`);
      if (
        position < 0 ||
        actual.slice(0, position).some((line) => !ownedHook(line) && !isQuarantineHook(line))
      )
        throw new Error("Competition guard no longer precedes other host rules.");
    }
  }
  verify(plan: LocalNetworkPlan): void {
    this.preflight();
    for (const ipv6 of [false, true]) this.verifyFamily(plan, ipv6);
  }
  verifyNetworks(plan: LocalNetworkPlan): void {
    this.verify(plan);
    this.assertNoQuarantine(plan);
    this.verifyNetworkInventory(plan);
  }
  private assertNoQuarantine(plan: LocalNetworkPlan): void {
    const marker = plan.owner.replace("tc-isolation-v1:", "tc-quarantine-v1:");
    for (const ipv6 of [false, true])
      for (const parent of ["INPUT", "FORWARD"])
        if (lines(this.firewall(ipv6, ["-S", parent])).some((line) => line.includes(marker)))
          throw new Error("Owned runtime remains quarantined; stopped recovery is required.");
  }
  private verifyNetworkInventory(plan: LocalNetworkPlan): void {
    this.assertOwnership(plan, true);
    const ids = lines(
      this.command("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]),
    );
    if (ids.length > 256 || ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
      throw new Error("Invalid competition container inventory.");
    if (!ids.length && Object.keys(plan.services).length)
      throw new Error("Competition workloads are missing.");
    const containers = this.verifyContainers(plan, ids);
    const attached = new Set(containers.map((container) => container.Id));
    for (const segment of plan.segments) {
      const rows = JSON.parse(
        this.command("docker", ["network", "inspect", `${plan.project}_${segment.name}`]),
      );
      if (Object.keys(rows[0]?.Containers ?? {}).some((id) => !attached.has(id)))
        throw new Error("Competition network has an unowned endpoint.");
    }
    this.verifyPublicTargets(plan);
    this.verifyPublicationRoutes(plan, containers);
  }
  private verifyContainers(plan: LocalNetworkPlan, ids: string[]): OwnedContainer[] {
    if (!ids.length) return [];
    const containers = JSON.parse(this.command("docker", ["inspect", ...ids]));
    if (!Array.isArray(containers) || containers.length !== ids.length)
      throw new Error("Invalid competition workload inspection.");
    const services = new Set<string>();
    for (const container of containers)
      services.add(this.verifyContainer(plan, container, services));
    if (services.size !== Object.keys(plan.services).length)
      throw new Error("Declared competition service is missing.");
    return containers;
  }
  /** Docker drops these routes whenever it recreates a namespace, so every audit re-reads them. */
  private verifyPublicationRoutes(
    plan: LocalNetworkPlan,
    containers: readonly OwnedContainer[],
  ): void {
    for (const container of containers) {
      if (container.State?.Running !== true) continue;
      const expected = containerRouteTargets(plan, container.NetworkSettings.Networks).map(
        (target) =>
          `${canonicalPrefix(target.destination)} via ${canonicalAddress(segmentGateway(target.segment, target.ipv6))}`,
      );
      if (!expected.length) continue;
      const sandbox = container.NetworkSettings.SandboxKey;
      if (!OWNED_SANDBOX.test(sandbox))
        throw new Error("Public route requires the verified owned runtime network namespace.");
      const actual = new Set([false, true].flatMap((ipv6) => this.namespaceRoutes(sandbox, ipv6)));
      if (expected.some((entry) => !actual.has(entry)))
        throw new Error("Published DMZ route is missing from an owned workload namespace.");
    }
  }
  private namespaceRoutes(sandbox: string, ipv6: boolean): string[] {
    const rows: unknown = JSON.parse(
      this.command("nsenter", [
        `--net=${sandbox}`,
        "ip",
        ...(ipv6 ? ["-6"] : []),
        "-j",
        "route",
        "show",
      ]),
    );
    if (!Array.isArray(rows) || rows.length > 16384)
      throw new Error("Invalid workload route inventory.");
    return rows.flatMap((row: { dst?: unknown; gateway?: unknown } | null) =>
      typeof row?.dst === "string" && typeof row.gateway === "string"
        ? [`${canonicalPrefix(row.dst)} via ${canonicalAddress(row.gateway)}`]
        : [],
    );
  }
  private verifyContainer(
    plan: LocalNetworkPlan,
    container: {
      Config?: { Labels?: Record<string, string> };
      Id: string;
      HostConfig?: { Privileged?: boolean; NetworkMode?: string; CapAdd?: string[] };
      NetworkSettings?: { Networks?: Record<string, unknown> };
    },
    services: Set<string>,
  ): string {
    const labels = container.Config?.Labels;
    const service = labels?.["com.docker.compose.service"];
    const expected =
      typeof service === "string" && Object.hasOwn(plan.services, service)
        ? plan.services[service]
        : undefined;
    const networks = container.NetworkSettings?.Networks;
    if (
      !expected ||
      services.has(service ?? "") ||
      labels?.["com.docker.compose.project"] !== plan.project ||
      labels?.["tenkacloud.isolation.owner"] !== plan.owner ||
      labels?.["tenkacloud.isolation.generation"] !== plan.generation ||
      container.HostConfig?.Privileged !== false ||
      container.HostConfig?.NetworkMode === "host" ||
      (container.HostConfig?.CapAdd?.length ?? 0) !== 0 ||
      !networks ||
      JSON.stringify(Object.keys(networks).sort((a, b) => a.localeCompare(b))) !==
        JSON.stringify(
          expected.map((name) => `${plan.project}_${name}`).sort((a, b) => a.localeCompare(b)),
        )
    )
      throw new Error("Competition workload ownership, generation or attachments changed.");
    return requiredNetworkValue(service);
  }
  private verifyPublicTargets(plan: LocalNetworkPlan): void {
    for (const route of plan.publicRoutes) {
      const rows = JSON.parse(
        this.command("docker", [
          "network",
          "inspect",
          `${route.publisherProject}_${route.to.name}`,
        ]),
      );
      if (
        rows.length !== 1 ||
        rows[0].Labels?.["tenkacloud.isolation.owner"] !== route.publisherOwner ||
        rows[0].Options?.["com.docker.network.bridge.name"] !== route.to.bridge
      )
        throw new Error("DMZ publisher's network ownership changed; stale permission is refused.");
      if (!Object.keys(rows[0].Containers ?? {}).length)
        throw new Error("DMZ service endpoint is missing.");
      const endpoints = JSON.parse(
        this.command("docker", ["inspect", ...Object.keys(rows[0].Containers ?? {})]),
      );
      if (
        !endpoints.some(
          (container: {
            Config?: { Labels?: Record<string, string> };
            NetworkSettings?: {
              Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
            };
          }) =>
            container.Config?.Labels?.["com.docker.compose.service"] === route.service &&
            container.Config?.Labels?.["tenkacloud.isolation.owner"] === route.publisherOwner &&
            [
              container.NetworkSettings?.Networks?.[`${route.publisherProject}_${route.to.name}`]
                ?.IPAddress,
              container.NetworkSettings?.Networks?.[`${route.publisherProject}_${route.to.name}`]
                ?.GlobalIPv6Address,
            ].includes(route.address),
        )
      )
        throw new Error(
          "Retained DMZ address no longer belongs to the declared service; stale permission is refused.",
        );
      const sources = JSON.parse(
        this.command("docker", ["network", "inspect", `${route.fromProject}_${route.from.name}`]),
      );
      if (
        sources.length !== 1 ||
        sources[0].Labels?.["tenkacloud.isolation.owner"] !== route.fromOwner ||
        sources[0].Options?.["com.docker.network.bridge.name"] !== route.from.bridge
      )
        throw new Error("DMZ source network ownership changed; stale permission is refused.");
    }
  }
  update(plan: LocalNetworkPlan, previous: LocalNetworkPlan): void {
    if (
      plan.owner !== previous.owner ||
      plan.project !== previous.project ||
      plan.generation !== previous.generation
    )
      throw new Error("DMZ changes cannot replace a runtime's ownership or generation.");
    this.verifyNetworks(previous);
    for (const ipv6 of [false, true]) {
      const body = [
        "*filter",
        `-F ${plan.forwardChain}`,
        ...forwardRules(plan, ipv6).map((rule) => `-A ${plan.forwardChain} ${rule.join(" ")}`),
        "COMMIT",
        "",
      ].join("\n");
      this.command(
        ipv6 ? "ip6tables-restore" : "iptables-restore",
        ["--wait", "5", "--noflush"],
        body,
      );
      this.verifyFamily(plan, ipv6);
    }
  }
  endpoints(plan: LocalNetworkPlan, service: string, port: number): readonly LocalPublicEndpoint[] {
    if (!(service in plan.services) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid declared public service.");
    if (
      !Object.hasOwn(plan.services, service) ||
      requiredNetworkValue(plan.services[service]).length !== 1
    )
      throw new Error("A public service must attach to exactly one private network.");
    const ids = lines(
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]),
    );
    if (!ids.length) return [];
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(requiredNetworkValue(ids[0])))
      throw new Error("Invalid public service instance.");
    const container = JSON.parse(
      this.command("docker", ["inspect", requiredNetworkValue(ids[0])]),
    )[0];
    if (
      container.Config?.Labels?.["tenkacloud.isolation.owner"] !== plan.owner ||
      container.Config?.Labels?.["tenkacloud.isolation.generation"] !== plan.generation
    )
      throw new Error("Public service generation changed.");
    return plan.segments.flatMap((segment) => {
      const network = container.NetworkSettings?.Networks?.[`${plan.project}_${segment.name}`];
      if (!network) return [];
      const addresses = [network.IPAddress, network.GlobalIPv6Address].filter(
        (value: unknown): value is string => typeof value === "string" && isIP(value) !== 0,
      );
      return addresses.length ? [{ segment, addresses, port, service }] : [];
    });
  }
  private routeForContainer(plan: LocalNetworkPlan, sandbox: string, target: RouteTarget): void {
    const gateway = this.ownedGateway(plan, target.segment, target.ipv6);
    this.command("nsenter", [
      `--net=${sandbox}`,
      "ip",
      ...(target.ipv6 ? ["-6"] : []),
      "route",
      "replace",
      target.destination,
      "via",
      gateway,
    ]);
  }
  private ownedGateway(
    plan: LocalNetworkPlan,
    segment: LocalNetworkPlan["segments"][number],
    ipv6: boolean,
  ): string {
    const rows = JSON.parse(
      this.command("docker", ["network", "inspect", `${plan.project}_${segment.name}`]),
    );
    const subnet = ipv6 ? segment.ipv6 : segment.ipv4;
    const entry = rows[0]?.IPAM?.Config?.find(
      (item: { Subnet?: string }) => item.Subnet === subnet,
    );
    const actual = JSON.parse(this.command("ip", ["-j", "address", "show", "dev", segment.bridge]));
    const addresses = actual[0]?.addr_info?.filter(
      (item: { family?: string; prefixlen?: number; scope?: string }) =>
        item.scope === "global" &&
        item.family === (ipv6 ? "inet6" : "inet") &&
        item.prefixlen === Number(subnet.split("/")[1]),
    );
    const gateway = entry?.Gateway ?? (addresses?.length === 1 ? addresses[0].local : undefined);
    const block = new BlockList();
    block.addSubnet(
      subnet.split("/")[0] ?? "",
      Number(subnet.split("/")[1]),
      ipv6 ? "ipv6" : "ipv4",
    );
    if (
      isIP(gateway) !== (ipv6 ? 6 : 4) ||
      gateway !== segmentGateway(segment, ipv6) ||
      !block.check(gateway, ipv6 ? "ipv6" : "ipv4")
    )
      throw new Error("The owned DMZ route gateway is unavailable.");
    return gateway;
  }
  routePublications(plan: LocalNetworkPlan): void {
    if (!plan.publicRoutes.length) return;
    const ids = lines(
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]),
    );
    if (!ids.length) return;
    const containers = JSON.parse(this.command("docker", ["inspect", ...ids]));
    for (const container of containers) {
      const sandbox = container.NetworkSettings?.SandboxKey;
      if (
        container.Config?.Labels?.["tenkacloud.isolation.owner"] !== plan.owner ||
        typeof sandbox !== "string" ||
        !OWNED_SANDBOX.test(sandbox)
      )
        throw new Error("Public route requires the verified owned runtime network namespace.");
      for (const target of containerRouteTargets(plan, container.NetworkSettings.Networks))
        this.routeForContainer(plan, sandbox, target);
    }
  }
  /** Exact VPN return routes only, inside verified owned workload namespaces.
   * Internal-only bridges have no default route. Packet permissions remain in the VPN guard.
   */
  routeVpnReplies(plan: LocalNetworkPlan, addresses: readonly string[]): void {
    const destinations = [...new Set(addresses)];
    if (destinations.length > 200 || destinations.some((address) => isIP(address) === 0))
      throw new Error("Invalid bounded VPN reply destinations.");
    if (!destinations.length) return;
    this.verifyNetworks(plan);
    const ids = lines(
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]),
    );
    if (!ids.length || ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
      throw new Error("VPN reply workloads are unavailable.");
    const containers = JSON.parse(this.command("docker", ["inspect", ...ids])) as OwnedContainer[];
    if (!Array.isArray(containers) || containers.length !== ids.length)
      throw new Error("Invalid VPN reply workload inventory.");
    const services = new Set<string>();
    const routes = containers.flatMap((container) =>
      this.vpnReplyRoutes(plan, container, services, destinations),
    );
    if (services.size !== Object.keys(plan.services).length)
      throw new Error("VPN reply service inventory changed.");
    for (const route of routes) this.installVpnReplyRoute(route);
  }
  private vpnReplyRoutes(
    plan: LocalNetworkPlan,
    container: OwnedContainer,
    services: Set<string>,
    destinations: readonly string[],
  ): VpnReplyRoute[] {
    const service = this.verifyContainer(plan, container, services);
    services.add(service);
    // One route per destination, so replies leave through the first owned segment by name, as
    // publication routes do. A peer that targets another attachment gets no reply. The VPN REPLY
    // rules pair each bridge with its own subnet, so the misrouted reply falls to the final DROP.
    const segment = plan.segments
      .filter((entry) =>
        Object.hasOwn(container.NetworkSettings.Networks, `${plan.project}_${entry.name}`),
      )
      .reduce<LocalNetworkPlan["segments"][number] | undefined>(
        (first, entry) => (!first || entry.name < first.name ? entry : first),
        undefined,
      );
    const sandbox = container.NetworkSettings.SandboxKey;
    const pid = container.State?.Pid;
    if (
      !segment ||
      container.State?.Running !== true ||
      !Number.isSafeInteger(pid) ||
      Number(pid) < 1 ||
      !OWNED_SANDBOX.test(sandbox)
    )
      throw new Error("VPN reply namespace ownership changed.");
    const actualNamespace = this.command("nsenter", [
      `--net=${sandbox}`,
      "readlink",
      "/proc/self/ns/net",
    ]);
    if (
      actualNamespace === this.io.link("/proc/self/ns/net") ||
      actualNamespace !== this.io.link(`/proc/${pid}/ns/net`)
    )
      throw new Error("VPN reply namespace is not the owned workload namespace.");
    return destinations.map((address) => {
      const ipv6 = isIP(address) === 6;
      const gateway = this.ownedGateway(plan, segment, ipv6);
      const path = this.namespaceRoute(sandbox, ipv6, gateway);
      const endpoint = requiredNetworkValue(
        container.NetworkSettings.Networks[`${plan.project}_${segment.name}`],
      );
      if (
        path.gateway ||
        (path.prefsrc ?? path.src) !== (ipv6 ? endpoint.GlobalIPv6Address : endpoint.IPAddress) ||
        !/^[A-Za-z0-9_.:-]{1,15}$/u.test(path.dev ?? "")
      )
        throw new Error("VPN reply gateway is not directly attached to the owned endpoint.");
      return {
        sandbox,
        destination: `${address}/${ipv6 ? 128 : 32}`,
        gateway,
        device: requiredNetworkValue(path.dev),
        ipv6,
      };
    });
  }
  private namespaceRoute(
    sandbox: string,
    ipv6: boolean,
    address: string,
  ): { gateway?: string; dev?: string; prefsrc?: string; src?: string } {
    const rows = JSON.parse(
      this.command("nsenter", [
        `--net=${sandbox}`,
        "ip",
        ...(ipv6 ? ["-6"] : []),
        "-j",
        "route",
        "get",
        address,
      ]),
    );
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error("VPN reply route is ambiguous.");
    return rows[0];
  }
  private installVpnReplyRoute(route: VpnReplyRoute): void {
    this.command("nsenter", [
      `--net=${route.sandbox}`,
      "ip",
      ...(route.ipv6 ? ["-6"] : []),
      "route",
      "replace",
      route.destination,
      "via",
      route.gateway,
      "dev",
      route.device,
    ]);
    const observed = this.namespaceRoute(
      route.sandbox,
      route.ipv6,
      requiredNetworkValue(route.destination.split("/")[0]),
    );
    if (observed.gateway !== route.gateway || observed.dev !== route.device)
      throw new Error("VPN reply route readback did not match its owned gateway.");
  }
  private quarantinePrefix(parent: string, ipv6: boolean): number {
    const rules = lines(this.firewall(ipv6, ["-S", parent])).filter((line) =>
      line.startsWith("-A "),
    );
    const firstOther = rules.findIndex((line) => !isQuarantineHook(line));
    const count = firstOther < 0 ? rules.length : firstOther;
    if (rules.slice(count).some(isQuarantineHook))
      throw new Error("Quarantine no longer precedes admission rules.");
    return count;
  }
  private hookInsertion(
    _plan: LocalNetworkPlan,
    ipv6: boolean,
    parent: string,
    rule: Rule,
  ): string {
    const prefix = this.quarantinePrefix(parent, ipv6);
    const remainder = lines(this.firewall(ipv6, ["-S", parent]))
      .filter((line) => line.startsWith("-A "))
      .slice(prefix);
    const vpnPrefix = remainder.findIndex((line) => !vpnAdmissionHook(line));
    const count = vpnPrefix < 0 ? remainder.length : vpnPrefix;
    return `-I ${parent} ${prefix + count + 1} ${rule.join(" ")}`;
  }
  quarantine(plan: LocalNetworkPlan): void {
    withNetworkHookLock(() => this.quarantineLocked(plan));
  }
  private quarantineLocked(plan: LocalNetworkPlan): void {
    this.assertEmergencyScope(plan);
    const failures: unknown[] = [];
    for (const ipv6 of [false, true]) {
      try {
        const commands: string[] = [];
        for (const { parent, rule } of quarantineHooks(plan, ipv6)) {
          const existing = lines(this.firewall(ipv6, ["-S", parent]))
            .filter(isQuarantineHook)
            .some(
              (line) =>
                line.startsWith("-A ") &&
                ruleFingerprint(line.split(" ").slice(2).join(" ")) ===
                  ruleFingerprint(rule.join(" ")),
            );
          if (existing) commands.push(`-D ${parent} ${rule.join(" ")}`);
          commands.push(`-I ${parent} 1 ${rule.join(" ")}`);
        }
        this.command(
          ipv6 ? "ip6tables-restore" : "iptables-restore",
          ["--wait", "5", "--noflush"],
          ["*filter", ...commands, "COMMIT", ""].join("\n"),
        );
        this.verifyQuarantine(plan, ipv6);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Competition quarantine could not be confirmed in every family.",
      );
  }
  private assertEmergencyScope(plan: LocalNetworkPlan): void {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const identity = digest(`${plan.project}/${plan.generation}`);
    if (
      this.io.platform !== "linux" ||
      plan.version !== 1 ||
      !/^tch-[a-z0-9_-]{1,128}$/u.test(plan.project) ||
      !/^[a-f0-9]{64}$/u.test(plan.generation) ||
      plan.owner !== `tc-isolation-v1:${identity}` ||
      plan.inputChain !== `TCI_${identity.slice(0, 16)}_I` ||
      plan.forwardChain !== `TCI_${identity.slice(0, 16)}_F` ||
      !plan.segments.length ||
      plan.segments.some((segment) => {
        const expected = digest([plan.project, segment.name].join("/"));
        return segment.bridge !== `tci${expected.slice(0, 12)}`;
      })
    )
      throw new Error(
        "Emergency quarantine requires a validated controller ledger scope on Linux.",
      );
  }
  quarantineAsync(plan: LocalNetworkPlan): Promise<void> {
    return emergencyNetwork(plan, "quarantine");
  }
  resetStoppedAsync(plan: LocalNetworkPlan): Promise<void> {
    return emergencyNetwork(plan, "reset");
  }
  installAsync(plan: LocalNetworkPlan): Promise<void> {
    return installNetwork(plan);
  }
  removeAsync(plan: LocalNetworkPlan): Promise<void> {
    return removeNetwork(plan, (owned) => this.remove(owned));
  }
  audit(plan: LocalNetworkPlan): Promise<void> {
    return auditNetwork(plan);
  }
  publishAsync(plan: LocalNetworkPlan, previous: LocalNetworkPlan): Promise<void> {
    return publishNetwork(plan, previous);
  }
  endpointsAsync(
    plan: LocalNetworkPlan,
    service: string,
    port: number,
  ): Promise<readonly LocalPublicEndpoint[]> {
    return networkEndpoints(plan, service, port);
  }
  stopOwned(plan: LocalNetworkPlan): Promise<void> {
    return stopNetwork(plan);
  }
  stopOwnedSync(plan: LocalNetworkPlan): void {
    this.assertEmergencyScope(plan);
    const ids = lines(
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]),
    );
    if (ids.length > 256 || ids.some((id) => !/^[a-f0-9]{12,64}$/u.test(id)))
      throw new Error("Invalid owned shutdown inventory.");
    if (!ids.length) return;
    const containers = JSON.parse(this.command("docker", ["inspect", ...ids]));
    if (
      !Array.isArray(containers) ||
      containers.length !== ids.length ||
      containers.some(
        (container) =>
          container.Config?.Labels?.["com.docker.compose.project"] !== plan.project ||
          container.Config?.Labels?.["tenkacloud.isolation.owner"] !== plan.owner ||
          container.Config?.Labels?.["tenkacloud.isolation.generation"] !== plan.generation ||
          typeof container.Config?.Labels?.["com.docker.compose.service"] !== "string" ||
          !Object.hasOwn(plan.services, container.Config?.Labels?.["com.docker.compose.service"]),
      )
    )
      throw new Error("Owned shutdown identity could not be confirmed.");
    this.command("docker", ["stop", "--time", "1", ...ids]);
    if (
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]).trim()
    )
      throw new Error("Owned shutdown could not be confirmed.");
  }
  private verifyQuarantine(plan: LocalNetworkPlan, ipv6: boolean): void {
    for (const { parent, rule } of quarantineHooks(plan, ipv6)) {
      this.firewall(ipv6, ["-C", parent, ...rule]);
      const prefix = this.quarantinePrefix(parent, ipv6);
      const rules = lines(this.firewall(ipv6, ["-S", parent])).filter((line) =>
        line.startsWith("-A "),
      );
      if (
        !rules
          .slice(0, prefix)
          .some(
            (line) =>
              ruleFingerprint(line.split(" ").slice(2).join(" ")) ===
              ruleFingerprint(rule.join(" ")),
          )
      )
        throw new Error("Quarantine was not confirmed ahead of every admission rule.");
    }
  }
  private removeQuarantine(plan: LocalNetworkPlan): void {
    withNetworkHookLock(() => this.removeQuarantineLocked(plan));
  }
  private removeQuarantineLocked(plan: LocalNetworkPlan): void {
    for (const ipv6 of [false, true])
      for (const { parent, rule } of quarantineHooks(plan, ipv6)) {
        const matches = () =>
          lines(this.firewall(ipv6, ["-S", parent]))
            .filter(isQuarantineHook)
            .filter(
              (line) =>
                ruleFingerprint(line.split(" ").slice(2).join(" ")) ===
                ruleFingerprint(rule.join(" ")),
            );
        matches().forEach(() => {
          this.firewall(ipv6, ["-D", parent, ...rule]);
        });
        if (matches().length)
          throw new Error("Owned quarantine could not be removed; ownership was retained.");
      }
  }
  resetStopped(plan: LocalNetworkPlan): void {
    if (
      this.command("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]).trim()
    )
      throw new Error("Owned workloads must be stopped before a guard recovery.");
    this.preflight();
    this.assertOwnership(plan, true);
    for (const ipv6 of [false, true]) {
      for (const chain of [plan.inputChain, plan.forwardChain])
        this.firewall(ipv6, ["-C", chain, "-m", "comment", "--comment", plan.owner]);
      const body = [
        "*filter",
        `-F ${plan.inputChain}`,
        `-F ${plan.forwardChain}`,
        ...inputRules(plan, ipv6).map((rule) => `-A ${plan.inputChain} ${rule.join(" ")}`),
        ...forwardRules(plan, ipv6).map((rule) => `-A ${plan.forwardChain} ${rule.join(" ")}`),
        "COMMIT",
        "",
      ].join("\n");
      this.command(
        ipv6 ? "ip6tables-restore" : "iptables-restore",
        ["--wait", "5", "--noflush"],
        body,
      );
    }
    this.install(plan);
    this.verify(plan);
    this.verifyNetworkInventory(plan);
    this.removeQuarantine(plan);
    this.assertNoQuarantine(plan);
  }
  remove(plan: LocalNetworkPlan): void {
    // A successful Compose down is not enough if another attachment remains.
    const names = new Set(this.networkNames());
    if (
      this.command("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${plan.project}`,
      ]).trim()
    )
      throw new Error("Competition workloads still exist; guard and ownership were retained.");
    if (
      plan.segments.some(
        (segment) =>
          names.has(`${plan.project}_${segment.name}`) ||
          this.io.exists(`/sys/class/net/${segment.bridge}/bridge`),
      )
    )
      throw new Error("Competition network still exists; guard and ownership were retained.");
    withNetworkHookLock(() => {
      this.removeQuarantine(plan);
      for (const ipv6 of [false, true]) {
        const inventory = lines(this.firewall(ipv6, ["-S"]));
        const chains = [plan.inputChain, plan.forwardChain].filter((chain) =>
          inventory.includes(`-N ${chain}`),
        );
        for (const chain of chains) {
          this.firewall(ipv6, ["-C", chain, "-m", "comment", "--comment", plan.owner]);
          for (const hook of hooks(plan, ipv6).filter((entry) => entry.rule.at(-1) === chain)) {
            const parent = lines(this.firewall(ipv6, ["-S", hook.parent]));
            if (parent.includes(`-A ${hook.parent} ${hook.rule.join(" ")}`))
              this.firewall(ipv6, ["-D", hook.parent, ...hook.rule]);
          }
          this.firewall(ipv6, ["-F", chain]);
          this.firewall(ipv6, ["-X", chain]);
        }
      }
    });
  }
}

function routeDestinations(
  rows: unknown[],
  ipv6: boolean,
  owned: LocalNetworkPlan["segments"],
): string[] {
  const result: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("Invalid host route.");
    const route = row as BridgeRoute & { dst?: unknown; dev?: unknown };
    const destination = route.dst;
    if (destination === undefined || destination === "default") continue;
    if (typeof destination !== "string") throw new Error("Invalid routed destination.");
    const cidr = destination.includes("/") ? destination : `${destination}/${routePrefix(ipv6)}`;
    if (
      owned.some(
        (segment) => segment.bridge === route.dev && ownBridgeRoute(route, cidr, segment, ipv6),
      )
    )
      continue;
    result.push(cidr);
  }
  return result;
}

interface BridgeRoute {
  readonly type?: unknown;
  readonly protocol?: unknown;
  readonly gateway?: unknown;
}
/**
 * A retained bridge keeps only the routes its own addresses create: the connected route (or
 * Docker's plain on-link route) to the whole subnet, and the kernel's local, broadcast and anycast
 * routes for its gateway and the subnet's edges. Any other route into the subnet, kernel or not,
 * such as a narrower prefix or a foreign address, still counts as an overlap.
 */
function ownBridgeRoute(
  route: BridgeRoute,
  cidr: string,
  segment: LocalNetworkPlan["segments"][number],
  ipv6: boolean,
): boolean {
  const family = ipv6 ? "ipv6" : "ipv4";
  const [address = "", prefix = ""] = cidr.split("/");
  const [network = "", length = ""] = (ipv6 ? segment.ipv6 : segment.ipv4).split("/");
  if (isIP(address) !== (ipv6 ? 6 : 4)) return false;
  if (prefix === length && sameAddress(address, network, family))
    return route.type === undefined && route.gateway === undefined;
  if (route.protocol !== "kernel" || prefix !== String(routePrefix(ipv6))) return false;
  const gateway = segmentGateway(segment, ipv6);
  const expected = ipv6
    ? [
        { type: "local", address: gateway },
        { type: "anycast", address: network },
      ]
    : [
        { type: "local", address: gateway },
        { type: "broadcast", address: ipv4Broadcast(network, Number(length)) },
        { type: "broadcast", address: network },
      ];
  return expected.some(
    (entry) => entry.type === route.type && sameAddress(address, entry.address, family),
  );
}

function sameAddress(address: string, expected: string, family: "ipv4" | "ipv6"): boolean {
  const list = new BlockList();
  list.addAddress(expected, family);
  return list.check(address, family);
}

function ipv4Broadcast(network: string, length: number): string {
  const first = network.split(".").reduce((total, part) => total * 256 + Number(part), 0);
  const last = first + 2 ** (32 - length) - 1;
  return [24, 16, 8, 0].map((shift) => Math.floor(last / 2 ** shift) % 256).join(".");
}

function routePrefix(ipv6: boolean): number {
  return ipv6 ? 128 : 32;
}

interface RouteTarget {
  readonly segment: LocalNetworkPlan["segments"][number];
  readonly ipv6: boolean;
  readonly destination: string;
}

/** Consumers route to the published address; the publisher routes replies to the consumer subnet. */
function publicationRoute(
  plan: LocalNetworkPlan,
  networks: Record<string, unknown>,
  route: LocalNetworkPlan["publicRoutes"][number],
): RouteTarget | undefined {
  const origin = route.fromProject === plan.project;
  const segment = origin ? route.from : route.to;
  if (!networks[`${plan.project}_${segment.name}`]) return undefined;
  const ipv6 = isIP(route.address) === 6;
  if (origin) return { segment, ipv6, destination: `${route.address}/${routePrefix(ipv6)}` };
  return { segment, ipv6, destination: ipv6 ? route.from.ipv6 : route.from.ipv4 };
}

/**
 * A namespace holds one route per destination, so a container on several owned segments uses the
 * first segment by name. Installation and audits must agree on that choice.
 */
function containerRouteTargets(
  plan: LocalNetworkPlan,
  networks: Record<string, unknown>,
): RouteTarget[] {
  const chosen = new Map<string, RouteTarget>();
  for (const route of plan.publicRoutes) {
    const target = publicationRoute(plan, networks, route);
    const current = target && chosen.get(target.destination);
    if (target && (!current || target.segment.name < current.segment.name))
      chosen.set(target.destination, target);
  }
  return [...chosen.values()];
}

/** The kernel prints RFC 5952 text; planned subnets are built from unpadded words and may not be. */
function canonicalAddress(address: string): string {
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
}
function canonicalPrefix(destination: string): string {
  const [address = "", prefix] = destination.split("/");
  return `${canonicalAddress(address)}/${prefix ?? routePrefix(isIP(address) === 6)}`;
}

function quarantineHooks(plan: LocalNetworkPlan, _ipv6: boolean): { parent: string; rule: Rule }[] {
  const marker = plan.owner.replace("tc-isolation-v1:", "tc-quarantine-v1:");
  return plan.segments.flatMap(({ bridge }) => [
    { parent: "INPUT", rule: ["-i", bridge, "-m", "comment", "--comment", marker, "-j", "DROP"] },
    ...["-i", "-o"].map((direction) => ({
      parent: "FORWARD",
      rule: [direction, bridge, "-m", "comment", "--comment", marker, "-j", "DROP"],
    })),
  ]);
}
function isQuarantineHook(line: string): boolean {
  return vpnSealHook(line) || workloadQuarantineHook(line);
}
/** Canonical clause comparison tolerates native formatting, never changes rule sequence. */
function ruleFingerprint(line: string): string {
  const tokens = [...line.matchAll(/"([^"]*)"|([^\s"]+)/gu)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  if (!tokens.length || tokens.length % 2 !== 0)
    throw new Error("Unrecognized firewall rule representation.");
  const clauses: string[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    let value = tokens[index + 1] ?? "";
    value = value.replace(/\/(?:32|128)$/u, "");
    clauses.push(`${option}=${value}`);
  }
  clauses.sort((a, b) => a.localeCompare(b));
  return clauses.join("|");
}
