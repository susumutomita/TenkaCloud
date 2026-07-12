import { createServer, type Server } from "node:http";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { startLocalPlayServer } from "../../../scripts/local-play/server";
import type { SimulatedCloudProblem } from "../../../scripts/local-play/simulator";
import type { LocalSimulatorRuntimePort } from "../../../scripts/local-play/simulator-runtime";

function problem(): SimulatedCloudProblem {
  return {
    problemId: "native-routing",
    name: "Native Routing",
    category: "challenges",
    description: "Exercise a native provider API.",
    instructions: "Use the generated local endpoint.",
    problemDir: "/catalog/native-routing",
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    templateBody: "Resources: {}\n",
    metadata: {
      scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 },
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("local-play Simulator native route proxy", () => {
  it("should preserve the native request and inject world routing outside the provider CLI", async () => {
    let observed: Readonly<Record<string, unknown>> | undefined;
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = {
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        worldId: request.headers["x-tenkacloud-world-id"],
        deploymentId: request.headers["x-tenkacloud-deployment-id"],
        targetId: request.headers["x-tenkacloud-target-id"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(StatusCodes.CREATED, { "content-type": "application/json" });
      response.end('{"native":true}');
    });
    const upstreamPort = await listen(upstream);
    const simulator = {
      start: async () => {
        throw new Error("not used");
      },
      stop: async () => {},
      reset: async () => {
        throw new Error("not used");
      },
      exportSnapshot: async () => {},
      importSnapshot: async () => {},
      advanceClock: async () => undefined,
      fireDisruption: async () => ({}),
      attackProbe: async () => ({ ok: true, status: StatusCodes.OK, responseTimeMs: 0 }),
      nativeRoute: () => ({
        upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        worldId: "world-native",
        deploymentId: "deployment-native",
        targetId: "default",
      }),
      dataPlaneRoute: () => {
        throw new Error("not used");
      },
      close: async () => {},
    } satisfies LocalSimulatorRuntimePort;
    const local = await startLocalPlayServer(
      0,
      { problems: [], simulatedProblems: [problem()] },
      { simulator },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${local.port}/local/simulator-native/native-routing/default/service?Action=Describe`,
        {
          method: "POST",
          headers: {
            authorization:
              "AWS4-HMAC-SHA256 Credential=TCSIMABCDEFGHIJK/20260712/us-east-1/test/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
            "content-type": "application/x-www-form-urlencoded",
            "x-amz-date": "20260712T000000Z",
          },
          body: "Version=1",
        },
      );

      expect(response.status).toBe(StatusCodes.CREATED);
      expect(await response.json()).toEqual({ native: true });
      expect(observed).toEqual({
        method: "POST",
        path: "/service?Action=Describe",
        authorization:
          "AWS4-HMAC-SHA256 Credential=TCSIMABCDEFGHIJK/20260712/us-east-1/test/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
        worldId: "world-native",
        deploymentId: "deployment-native",
        targetId: "default",
        body: "Version=1",
      });
    } finally {
      await local.close();
      await close(upstream);
    }
  });

  it("should reject browser-origin requests before resolving a native route", async () => {
    const simulator = {
      start: async () => {
        throw new Error("not used");
      },
      stop: async () => {},
      reset: async () => {
        throw new Error("not used");
      },
      exportSnapshot: async () => {},
      importSnapshot: async () => {},
      advanceClock: async () => undefined,
      fireDisruption: async () => ({}),
      attackProbe: async () => ({ ok: true, status: StatusCodes.OK, responseTimeMs: 0 }),
      nativeRoute: () => {
        throw new Error("must not resolve");
      },
      dataPlaneRoute: () => {
        throw new Error("not used");
      },
      close: async () => {},
    } satisfies LocalSimulatorRuntimePort;
    const local = await startLocalPlayServer(
      0,
      { problems: [], simulatedProblems: [problem()] },
      { simulator },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${local.port}/local/simulator-native/native-routing/default/`,
        { headers: { origin: "http://127.0.0.1:5175" } },
      );
      expect(response.status).toBe(StatusCodes.FORBIDDEN);
      expect(await response.json()).toEqual({ error: "native_proxy_forbids_browser_origin" });
    } finally {
      await local.close();
    }
  });
});
