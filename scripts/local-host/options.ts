import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
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
      lan: { type: "string" },
      "unsafe-lan": { type: "boolean", default: false },
      "admin-port": { type: "string", default: "5174" },
      "participant-port": { type: "string", default: "5175" },
      "gateway-ports": { type: "string", default: DEFAULT_GATEWAY_PORTS },
      "no-build": { type: "boolean", default: false },
      "public-admin-origin": { type: "string" },
      "public-participant-origin": { type: "string" },
      "behind-proxy": { type: "boolean", default: false },
      "unsafe-http": { type: "boolean", default: false },
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
  const exposure = publicExposure(values);
  // Inside the hosted image loopback is unreachable and the log would carry the host key.
  if (!exposure && environment.TENKACLOUD_HOST_REQUIRE_PUBLIC === "1")
    throw new Error(
      "This image runs behind a TLS proxy. Pass --public-admin-origin and --public-participant-origin.",
    );
  if (exposure && values.lan)
    throw new Error("Choose either --lan or the public origins, not both.");
  const hostname = exposure ? "0.0.0.0" : listenAddress(values.lan, values["unsafe-lan"]);
  const adminPort = port(values["admin-port"]);
  const participantPort = port(values["participant-port"]);
  if (adminPort === participantPort)
    throw new Error("Use different ports for the host console and participant portal.");
  const gatewayPorts = parseGatewayPorts(values["gateway-ports"]);
  if (
    gatewayPortsOverlap(gatewayPorts, adminPort) ||
    gatewayPortsOverlap(gatewayPorts, participantPort)
  )
    throw new Error(
      "--gateway-ports must not include the host console or participant portal port.",
    );
  return {
    dataDirectory: resolve(values.data ?? joinDefault(repositoryRoot)),
    hostname,
    adminPort,
    participantPort,
    gatewayPorts,
    ...(exposure ? { public: exposure } : {}),
    build: !values["no-build"],
    help: values.help,
  };
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

/** Loopback by default; a LAN address only when it is private and explicitly acknowledged. */
function listenAddress(lan: string | undefined, unsafeLan: boolean): string {
  if (!lan) {
    if (unsafeLan) throw new Error("--unsafe-lan requires --lan <private-ip>.");
    return "127.0.0.1";
  }
  const parts = lan.split(".").map(Number);
  const privateAddress =
    parts[0] === 10 ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
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
