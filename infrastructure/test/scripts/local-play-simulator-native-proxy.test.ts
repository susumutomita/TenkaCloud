import { createServer, type Server } from "node:http";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { createLocalPlayState } from "../../../scripts/local-play/api-state";
import { startLocalPlayServer } from "../../../scripts/local-play/server";
import type { SimulatedCloudProblem } from "../../../scripts/local-play/simulator";
import { proxySimulatorNativeRequest } from "../../../scripts/local-play/simulator-native-proxy";
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

function runtime(upstreamPort: number): LocalSimulatorRuntimePort {
  return {
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
  };
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
        cookie: request.headers.cookie,
        worldId: request.headers["x-tenkacloud-world-id"],
        deploymentId: request.headers["x-tenkacloud-deployment-id"],
        targetId: request.headers["x-tenkacloud-target-id"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(StatusCodes.CREATED, {
        authorization: "Bearer upstream-value-must-not-reach-client",
        "authentication-info": "nextnonce=must-not-reach-client",
        "content-type": "application/json",
        "set-cookie": "native_session=must-not-reach-client; HttpOnly",
      });
      response.end('{"native":true}');
    });
    const upstreamPort = await listen(upstream);
    const simulator = runtime(upstreamPort);
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
            authorization: `AWS4-HMAC-SHA256 Credential=TCSIMABCDEFGHIJK/20260712/us-east-1/test/aws4_request, SignedHeaders=host;x-amz-date, Signature=${"a".repeat(64)}`,
            "content-type": "application/x-www-form-urlencoded",
            cookie: "portal_session=must-not-reach-simulator",
            "x-amz-date": "20260712T000000Z",
          },
          body: "Version=1",
        },
      );

      expect(response.status).toBe(StatusCodes.CREATED);
      expect(response.headers.get("authorization")).toBeNull();
      expect(response.headers.get("authentication-info")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({ native: true });
      expect(observed).toEqual({
        method: "POST",
        path: "/service?Action=Describe",
        authorization: `AWS4-HMAC-SHA256 Credential=TCSIMABCDEFGHIJK/20260712/us-east-1/test/aws4_request, SignedHeaders=host;x-amz-date;x-tenkacloud-deployment-id;x-tenkacloud-target-id;x-tenkacloud-world-id, Signature=${"a".repeat(64)}`,
        cookie: undefined,
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

  it("should bound a native upstream response before buffering it", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(StatusCodes.OK, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(1024 * 1024 + 1, "x"));
    });
    const upstreamPort = await listen(upstream);
    const local = await startLocalPlayServer(
      0,
      { problems: [], simulatedProblems: [problem()] },
      { simulator: runtime(upstreamPort) },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${local.port}/local/simulator-native/native-routing/default/`,
      );

      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
      expect(await response.json()).toEqual({ error: "native_response_too_large" });
    } finally {
      await local.close();
      await close(upstream);
    }
  });

  it("should abort a native upstream request after the configured timeout", async () => {
    const state = createLocalPlayState(
      { problems: [], simulatedProblems: [problem()] },
      { simulator: runtime(1) },
    );
    let fetchCalled = false;
    let abortObserved = false;
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchCalled = true;
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing timeout signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            reject(signal.reason);
          },
          { once: true },
        );
      })) as typeof fetch;
    const proxy = createServer((request, response) => {
      void proxySimulatorNativeRequest(request, response, state, {
        fetchFn: hangingFetch,
        timeoutMs: 5,
      });
    });
    const port = await listen(proxy);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/local/simulator-native/native-routing/default/`,
      );

      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
      expect(fetchCalled).toBe(true);
      expect(abortObserved).toBe(true);
    } finally {
      await close(proxy);
    }
  });
});
