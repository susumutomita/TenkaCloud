import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

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
  const hostname = values.lan ?? "127.0.0.1";
  if (values.lan) {
    const parts = hostname.split(".").map(Number);
    const privateAddress =
      parts[0] === 10 ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
    if (!isIPv4(hostname) || !privateAddress)
      throw new Error("--lan requires an explicit private IPv4 address of this host, not 0.0.0.0.");
    if (!values["unsafe-lan"])
      throw new Error(
        "LAN mode uses HTTP, not TLS. Add --unsafe-lan only on a trusted isolated network.",
      );
  } else if (values["unsafe-lan"]) throw new Error("--unsafe-lan requires --lan <private-ip>.");
  const adminPort = port(values["admin-port"]);
  const participantPort = port(values["participant-port"]);
  if (adminPort === participantPort)
    throw new Error("Use different ports for the host console and participant portal.");
  return {
    dataDirectory: resolve(values.data ?? joinDefault(repositoryRoot)),
    hostname,
    adminPort,
    participantPort,
    build: !values["no-build"],
    help: values.help,
  };
}

function joinDefault(root: string): string {
  return resolve(root, ".tenkacloud/host");
}
