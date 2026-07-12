import { createServer, request as nodeRequest, type Server } from "node:http";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { startLocalPlayServer } from "../../../scripts/local-play/server";
import type { SimulatedCloudProblem } from "../../../scripts/local-play/simulator";
import { rewriteSimulatorDataPlaneOutputs } from "../../../scripts/local-play/simulator-data-plane";
import type { LocalSimulatorRuntimePort } from "../../../scripts/local-play/simulator-runtime";
import { probeSimulatorUrl } from "../../../scripts/local-play/simulator-scoring";

function problem(): SimulatedCloudProblem {
  return {
    problemId: "query-routing",
    name: "QUERY Routing",
    category: "challenges",
    description: "Exercise a synthetic HTTP endpoint.",
    instructions: "Use the generated local URL.",
    problemDir: "/catalog/query-routing",
    runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
    templateBody: "Resources: {}\n",
    metadata: { scoring: { kind: "flag", flagOutputKey: "Flag", points: 100 } },
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

function rawRequest(
  url: string,
  method: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<{
  readonly body: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly status: number;
}> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () =>
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
          status: response.statusCode ?? 0,
        }),
      );
    });
    request.once("error", reject);
    request.end();
  });
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
    nativeRoute: () => {
      throw new Error("not used");
    },
    dataPlaneRoute: () => ({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      worldId: "world-data-plane",
      deploymentId: "deployment-data-plane",
      targetId: "default",
      provider: "aws",
      launchToken: "launch-token-must-remain-server-side",
    }),
    close: async () => {},
  };
}

