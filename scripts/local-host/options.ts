import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { consoleAppliance } from "./console-appliance";
import { DEFAULT_CONTAINER_LIMITS } from "./container-budget";
import { parseDockerNetworkPool } from "./docker-networks";
import { DEFAULT_GATEWAY_PORTS, gatewayPortsOverlap, parseGatewayPorts } from "./gateway-ports";

export function parseOptions(
  args: string[],
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      data: { type: "string" },
      "submission-catalog": { type: "string" },
      lan: { type: "string" },
      "unsafe-lan": { type: "boolean", default: false },
      "unsafe-docker-lan": { type: "boolean", default: false },
      "admin-port": { type: "string", default: "5174" },
      "participant-port": { type: "string" },
      "gateway-ports": { type: "string", default: DEFAULT_GATEWAY_PORTS },
      "max-active-per-team": { type: "string", default: String(DEFAULT_CONTAINER_LIMITS.perTeam) },
      "max-active-environments": {
        type: "string",
        default: String(DEFAULT_CONTAINER_LIMITS.global),
      },
      "container-memory-mib": {
        type: "string",
        default: String(DEFAULT_CONTAINER_LIMITS.memoryMiB),
      },
      "docker-network-pool": { type: "string" },
      "competition-network": { type: "boolean", default: false },
      "vpn-peers": { type: "string" },
      "no-build": { type: "boolean", default: false },
      "console-origin": { type: "string" },
      "web-origin-template": { type: "string" },
      "web-port": { type: "string", default: "5176" },
      "web-services": { type: "string", default: "web" },
      "public-admin-origin": { type: "string" },
      "public-participant-origin": { type: "string" },
      "behind-proxy": { type: "boolean", default: false },
      "unsafe-http": { type: "boolean", default: false },
      "aws-region": { type: "string" },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
    },
  });
  const port = (raw: string): number => {
    if (!/^\d+$/u.test(raw) || Number(raw) < 1024 || Number(raw) > 65535)
      throw new Error("Ports must be integers from 1024 to 65535.");
    return Number(raw);
  };
  const adminPort = port(values["admin-port"]);
  const participantPort = port(values["participant-port"] ?? "5175");
  const appliance = consoleAppliance(values);
  const exposure = appliance
    ? undefined
    : publicExposure({
        ...values,
        ...codespacesOrigins(values, environment, adminPort, participantPort),
      });
  assertUnsafeDockerLan(values, Boolean(exposure));
  assertExposureEnvironment(Boolean(appliance), exposure, values.lan, environment);
  assertCompetitionOptions(
    values["competition-network"],
    values["docker-network-pool"],
    Boolean(exposure),
  );
  assertVpnOptions(values, Boolean(exposure));
  const hostname = exposure ? "0.0.0.0" : listenAddress(values.lan, values["unsafe-lan"]);
  const gatewayPorts = parseGatewayPorts(values["gateway-ports"]);
  // With --vpn-peers the registration supplies the participant port; vpnListener checks it.
  assertListenerPorts(
    adminPort,
    values["vpn-peers"] ? undefined : participantPort,
    gatewayPorts,
    appliance?.webPort,
  );
  if (values["aws-region"] !== undefined)
    throw new Error(
      "AWS problems require cloud hosting. --aws-region is no longer accepted by make local; use the reviewed make deploy workflow when cloud hosting is ready.",
    );
  return {
    dataDirectory: resolve(values.data ?? joinDefault(repositoryRoot)),
    competitionNetwork: values["competition-network"],
    unsafeDockerLan: values["unsafe-docker-lan"],
    ...(values["vpn-peers"] ? { vpnPeerPath: resolve(values["vpn-peers"]) } : {}),
    ...(values["submission-catalog"]
      ? { submissionCatalogPath: resolve(values["submission-catalog"]) }
      : {}),
    containerLimits: {
      perTeam: positiveLimit(values["max-active-per-team"], 40),
      global: positiveLimit(values["max-active-environments"], 40),
      memoryMiB: positiveLimit(values["container-memory-mib"], 1024 * 1024),
    },
    ...(values["docker-network-pool"]
      ? { dockerNetworkPool: parseDockerNetworkPool(values["docker-network-pool"]) }
      : {}),
    hostname,
    ...(appliance ? { consoleAppliance: appliance } : {}),
    adminPort,
    participantPort,
    gatewayPorts,
    ...(exposure ? { public: exposure } : {}),
    build: !values["no-build"],
    help: values.help,
  };
}

