import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertPortFree, isProcessAlive } from "../../../scripts/local-play/readiness";

function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe("isProcessAlive", () => {
  it("should report the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("should report an unused pid as not alive", () => {
    // PID 2^31-1 is effectively never allocated.
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe("assertPortFree", () => {
  let open: { server: Server; port: number } | undefined;

  afterEach(async () => {
    if (open) {
      await new Promise<void>((resolve) => open?.server.close(() => resolve()));
      open = undefined;
    }
  });

  it("should resolve when the port is free", async () => {
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(assertPortFree(port, "Participant API")).resolves.toBeUndefined();
  });

  it("should fail loudly when the port is already in use", async () => {
    open = await listenOnEphemeralPort();
    await expect(assertPortFree(open.port, "Participant API")).rejects.toThrow(
      /Participant API port \d+ is already in use/,
    );
  });
});
