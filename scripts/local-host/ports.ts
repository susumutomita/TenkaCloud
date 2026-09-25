import { createServer } from "node:net";

/** Bind a throwaway listener on `host`: any bind error means another process holds the port. */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((accept) => {
    const tester = createServer();
    tester.once("error", () => accept(false));
    tester.once("listening", () => tester.close(() => accept(true)));
    tester.listen(port, host);
  });
}

/**
 * True only when every port is currently unbound on `host`. Probe the address the real
 * listener will use: Compose publishes problem ports on loopback, while exercise gateways
 * listen on the loopback or explicit LAN address the host was started with.
 */
export async function portsFree(ports: readonly number[], host: string): Promise<boolean> {
  const results = await Promise.all(ports.map((port) => isPortFree(port, host)));
  return results.every(Boolean);
}
