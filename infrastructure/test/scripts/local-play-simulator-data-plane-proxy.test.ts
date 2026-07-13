import { createServer, request as nodeRequest, type Server } from "node:http";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import type { SimulatedCloudProblem } from "../../../scripts/local-play/simulator";
import { rewriteSimulatorDataPlaneOutputs } from "../../../scripts/local-play/simulator-data-plane";
import { startSimulatorDataPlaneListener } from "../../../scripts/local-play/simulator-data-plane-proxy";
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
    dataPlaneRoute: async () => ({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      worldId: "world-data-plane",
      deploymentId: "deployment-data-plane",
      targetId: "default",
      provider: "aws",
      launchToken: "launch-token-must-remain-server-side",
    }),
    consoleUrl: async () => "http://127.0.0.1/console",
    refreshAccess: async () => {},
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
        cookie: request.headers.cookie,
        forwarded: request.headers.forwarded,
        xForwardedHost: request.headers["x-forwarded-host"],
        xGithubUser: request.headers["x-github-user"],
        xOriginalUrl: request.headers["x-original-url"],
        cfAccess: request.headers["cf-access-authenticated-user-email"],
        contentType: request.headers["content-type"],
        idempotencyKey: request.headers["idempotency-key"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(StatusCodes.OK, {
        authorization: "Bearer upstream-value-must-not-reach-browser",
        "content-security-policy": "default-src 'none'; worker-src 'self'",
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "simulator_session=must-not-reach-browser; HttpOnly",
        "service-worker-allowed": "/",
        "x-provider-response": "raw",
      });
      response.end('{"flag":"TC{local-query-proxy}"}');
    });
    const upstreamPort = await listen(upstream);
    const simulator = runtime(upstreamPort);
    const listener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    const localUrl = rewriteSimulatorDataPlaneOutputs(
      problem(),
      { EndpointUrl: "https://query123.elb.us-east-1.amazonaws.com/search?scope=all" },
      () => listener.origin,
    ).EndpointUrl;
    if (!localUrl) throw new Error("rewritten data-plane URL is missing");
    try {
      const body = JSON.stringify({ query: { match: "tenka" } });
      const response = await fetch(localUrl, {
        method: "QUERY",
        headers: {
          authorization: "Bearer participant-value-must-be-replaced",
          cookie: "portal_session=must-not-reach-simulator",
          forwarded: "for=192.0.2.1;host=attacker.example",
          "x-forwarded-host": "attacker.example",
          "x-github-user": "private-codespaces-user",
          "x-original-url": "/private-codespaces-path",
          "cf-access-authenticated-user-email": "private@example.com",
          "content-type": "application/json",
          "idempotency-key": "participant-query-1",
        },
        body,
      });

      expect(response.status).toBe(StatusCodes.OK);
      expect(response.headers.get("x-provider-response")).toBe("raw");
      expect(response.headers.get("authorization")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("service-worker-allowed")).toBeNull();
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("content-security-policy")).toContain("worker-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain("worker-src 'none'");
      expect(response.headers.get("content-security-policy")).toContain(",");
      const responseText = await response.text();
      expect(responseText).toBe('{"flag":"TC{local-query-proxy}"}');
      expect(observed[0]).toEqual({
        method: "QUERY",
        path: "/v1/worlds/world-data-plane/data-plane/aws/default/search?scope=all",
        authorization: "Bearer launch-token-must-remain-server-side",
        cookie: undefined,
        forwarded: undefined,
        xForwardedHost: undefined,
        xGithubUser: undefined,
        xOriginalUrl: undefined,
        cfAccess: undefined,
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
      await listener.close();
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
    const simulator = runtime(upstreamPort);
    const listener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    const otherListener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    const localUrl = `${listener.origin}/search`;
    const portalOrigin = "http://127.0.0.1:5175";
    try {
      const hostile = await fetch(localUrl, {
        headers: { origin: "https://attacker.example" },
      });
      expect(hostile.status).toBe(StatusCodes.FORBIDDEN);
      expect(observedMethods).toEqual([]);

      const unsupported = await rawRequest(localUrl, "PUT");
      expect(unsupported.status).toBe(StatusCodes.BAD_REQUEST);
      expect(observedMethods).toEqual([]);

      const rebound = await rawRequest(localUrl, "GET", { host: "attacker.example" });
      expect(rebound.status).toBe(StatusCodes.MISDIRECTED_REQUEST);
      expect(observedMethods).toEqual([]);

      const privateHeaderFlood = Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`x-github-private-${index}`, "hidden"]),
      );
      const flooded = await rawRequest(localUrl, "GET", privateHeaderFlood);
      expect(flooded.status).toBe(StatusCodes.REQUEST_HEADER_FIELDS_TOO_LARGE);
      expect(observedMethods).toEqual([]);

      expect(otherListener.origin).not.toBe(listener.origin);
      const crossTarget = await fetch(`${otherListener.origin}/search`, {
        headers: { origin: listener.origin },
      });
      expect(crossTarget.status).toBe(StatusCodes.FORBIDDEN);
      expect(observedMethods).toEqual([]);

      const preflight = await fetch(localUrl, {
        method: "OPTIONS",
        headers: {
          origin: portalOrigin,
          "access-control-request-method": "QUERY",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(StatusCodes.FORBIDDEN);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(observedMethods).toEqual([]);

      const browser = await fetch(localUrl, {
        method: "QUERY",
        headers: { origin: portalOrigin, "content-type": "application/json" },
        body: "{}",
      });
      expect(browser.status).toBe(StatusCodes.FORBIDDEN);
      expect(browser.headers.get("access-control-allow-origin")).toBeNull();
      expect(observedMethods).toEqual([]);

      const selfOrigin = await fetch(localUrl, {
        method: "POST",
        headers: { origin: listener.origin, "content-type": "text/plain" },
        body: "same-origin data-plane page",
      });
      expect(selfOrigin.status).toBe(StatusCodes.OK);
      expect(selfOrigin.headers.get("access-control-allow-origin")).toBe(listener.origin);
      expect(selfOrigin.headers.get("content-security-policy")).toContain("worker-src 'none'");
      expect(observedMethods).toEqual(["POST"]);

      vi.stubEnv("CODESPACE_NAME", "tenkacloud-demo");
      vi.stubEnv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev");
      const codespacesSelfOrigin = `https://tenkacloud-demo-${listener.port}.app.github.dev`;
      const codespacesBrowser = await fetch(localUrl, {
        method: "POST",
        headers: { origin: codespacesSelfOrigin, "content-type": "text/plain" },
        body: "codespaces same-origin data-plane page",
      });
      expect(codespacesBrowser.status).toBe(StatusCodes.OK);
      expect(codespacesBrowser.headers.get("access-control-allow-origin")).toBe(
        codespacesSelfOrigin,
      );
      expect(observedMethods).toEqual(["POST", "POST"]);
      vi.unstubAllEnvs();

      const cli = await fetch(localUrl);
      expect(cli.status).toBe(StatusCodes.OK);
      expect(cli.headers.get("access-control-allow-origin")).toBeNull();
      expect(cli.headers.get("access-control-allow-credentials")).toBeNull();
      expect(observedMethods).toEqual(["POST", "POST", "GET"]);
    } finally {
      vi.unstubAllEnvs();
      await otherListener.close();
      await listener.close();
      await close(upstream);
    }
  });

  it("should redact upstream transport and response-limit failures", async () => {
    const unavailable = createServer();
    const unavailablePort = await listen(unavailable);
    await close(unavailable);
    const simulator = runtime(unavailablePort);
    const listener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    try {
      const response = await fetch(`${listener.origin}/private-path`);
      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
      const body = await response.text();
      expect(body).toBe('{"error":"data_plane_proxy_failed"}');
      expect(body).not.toContain("private-path");
      expect(body).not.toContain(String(unavailablePort));
    } finally {
      await listener.close();
    }
  });

  it("should reject oversized upstream headers without exposing them", async () => {
    const upstream = createServer((_request, response) => {
      for (let index = 0; index < 65; index += 1) {
        response.setHeader(`x-upstream-private-${index}`, "hidden");
      }
      response.end("must not reach the participant");
    });
    const upstreamPort = await listen(upstream);
    const simulator = runtime(upstreamPort);
    const listener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    try {
      const response = await fetch(listener.origin);
      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
      expect(await response.text()).toBe('{"error":"data_plane_proxy_failed"}');
      expect(response.headers.get("x-upstream-private-0")).toBeNull();
    } finally {
      await listener.close();
      await close(upstream);
    }
  });

  it("should drain an active request before listener close resolves", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const upstream = createServer(async (_request, response) => {
      markStarted();
      await gate;
      response.end("drained");
    });
    const upstreamPort = await listen(upstream);
    const simulator = runtime(upstreamPort);
    const listener = await startSimulatorDataPlaneListener(() =>
      simulator.dataPlaneRoute(problem(), "default"),
    );
    const request = fetch(listener.origin);
    await started;
    let closed = false;
    const closing = listener.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await (await request).text()).toBe("drained");
    await closing;
    expect(closed).toBe(true);
    await close(upstream);
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
    const targetOrigins: Readonly<Record<string, string>> = {
      "aws-app": "http://127.0.0.1:31991",
      "azure-app": "http://127.0.0.1:31992",
      "gcp-app": "http://127.0.0.1:31993",
      "sakura-app": "http://127.0.0.1:31994",
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
      (targetId) => targetOrigins[targetId] ?? "http://127.0.0.1:31995",
    );

    expect(outputs).toMatchObject({
      "aws-app.AlbUrl": "http://127.0.0.1:31991/search?q=1",
      "aws-app.FunctionUrl": "http://127.0.0.1:31991/",
      "azure-app.ApplicationUrl": "http://127.0.0.1:31992/api",
      "gcp-app.ServiceUrl": "http://127.0.0.1:31993/health",
      "sakura-app.ApplicationUrl": "http://127.0.0.1:31994/",
      "aws-app.ExternalUrl": "https://example.com/search",
      "aws-app.DatabaseUrl": "https://db.rds.us-east-1.amazonaws.com/",
      "aws-app.ConsoleUrl": "http://127.0.0.1:7777/console/world",
      "aws-app.AccessKeyId": "TCSIMABCDEFGHIJKLMNO",
      UnscopedUrl: "https://abc123.elb.us-east-1.amazonaws.com/",
    });
  });
});
