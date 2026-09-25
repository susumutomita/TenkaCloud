import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_GATEWAY_PORTS, gatewayPortsOverlap, parseGatewayPorts } from "./gateway-ports";

export function parseOptions(args: string[], repositoryRoot: string) {
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
  const hostname = listenAddress(values.lan, values["unsafe-lan"]);
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
    build: !values["no-build"],
    help: values.help,
  };
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
