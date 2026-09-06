import { createServer } from "node:http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@libsql/client/http";
import { describe, expect, it } from "vitest";
import {
  coordinationFetch,
  createCoordinationDdbClient,
} from "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/coordination-backends.js";

async function withUnresponsiveServer(run: (url: string, requests: () => number) => Promise<void>) {
  let requests = 0;
  const server = createServer(() => {
    requests += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  try {
    await run(`http://127.0.0.1:${address.port}`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("coordination backend request bounds", () => {
  it("aborts a stalled real DynamoDB SDK request without SDK retry/backoff", async () => {
    await withUnresponsiveServer(async (endpoint, requests) => {
      const client = createCoordinationDdbClient({
        endpoint,
        region: "local",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      });
      const started = performance.now();
      try {
        await expect(
          client.send(new GetCommand({ TableName: "Local", Key: { PK: "key", SK: "key" } })),
        ).rejects.toMatchObject({ name: "TimeoutError", $metadata: { attempts: 1 } });
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(requests()).toBe(1);
      } finally {
        client.destroy();
      }
    });
  });

  it("aborts a stalled real libSQL HTTP operation", async () => {
    await withUnresponsiveServer(async (url, requests) => {
      const client = createClient({ url, fetch: coordinationFetch });
      const started = performance.now();
      try {
        await expect(client.execute("SELECT 1")).rejects.toThrow();
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(requests()).toBe(1);
      } finally {
        client.close();
      }
    });
  });

  it("preserves the caller's cancellation signal", async () => {
    await withUnresponsiveServer(async (url, requests) => {
      const controller = new AbortController();
      controller.abort(new Error("caller cancelled"));
      await expect(
        coordinationFetch(new Request(url, { signal: controller.signal })),
      ).rejects.toThrow("caller cancelled");
      expect(requests()).toBe(0);
    });
  });
});
