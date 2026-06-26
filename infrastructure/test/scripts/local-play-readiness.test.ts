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
    // pid 2^31-1 is above the OS pid range and is never a live process.
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});

describe("assertPortFree", () => {
  let opened: Server | undefined;

  afterEach(async () => {
    if (opened) {
      await new Promise<void>((resolve) => opened?.close(() => resolve()));
      opened = undefined;
    }
  });

  it("should resolve when the port is free", async () => {
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(assertPortFree(port, "test API")).resolves.toBeUndefined();
  });

  it("should fail loudly when the port is already in use", async () => {
    const { server, port } = await listenOnEphemeralPort();
    opened = server;
    await expect(assertPortFree(port, "test API")).rejects.toThrow(
      `test API port ${port} is already in use`,
    );
  });
});