/** Select exact forwarded origins; this neither opens ports nor changes their visibility. */
function codespacesOrigins(
  values: {
    lan?: string;
    "vpn-peers"?: string;
    "public-admin-origin"?: string;
    "public-participant-origin"?: string;
  },
  environment: Readonly<Record<string, string | undefined>>,
  adminPort: number,
  participantPort: number,
): { "public-admin-origin"?: string; "public-participant-origin"?: string } {
  if (
    environment.CODESPACES !== "true" ||
    values.lan !== undefined ||
    values["vpn-peers"] !== undefined ||
    values["public-admin-origin"] !== undefined ||
    values["public-participant-origin"] !== undefined
  )
    return {};
  const name = environment.CODESPACE_NAME ?? "";
  const domain = environment.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name) ||
    `${name}-${adminPort}`.length > 63 ||
    `${name}-${participantPort}`.length > 63 ||
    domain !== "app.github.dev"
  )
    throw new Error(
      "Invalid Codespaces name or forwarding domain; use valid Codespaces metadata or explicit public origins.",
    );
  return {
    "public-admin-origin": `https://${name}-${adminPort}.${domain}`,
    "public-participant-origin": `https://${name}-${participantPort}.${domain}`,
  };
}

/** Dropping team network isolation is only for a trusted group on an explicit LAN listener. */
function assertUnsafeDockerLan(
  values: {
    "unsafe-docker-lan"?: boolean;
    "unsafe-lan"?: boolean;
    "competition-network"?: boolean;
    "vpn-peers"?: string;
    lan?: string;
  },
  exposed: boolean,
): void {
  if (!values["unsafe-docker-lan"]) return;
  if (!values.lan || !values["unsafe-lan"])
    throw new Error("--unsafe-docker-lan requires --lan <private-ip> --unsafe-lan.");
  if (values["competition-network"] || values["vpn-peers"] || exposed)
    throw new Error(
      "--unsafe-docker-lan drops team network isolation; it cannot be combined with --competition-network, --vpn-peers, or public origins.",
    );
}

function assertVpnOptions(
  values: {
    "vpn-peers"?: string;
    "competition-network"?: boolean;
    lan?: string;
    "participant-port"?: string;
  },
  publicExposure: boolean,
): void {
  if (values["vpn-peers"] && (!values["competition-network"] || values.lan || publicExposure))
    throw new Error(
      "--vpn-peers requires --competition-network and dedicated VPN listeners; LAN/public modes cannot be combined.",
    );
  if (values["vpn-peers"] && values["participant-port"] !== undefined)
    throw new Error(
      "--vpn-peers takes the participant port from the VPN registration; omit --participant-port.",
    );
}

function assertListenerPorts(
  adminPort: number,
  participantPort: number | undefined,
  gatewayPorts: ReturnType<typeof parseGatewayPorts>,
  webPort: number | undefined,
): void {
  if (adminPort === participantPort)
    throw new Error("Use different ports for the host console and participant portal.");
  if (participantPort !== undefined)
    assertWebPort(webPort, adminPort, participantPort, gatewayPorts);
  if (
    gatewayPortsOverlap(gatewayPorts, adminPort) ||
    (participantPort !== undefined && gatewayPortsOverlap(gatewayPorts, participantPort))
  )
    throw new Error(
      "--gateway-ports must not include the host console or participant portal port.",
    );
}

/** The root-owned VPN registration owns the participant listener address and port. */
export function vpnListener(
  options: ReturnType<typeof parseOptions>,
  plan: { readonly serverIpv4: string; readonly participantPort: number },
): { hostname: string; participantPort: number } {
  assertListenerPorts(
    options.adminPort,
    plan.participantPort,
    options.gatewayPorts,
    options.consoleAppliance?.webPort,
  );
  return { hostname: plan.serverIpv4, participantPort: plan.participantPort };
}

