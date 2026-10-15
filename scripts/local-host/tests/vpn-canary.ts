import type { ChildProcess } from "node:child_process";

export interface CanaryReady {
  kind: "canary-ready";
  httpPort: number;
  dnsPort: number;
  listeners: string[];
}
export function canaryDatagramOptions(kind: "udp4" | "udp6") {
  return { type: kind, ipv6Only: kind === "udp6" };
}
/** The same child script runs in the owned VM namespaces and on ephemeral test ports. */
export function syntheticCanaryScript(options: {
  httpPort: number;
  dnsPort: number;
  marker: string;
  loopbackHttpHost?: "127.0.0.1" | "::1";
}): string {
  return `
const options = ${JSON.stringify(options)};
const listeners = [];
const datagramOptions = ${canaryDatagramOptions.toString()};
function failed(error) {
  const code = ['EADDRINUSE','EACCES','EADDRNOTAVAIL'].includes(error?.code) ? error.code : 'OTHER';
  console.log(JSON.stringify({kind:'canary-error',code}));
  process.exit(1);
}
process.on('uncaughtException', failed);
try {
  const http = Bun.serve({hostname:options.loopbackHttpHost ?? '::',port:options.httpPort,fetch(){return new Response(options.marker)}});
  listeners.push('http');
  const dns = Bun.serve({hostname:options.loopbackHttpHost ?? '::',port:options.dnsPort,fetch(){return new Response('owned-dns-canary')}});
  listeners.push('dns-tcp');
  for (const [kind,host] of [['udp4',options.loopbackHttpHost ? '127.0.0.1' : '0.0.0.0'],['udp6',options.loopbackHttpHost ? '::1' : '::']]) {
    const socket = require('node:dgram').createSocket(datagramOptions(kind));
    socket.on('error', failed);
    socket.on('message',(message,remote)=>socket.send(message,remote.port,remote.address));
    socket.on('listening',()=>{
      listeners.push(kind);
      if (listeners.length === 4) console.log(JSON.stringify({kind:'canary-ready',httpPort:http.port,dnsPort:dns.port,listeners}));
    });
    socket.bind({address:host,port:dns.port});
  }
} catch (error) { failed(error); }
`;
}
class CanaryStatusError extends Error {}
function parseCanaryReady(line: string): CanaryReady {
  const status = JSON.parse(line);
  if (status.kind === "canary-error") {
    const code = ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(status.code)
      ? status.code
      : "OTHER";
    throw new CanaryStatusError(`Synthetic canary listener failed (${code})`);
  }
  const expected = ["http", "dns-tcp", "udp4", "udp6"];
  if (
    status.kind !== "canary-ready" ||
    !Array.isArray(status.listeners) ||
    status.listeners.length !== 4 ||
    expected.some((name) => !status.listeners.includes(name)) ||
    ![status.httpPort, status.dnsPort].every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    )
  )
    throw new CanaryStatusError("Synthetic canary sent invalid readiness");
  return {
    kind: "canary-ready",
    httpPort: status.httpPort,
    dnsPort: status.dnsPort,
    listeners: expected,
  };
}
/** Only a small structured status is accepted; child stderr and arbitrary output stay private. */
export function awaitSyntheticCanary(child: ChildProcess, timeoutMs = 5000): Promise<CanaryReady> {
  return new Promise((resolve, reject) => {
    let output = "";
    const finish = (error?: Error, ready?: CanaryReady) => {
      clearTimeout(deadline);
      child.stdout?.off("data", data);
      child.off("close", exit);
      child.off("error", spawnError);
      if (error) reject(error);
      else if (ready) resolve(ready);
    };
    const exit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          `Synthetic canary exited before readiness (code=${code}, signal=${signal ?? "none"})`,
        ),
      );
    const spawnError = () => finish(new Error("Synthetic canary process could not start"));
    const data = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4096)
        return finish(new Error("Synthetic canary readiness exceeded its output limit"));
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        finish(undefined, parseCanaryReady(output.slice(0, end)));
      } catch (error) {
        finish(
          error instanceof CanaryStatusError
            ? error
            : new Error("Synthetic canary sent invalid readiness"),
        );
      }
    };
    const deadline = setTimeout(
      () => finish(new Error("Synthetic canary listener readiness timed out")),
      timeoutMs,
    );
    child.stdout?.on("data", data);
    child.once("close", exit);
    child.once("error", spawnError);
    if (child.exitCode !== null || child.signalCode !== null)
      exit(child.exitCode, child.signalCode);
  });
}
