import { createServer } from "node:net";

/** Bind a throwaway loopback listener: any bind error means another process holds the port. */
function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((accept) => {
    const tester = createServer();
    tester.once("error", () => accept(false));
    tester.once("listening", () => tester.close(() => accept(true)));
    tester.listen(port, "127.0.0.1");
  });
}

/** True only when every host port a problem would publish is currently unbound. */
export async function portsFree(ports: readonly number[]): Promise<boolean> {
  const results = await Promise.all(ports.map((port) => isLoopbackPortFree(port)));
  return results.every(Boolean);
}