/** Served through a TLS-terminating proxy; both listeners bind every interface of the container. */
export interface PublicExposure {
  /** The origins the proxy serves. Host and Origin checks compare requests against them. */
  readonly adminOrigin: string;
  readonly participantOrigin: string;
  /** Key the invalid-credential limiter on the entry the trusted proxy appended to X-Forwarded-For. */
  readonly behindProxy: boolean;
}

function publicExposure(values: {
  "public-admin-origin"?: string;
  "public-participant-origin"?: string;
  "behind-proxy"?: boolean;
  "unsafe-http"?: boolean;
}): PublicExposure | undefined {
  const admin = values["public-admin-origin"];
  const participant = values["public-participant-origin"];
  if (!admin && !participant) {
    if (values["behind-proxy"] || values["unsafe-http"])
      throw new Error("--behind-proxy and --unsafe-http need the public origins.");
    return undefined;
  }
  if (!admin || !participant)
    throw new Error("Give both --public-admin-origin and --public-participant-origin.");
  const adminOrigin = publicOrigin(admin, values["unsafe-http"] ?? false);
  const participantOrigin = publicOrigin(participant, values["unsafe-http"] ?? false);
  if (adminOrigin === participantOrigin)
    throw new Error("The host console and participant portal need different origins.");
  return { adminOrigin, participantOrigin, behindProxy: values["behind-proxy"] ?? false };
}

function publicOrigin(raw: string, unsafeHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${raw} is not a URL.`);
  }
  if (url.origin !== raw.replace(/\/$/u, ""))
    throw new Error(`${raw} must be an origin only: scheme, host and optional port.`);
  if (url.protocol === "http:" && !unsafeHttp)
    throw new Error(
      `${raw} uses HTTP. Public hosting needs HTTPS at the proxy; --unsafe-http is for local tests only.`,
    );
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${raw} must use https.`);
  return url.origin;
}

/** Loopback by default; bind one acknowledged private or shared-address IPv4. */
function listenAddress(lan: string | undefined, unsafeLan: boolean): string {
  if (!lan) {
    if (unsafeLan) throw new Error("--unsafe-lan requires --lan <private-ip>.");
    return "127.0.0.1";
  }
  const parts = lan.split(".").map(Number);
  const privateAddress =
    parts[0] === 10 ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127);
  if (!isIPv4(lan) || !privateAddress)
    throw new Error("--lan requires an explicit private IPv4 address of this host, not 0.0.0.0.");
  if (!unsafeLan)
    throw new Error(
      "LAN mode uses HTTP, not TLS. Add --unsafe-lan only on a trusted isolated network.",
    );
  return lan;
}

function joinDefault(root: string): string {
  return resolve(root, ".tenkacloud/host");
}

function positiveLimit(raw: string, maximum: number): number {
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > maximum)
    throw new Error(`Resource limit must be an integer from 1 to ${maximum}.`);
  return Number(raw);
}

function assertCompetitionOptions(
  enabled: boolean,
  pool: string | undefined,
  exposed: boolean,
): void {
  if (enabled && (!pool || exposed))
    throw new Error(
      "--competition-network requires --docker-network-pool and local native hosting, not public origins.",
    );
}

function assertExposureEnvironment(
  appliance: boolean,
  exposure: PublicExposure | undefined,
  lan: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  // Inside the hosted image loopback is unreachable and the log would carry the host key.
  if (appliance && environment.TENKACLOUD_HOST_REQUIRE_PUBLIC === "1")
    throw new Error("Console appliance requires native Linux hosting, not the hosted image.");
  if (!exposure && environment.TENKACLOUD_HOST_REQUIRE_PUBLIC === "1")
    throw new Error(
      "This image runs behind a TLS proxy. Pass --public-admin-origin and --public-participant-origin.",
    );
  if (exposure && lan) throw new Error("Choose either --lan or the public origins, not both.");
}

function assertWebPort(
  webPort: number | undefined,
  adminPort: number,
  participantPort: number,
  gatewayPorts: ReturnType<typeof parseGatewayPorts>,
): void {
  if (
    webPort !== undefined &&
    ([adminPort, participantPort].includes(webPort) || gatewayPortsOverlap(gatewayPorts, webPort))
  )
    throw new Error("Web broker port must not overlap host listeners or gateway slots.");
}