describe("local-play Simulator data-plane proxy", () => {
  it("should preserve QUERY path, query, content type, and body while injecting the launch token", async () => {
    const observed: Array<Readonly<Record<string, unknown>>> = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        idempotencyKey: request.headers["idempotency-key"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(StatusCodes.OK, {
        "content-type": "application/json; charset=utf-8",
        "x-provider-response": "raw",
      });
      response.end('{"flag":"TC{local-query-proxy}"}');
    });
    const upstreamPort = await listen(upstream);
    const local = await startLocalPlayServer(
      0,
      { problems: [], simulatedProblems: [problem()] },
      { simulator: runtime(upstreamPort) },
    );
    const localUrl = rewriteSimulatorDataPlaneOutputs(
      problem(),
      { EndpointUrl: "https://query123.elb.us-east-1.amazonaws.com/search?scope=all" },
      `http://127.0.0.1:${local.port}`,
    ).EndpointUrl;
    if (!localUrl) throw new Error("rewritten data-plane URL is missing");
    try {
      const body = JSON.stringify({ query: { match: "tenka" } });
      const response = await fetch(localUrl, {
        method: "QUERY",
        headers: {
          authorization: "Bearer participant-value-must-be-replaced",
          "content-type": "application/json",
          "idempotency-key": "participant-query-1",
        },
        body,
      });

      expect(response.status).toBe(StatusCodes.OK);
      expect(response.headers.get("x-provider-response")).toBe("raw");
      const responseText = await response.text();
      expect(responseText).toBe('{"flag":"TC{local-query-proxy}"}');
      expect(observed[0]).toEqual({
        method: "QUERY",
        path: "/v1/worlds/world-data-plane/data-plane/aws/default/search?scope=all",
        authorization: "Bearer launch-token-must-remain-server-side",
        contentType: "application/json",
        idempotencyKey: "participant-query-1",
        body,
      });
      expect(JSON.stringify(observed[0])).not.toContain("participant-value-must-be-replaced");
      expect(responseText).not.toContain("launch-token-must-remain-server-side");

      const scoringProbe = await probeSimulatorUrl(localUrl);
      expect(scoringProbe).toMatchObject({ ok: true, status: StatusCodes.OK });
      expect(observed[1]).toMatchObject({
        method: "GET",
        path: "/v1/worlds/world-data-plane/data-plane/aws/default/search?scope=all",
        authorization: "Bearer launch-token-must-remain-server-side",
      });
    } finally {
      await local.close();
      await close(upstream);
    }
  });

  it("should reject hostile browser origins and unsupported methods before upstream I/O", async () => {
    const observedMethods: string[] = [];
    const upstream = createServer((request, response) => {
      observedMethods.push(request.method ?? "");
      response.writeHead(StatusCodes.OK, {
        "access-control-allow-credentials": "true",
        "access-control-allow-origin": "*",
        "content-type": "text/plain; charset=utf-8",
        vary: "Accept-Encoding",
      });
      response.end("ready");
    });
    const upstreamPort = await listen(upstream);
    const local = await startLocalPlayServer(
      0,
      { problems: [], simulatedProblems: [problem()] },
      { simulator: runtime(upstreamPort) },
    );
    const localUrl = `http://127.0.0.1:${local.port}/local/simulator-data/query-routing/default/search`;
    const portalOrigin = "http://127.0.0.1:5175";
    try {
      const hostile = await fetch(localUrl, {
        headers: { origin: "https://attacker.example" },
      });
      expect(hostile.status).toBe(StatusCodes.FORBIDDEN);
      expect(observedMethods).toEqual([]);

      const unsupported = await rawRequest(localUrl, "TRACK");
      expect(unsupported.status).toBe(StatusCodes.BAD_REQUEST);
      expect(observedMethods).toEqual([]);

      const preflight = await fetch(localUrl, {
        method: "OPTIONS",
        headers: {
          origin: portalOrigin,
          "access-control-request-method": "QUERY",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(StatusCodes.NO_CONTENT);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(portalOrigin);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("QUERY");
      expect(preflight.headers.get("vary")).toBe("Origin");
      expect(observedMethods).toEqual([]);

      const browser = await fetch(localUrl, {
        method: "QUERY",
        headers: { origin: portalOrigin, "content-type": "application/json" },
        body: "{}",
      });
      expect(browser.status).toBe(StatusCodes.OK);
      expect(await browser.text()).toBe("ready");
      expect(browser.headers.get("access-control-allow-origin")).toBe(portalOrigin);
      expect(browser.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(browser.headers.get("access-control-allow-credentials")).toBeNull();
      expect(browser.headers.get("vary")).toBe("Origin");
      expect(observedMethods).toEqual(["QUERY"]);

      const cli = await fetch(localUrl);
      expect(cli.status).toBe(StatusCodes.OK);
      expect(cli.headers.get("access-control-allow-origin")).toBeNull();
      expect(cli.headers.get("access-control-allow-credentials")).toBeNull();
      expect(observedMethods).toEqual(["QUERY", "GET"]);
    } finally {
      await local.close();
      await close(upstream);
    }
  });

  it("should rewrite only provider-owned synthetic HTTP outputs for their target", () => {
    const composite: SimulatedCloudProblem = {
      ...problem(),
      problemId: "multi-http",
      runtime: {
        kind: "composite",
        targets: [
          { id: "aws-app", provider: "aws", engine: "cloudformation", entry: "aws.yaml" },
          { id: "azure-app", provider: "azure", engine: "bicep", entry: "main.bicep" },
          { id: "gcp-app", provider: "gcp", engine: "infra-manager", entry: "gcp" },
          { id: "sakura-app", provider: "sakura", engine: "apprun", entry: "app.json" },
        ],
      },
    };
    const outputs = rewriteSimulatorDataPlaneOutputs(
      composite,
      {
        "aws-app.AlbUrl": "https://abc123.elb.us-east-1.amazonaws.com/search?q=1",
        "aws-app.FunctionUrl": "https://fn123.lambda-url.us-east-1.on.aws/",
        "azure-app.ApplicationUrl": "https://aca123.azurecontainerapps.local/api",
        "gcp-app.ServiceUrl": "https://run123.run.gcp.local/health",
        "sakura-app.ApplicationUrl": "https://app123.apprun.sakura.local/",
        "aws-app.ExternalUrl": "https://example.com/search",
        "aws-app.DatabaseUrl": "https://db.rds.us-east-1.amazonaws.com/",
        "aws-app.ConsoleUrl": "http://127.0.0.1:7777/console/world",
        "aws-app.AccessKeyId": "TCSIMABCDEFGHIJKLMNO",
        UnscopedUrl: "https://abc123.elb.us-east-1.amazonaws.com/",
      },
      "http://127.0.0.1:3199",
    );

    expect(outputs).toMatchObject({
      "aws-app.AlbUrl": "http://127.0.0.1:3199/local/simulator-data/multi-http/aws-app/search?q=1",
      "aws-app.FunctionUrl": "http://127.0.0.1:3199/local/simulator-data/multi-http/aws-app/",
      "azure-app.ApplicationUrl":
        "http://127.0.0.1:3199/local/simulator-data/multi-http/azure-app/api",
      "gcp-app.ServiceUrl": "http://127.0.0.1:3199/local/simulator-data/multi-http/gcp-app/health",
      "sakura-app.ApplicationUrl":
        "http://127.0.0.1:3199/local/simulator-data/multi-http/sakura-app/",
      "aws-app.ExternalUrl": "https://example.com/search",
      "aws-app.DatabaseUrl": "https://db.rds.us-east-1.amazonaws.com/",
      "aws-app.ConsoleUrl": "http://127.0.0.1:7777/console/world",
      "aws-app.AccessKeyId": "TCSIMABCDEFGHIJKLMNO",
      UnscopedUrl: "https://abc123.elb.us-east-1.amazonaws.com/",
    });
  });
});
