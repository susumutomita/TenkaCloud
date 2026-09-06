import { createServer, type RequestListener } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { createClient } from "@libsql/client/http";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COORDINATION_RUN_ID } from "../../lib/problem-deploy/control-data/domain/coordination-scope.js";
import { createDefaultControlDataRuntime } from "../../lib/problem-deploy/control-data/runtime-repositories.js";
import {
  createScoreDeliveryControlDataRuntime,
  createScoreDeliveryDdbClient,
  scoreDeliveryFetch,
} from "../../lib/problem-deploy/handlers/coordination-dispatcher-handler/coordination-backends.js";
import {
  readCoordinationState,
  writeCoordinationState,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-store.js";
import { buildParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared.js";

async function withLocalServer(
  respond: RequestListener,
  run: (url: string, requests: () => number) => Promise<void>,
) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  try {
    await run(`http://127.0.0.1:${address.port}`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withUnresponsiveServer(run: (url: string, requests: () => number) => Promise<void>) {
  return withLocalServer(() => {
    // Deliberately leave the response open to exercise the client's request timeout.
  }, run);
}

describe("score delivery backend request bounds", () => {
  it("aborts a stalled real DynamoDB SDK request without SDK retry/backoff", async () => {
    await withUnresponsiveServer(async (endpoint, requests) => {
      const client = createScoreDeliveryDdbClient({
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
      const client = createClient({ url, fetch: scoreDeliveryFetch });
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
        scoreDeliveryFetch(new Request(url, { signal: controller.signal })),
      ).rejects.toThrow("caller cancelled");
      expect(requests()).toBe(0);
    });
  });
  it("also bounds a URL fetch without a caller signal", async () => {
    await withUnresponsiveServer(async (url, requests) => {
      await expect(scoreDeliveryFetch(url)).rejects.toThrow();
      expect(requests()).toBe(1);
    });
  });

  it("lets an explicit init signal override the Request signal", async () => {
    await withUnresponsiveServer(async (url, requests) => {
      const controller = new AbortController();
      controller.abort(new Error("explicit cancellation"));
      await expect(
        scoreDeliveryFetch(new Request(url), { signal: controller.signal }),
      ).rejects.toThrow("explicit cancellation");
      expect(requests()).toBe(0);
    });
  });

  it("wires the bounded HTTP client into the real score delivery runtime's SQL initialization", async () => {
    await withUnresponsiveServer(async (url, requests) => {
      vi.stubEnv("CONTROL_DATA_BACKEND", "turso");
      vi.stubEnv("TURSO_DATABASE_URL", url);
      vi.stubEnv("TURSO_AUTH_TOKEN_PARAMETER_NAME", "/local/fixture");
      const ssm = vi
        .spyOn(SSMClient.prototype, "send")
        .mockResolvedValue({ Parameter: { Value: "local-fixture-token" } });
      const started = performance.now();
      try {
        await expect(
          createScoreDeliveryControlDataRuntime().resolveDeploymentsRepository({}),
        ).rejects.toThrow();
        expect(requests()).toBe(1);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(ssm).toHaveBeenCalledOnce();
      } finally {
        ssm.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  });
});

describe("normal participant backend settings", () => {
  it("waits for a state write and read that each take longer than the delivery request limit", async () => {
    let item: unknown;
    const actions: string[] = [];
    await withLocalServer(
      (request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const action = String(request.headers["x-amz-target"]).split(".").at(-1);
          actions.push(action ?? "unknown");
          if (action === "TransactWriteItems") item = JSON.parse(body).TransactItems[1].Put.Item;
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
            response.end(JSON.stringify(action === "GetItem" ? { Item: item } : {}));
          }, 950);
        });
      },
      async (endpoint, requests) => {
        vi.stubEnv("CONTROL_DATA_BACKEND", "dynamodb");
        vi.stubEnv("DEPLOY_ENVIRONMENT", "test");
        vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
        const client = DynamoDBDocumentClient.from(
          new DynamoDBClient({
            endpoint,
            region: "local",
            credentials: { accessKeyId: "local", secretAccessKey: "local" },
          }),
        );
        const shared = buildParticipantSharedResources(createDefaultControlDataRuntime(), client);
        const store = { ...shared, tableName: "Local" };
        const scope = {
          tenantId: "tenant",
          eventId: "event",
          problemId: "battle",
          runId: DEFAULT_COORDINATION_RUN_ID,
        };
        try {
          expect(await client.config.maxAttempts()).toBe(3);
          expect(
            await writeCoordinationState(store, scope, { solved: true }, 0, "2026-09-06T00:00:00Z"),
          ).toEqual({ kind: "ok" });
          expect(await readCoordinationState(store, scope)).toMatchObject({
            state: { solved: true },
            version: 1,
          });
          expect(actions).toEqual(["TransactWriteItems", "GetItem"]);
          expect(requests()).toBe(2);
        } finally {
          client.destroy();
          vi.unstubAllEnvs();
        }
      },
    );
  });

  it("keeps the default runtime's SSM retry policy and waits for the SQL backend response", async () => {
    await withLocalServer(
      (_request, response) => {
        setTimeout(() => {
          response.writeHead(503, { "content-type": "text/plain" });
          response.end("fixture backend unavailable");
        }, 950);
      },
      async (url, requests) => {
        vi.stubEnv("CONTROL_DATA_BACKEND", "turso");
        vi.stubEnv("TURSO_DATABASE_URL", url);
        vi.stubEnv("TURSO_AUTH_TOKEN_PARAMETER_NAME", "/local/fixture");
        vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
        let attempts: number | undefined;
        const ssm = vi.spyOn(SSMClient.prototype, "send").mockImplementation(async function (
          this: SSMClient,
        ) {
          attempts = await this.config.maxAttempts();
          return { Parameter: { Value: "local-fixture-token" } };
        });
        try {
          // The backend error arrives after 750ms. A delivery runtime aborts before it can read it.
          await expect(
            createDefaultControlDataRuntime().resolveDeploymentsRepository({}),
          ).rejects.toThrow("fixture backend unavailable");
          expect(attempts).toBe(3);
          expect(requests()).toBe(1);
        } finally {
          ssm.mockRestore();
          vi.unstubAllEnvs();
        }
      },
    );
  });
});
