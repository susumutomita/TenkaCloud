import { createServer, type IncomingMessage, type Server } from "node:http";
import type { S3Client } from "@aws-sdk/client-s3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamoDbDeploymentsRepository,
  SqlDeploymentsRepository,
} from "../../lib/problem-deploy/control-data/deployments-repository";
import type {
  DeploymentRecord,
  DeploymentsRepository,
} from "../../lib/problem-deploy/control-data/types";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  contentDigest,
  createCatalogLoader,
  executionCatalogSchema,
} from "../../lib/problem-deploy/handlers/shared/execution-catalog";
import { participantRateLimiter } from "../../lib/problem-deploy/handlers/shared/rate-limiter";
import { mcpIssuer } from "../../lib/problem-deploy/mcp-oauth-config";
import { makeFakeDdb, makeSqliteExecutor } from "./control-data/control-data-write.test-helpers";
import { mcpConfigFixture } from "./mcp-oauth-fixture";

// Only composition and the external Cognito JWKS network destination are replaced.
// HTTP/MCP, JOSE signature/claim checks, participant services and repositories run unchanged.
const simulation = vi.hoisted(() => ({
  shared: undefined as ParticipantSharedResources | undefined,
  jwksUrl: "",
}));
vi.mock("../../lib/problem-deploy/handlers/participant-handler/shared", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  buildParticipantSharedResources: () => {
    if (!simulation.shared) throw new Error("Simulator composition missing");
    return simulation.shared;
  },
}));
vi.mock("jose", async (original) => {
  const actual = await original<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: (
      _issuerUrl: URL,
      options: Parameters<typeof actual.createRemoteJWKSet>[1],
    ) => actual.createRemoteJWKSet(new URL(simulation.jwksUrl), options),
  };
});

const config = mcpConfigFixture();
const binding = config.bindings[0];
if (!binding) throw new Error("Missing simulator binding");
const problemIds = ["sim-live", "sim-retired", "sim-race"];
const jobs: Record<string, string> = Object.fromEntries(
  [...problemIds, "sim-foreign"].map((id, index) => [id, `01HZX0K3M3K9ZQHB3MRQHBA1B${index + 3}`]),
);
function jobId(problem: string): string {
  const id = jobs[problem];
  if (!id) throw new Error("Unknown simulator problem");
  return id;
}
binding.jobIds = problemIds.map(jobId);
const AT = "2026-09-06T00:00:00.000Z";
const EXPIRES = 4_102_444_800;
const scoring = { kind: "flag" as const, flagOutputKey: "Flag", points: 10, wrongAnswerPenalty: 2 };
const catalog = executionCatalogSchema.parse({
  version: 1,
  catalog: Object.fromEntries(problemIds.map((id) => [id, `problems/challenges/${id}`])),
  scoring: Object.fromEntries(problemIds.map((id) => [id, scoring])),
  hints: {},
  endpoints: {},
  phases: {},
  visibility: {},
  runtimes: {},
  disruptions: {},
  writeups: {},
  provenance: {},
  coordination: {},
  plugins: {},
  sources: {},
  publicMetadata: Object.fromEntries(
    problemIds.map((id) => [
      id,
      {
        id,
        name: `Simulator ${id}`,
        category: "Challenge",
        status: "ready",
        difficulty: "beginner",
        estimatedDuration: 10,
        shortDescription: "Offline simulator exercise",
        tags: [],
        learningGoals: [],
      },
    ]),
  ),
  instructions: Object.fromEntries(
    problemIds.map((id) => [
      id,
      { instructions: `Published exercise ${id}: find and submit the flag.` },
    ]),
  ),
  sourceArchive: { bucket: "simulator-fixture", key: "unused-source.zip", versionId: "fixture-1" },
});
const catalogBytes = Buffer.from(JSON.stringify(catalog));
const catalogKey = `catalogs/${contentDigest(catalogBytes)}.json`;
const loadCatalog = createCatalogLoader({
  artifactBucket: "simulator-fixture",
  s3: {
    send: async (command: { input: { Key?: string } }) => {
      if (command.input.Key !== catalogKey) throw new Error("Unknown simulator artifact");
      return {
        ContentLength: catalogBytes.byteLength,
        Body: {
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(catalogBytes);
                controller.close();
              },
            }),
        },
      };
    },
  } as unknown as Pick<S3Client, "send">,
});
let repository: DeploymentsRepository;
let server: Server;
let endpoint: URL;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let jwksReads = 0;
let httpRequests = 0;
const clients: Client[] = [];

function deployment(problemId: string, teamId = binding.teamId): DeploymentRecord {
  return {
    jobId: jobId(problemId),
    tenantId: binding.tenantId,
    eventId: binding.eventId,
    teamId,
    problemId,
    catalogKey,
    status: "COMPLETE",
    awsAccountId: "123456789012",
    region: "ap-northeast-1",
    teamName: "simulator",
    namePrefix: "tc-simulator",
    teamLoginKey: "synthetic-local-team-key",
    createdAt: AT,
    updatedAt: AT,
    expiresAt: EXPIRES,
    score: 0,
    stackOutputs: JSON.stringify({ Flag: "simulator-answer" }),
  };
}
async function signedToken(overrides: Record<string, unknown> = {}, signing = keys) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: mcpIssuer(config),
    aud: config.resourceUrl,
    sub: binding.subject,
    iat: now,
    exp: now + 300,
    token_use: "access",
    client_id: "simulator-client",
    scope: `${config.resourceUrl}/read ${config.resourceUrl}/submit`,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "simulator-key" })
    .sign(signing.privateKey);
}
async function connect(token: string) {
  const client = new Client({ name: "tenkacloud-http-simulator", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  const text = content.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error("Missing MCP result");
  return { isError: result.isError, value: JSON.parse(text) };
}
async function initialize(token?: string, origin?: string) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "simulator", version: "1" },
      },
    }),
  });
}

async function simulatedLambdaRequest(request: IncomingMessage): Promise<Request> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part));
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  // Simulate the Lambda HTTP adapter's configured public HTTPS URL at a loopback gateway.
  // This does not test public TLS, DNS, Cognito Hosted UI or authorization-code exchange.
  return new Request(new URL(request.url ?? "/", config.resourceUrl), {
    method: request.method,
    headers,
    ...(["GET", "HEAD"].includes(request.method ?? "GET") ? {} : { body: Buffer.concat(parts) }),
  });
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  publicJwk = await exportJWK(keys.publicKey);
  simulation.shared = {
    runtime: {
      resolveDeploymentsRepository: async () => repository,
      resolveEventsRepository: async () => ({
        getEvent: async () => ({
          tenantId: binding.tenantId,
          eventId: binding.eventId,
          status: "READY",
          startsAt: AT,
          catalogKey,
        }),
      }),
    },
    problemsScoring: Object.fromEntries(problemIds.map((id) => [id, scoring])),
    coordinationProblemIds: [],
    catalogLoader: async (key: string | undefined) => {
      if (!key) throw new Error("Simulator catalog pin missing");
      return loadCatalog(key);
    },
  } as unknown as ParticipantSharedResources;
  vi.stubEnv("MCP_OAUTH_CONFIG", JSON.stringify(config));
  vi.stubEnv("MCP_OAUTH_CLIENT_ID", "simulator-client");
  const { app } = await import("../../lib/problem-deploy/handlers/participant-handler/index");
  server = createServer(async (request, response) => {
    try {
      httpRequests++;
      if (request.url === "/simulator-jwks") {
        jwksReads++;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256", kid: "simulator-key" }] }),
        );
        return;
      }
      const incoming = await simulatedLambdaRequest(request);
      const result = await app.fetch(incoming);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500);
      response.end("Simulator adapter failed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Simulator address missing");
  endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  simulation.jwksUrl = new URL("/simulator-jwks", endpoint).href;
});
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.unstubAllEnvs();
});

for (const backend of ["sqlite", "dynamodb"] as const) {
  describe(`remote MCP over real loopback HTTP with simulated Cognito JWKS and ${backend}`, () => {
    beforeEach(async () => {
      participantRateLimiter.reset();
      vi.stubEnv("MCP_OAUTH_CONFIG", JSON.stringify(config));
      repository =
        backend === "sqlite"
          ? new SqlDeploymentsRepository(makeSqliteExecutor())
          : new DynamoDbDeploymentsRepository(makeFakeDdb(), "SimulatorDeployments");
      for (const id of problemIds) await repository.putDeployment(deployment(id));
      await repository.putDeployment(deployment("sim-foreign", "foreign-team"));
    });
    it("runs challenge, signed authentication, initialize, tool discovery, narrative, submission and score history", async () => {
      const challenge = await initialize();
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/mcp");
      const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", endpoint));
      expect(await metadata.json()).toMatchObject({
        resource: config.resourceUrl,
        authorization_servers: [mcpIssuer(config)],
      });
      const client = await connect(await signedToken());
      expect(client.getServerVersion()?.name).toBe("tenkacloud-cloud-participant");
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "get_problem",
        "get_score_events",
        "list_problems",
        "submit_flag",
      ]);
      const list = await call(client, "list_problems");
      expect(list.value.data.problems).toHaveLength(3);
      expect(list.value.data.problemCatalog).toHaveLength(3);
      expect(JSON.stringify(list.value)).not.toContain("sim-foreign");
      const detail = await call(client, "get_problem", { problem_id: "sim-live" });
      expect(detail.value.data.problems).toHaveLength(1);
      expect(detail.value.data.problemCatalog).toHaveLength(1);
      expect(detail.value.data.problemCatalog[0]).toMatchObject({
        id: "sim-live",
        name: "Simulator sim-live",
      });
      expect(detail.value.data.problems[0].instructions).toContain("Published exercise sim-live");
      const wrong = await call(client, "submit_flag", { problem_id: "sim-live", flag: "wrong" });
      expect(wrong.value.data).toMatchObject({ kind: "wrong", scoreDelta: -2, wrongCount: 1 });
      const correct = await call(client, "submit_flag", {
        problem_id: "sim-live",
        flag: "simulator-answer",
      });
      expect(correct.value.data).toMatchObject({ kind: "ok", scoreDelta: 10, totalScore: 8 });
      expect(
        (await call(client, "submit_flag", { problem_id: "sim-live", flag: "simulator-answer" }))
          .value.data.kind,
      ).toBe("already_scored");
      expect((await call(client, "get_score_events")).value.data.entries).toHaveLength(2);
      expect((await repository.getDeployment(jobId("sim-live")))?.score).toBe(8);
      const limited = await call(client, "submit_flag", {
        problem_id: "sim-live",
        flag: "simulator-answer",
      });
      expect(limited.isError).toBe(true);
      expect(limited.value.status).toBe(429);
      expect((await repository.getDeployment(jobId("sim-live")))?.score).toBe(8);
      expect(jwksReads).toBeGreaterThan(0);
      expect(httpRequests).toBeGreaterThan(10);
    });
    it("rejects invalid credentials and cross-team data and withholds write tools for read-only scope", async () => {
      const otherKeys = await generateKeyPair("RS256");
      const invalid = ["synthetic-local-team-key", await signedToken({}, otherKeys)];
      for (const claims of [
        { iss: "https://attacker.invalid" },
        { aud: "https://other.invalid/mcp" },
        { client_id: "organizer-client" },
        { token_use: "id" },
        { scope: "openid" },
        { sub: "00000000-0000-4000-8000-000000000099" },
        { exp: 1 },
      ])
        invalid.push(await signedToken(claims));
      for (const token of invalid) expect((await initialize(token)).status).toBe(401);
      expect((await initialize(await signedToken(), "https://attacker.invalid")).status).toBe(403);
      const client = await connect(await signedToken({ scope: `${config.resourceUrl}/read` }));
      expect((await client.listTools()).tools.some((tool) => tool.name === "submit_flag")).toBe(
        false,
      );
      expect((await call(client, "get_problem", { problem_id: "sim-foreign" })).value.status).toBe(
        404,
      );
      await expect(
        client.callTool({
          name: "submit_flag",
          arguments: { problem_id: "sim-live", flag: "simulator-answer" },
        }),
      ).rejects.toThrow("Tool submit_flag not found");
      expect((await repository.getDeployment(jobId("sim-live")))?.score).toBe(0);
      expect((await call(client, "get_score_events")).value.data.entries).toEqual([]);
    });
    it("fails closed for missing or invalid deployment configuration and the wrong resource origin", async () => {
      for (const raw of [undefined, "malformed"]) {
        vi.stubEnv("MCP_OAUTH_CONFIG", raw);
        expect(
          (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", endpoint))).status,
        ).toBe(503);
        expect((await initialize()).status).toBe(503);
      }
      vi.stubEnv(
        "MCP_OAUTH_CONFIG",
        JSON.stringify({ ...config, resourceUrl: "https://other.example.test/mcp" }),
      );
      expect((await initialize(await signedToken())).status).toBe(403);
    });
    it("rejects a pinned deployment whose current owner is another team", async () => {
      await repository.putDeployment(deployment("sim-race", "foreign-team"));
      expect((await initialize(await signedToken())).status).toBe(403);
      expect((await repository.getDeployment(jobId("sim-live")))?.score).toBe(0);
    });
    it("limits authenticated reads without returning more team data", async () => {
      const token = await signedToken();
      for (let i = 0; i < 60; i++) expect((await initialize(token)).status).toBe(200);
      const limited = await initialize(token);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBeTruthy();
    });
    it.each(["list_problems", "get_score_events"])(
      "denies %s if teardown wins between preflight and the read",
      async (tool) => {
        const client = await connect(await signedToken());
        const base = repository;
        await base.markDeleted(jobId("sim-retired"), AT);
        await base.markDeleted(jobId("sim-race"), AT);
        let reads = 0;
        repository = new Proxy(base, {
          get(target, property) {
            if (property === "getDeployment")
              return async (...args: Parameters<DeploymentsRepository["getDeployment"]>) => {
                if (args[0] === jobId("sim-live") && ++reads === 2)
                  await base.markDeleting(args[0], binding.tenantId, AT, EXPIRES);
                return base.getDeployment(...args);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = await call(client, tool);
        expect(result.isError).toBe(true);
        expect(result.value.status).toBe(403);
        expect((await base.getDeployment(jobId("sim-live")))?.score).toBe(0);
      },
    );
    it("denies retained deleted and teardown-FAILED jobs mixed with a live job through HTTP tools", async () => {
      await repository.markDeleted(jobId("sim-retired"), AT);
      await repository.markDeleting(jobId("sim-race"), binding.tenantId, AT, EXPIRES);
      await repository.compensateDeleteToFailed(
        jobId("sim-race"),
        binding.tenantId,
        "simulated cleanup failure",
        AT,
        EXPIRES,
      );
      const client = await connect(await signedToken());
      expect(
        (await call(client, "list_problems")).value.data.problems.map(
          (problem: { problemId: string }) => problem.problemId,
        ),
      ).toEqual(["sim-live"]);
      for (const id of ["sim-retired", "sim-race"]) {
        expect((await call(client, "get_problem", { problem_id: id })).value.status).toBe(404);
        const denied = await call(client, "submit_flag", {
          problem_id: id,
          flag: "simulator-answer",
        });
        expect(denied.isError).toBe(true);
        expect(denied.value.status).toBe(401);
        expect((await repository.getDeployment(jobId(id)))?.score).toBe(0);
        expect(await repository.listScoreEvents(jobId(id), { pageSize: 20 })).toEqual([]);
      }
    });
    it("denies teardown racing the HTTP submission after authorization and before persistent mutation", async () => {
      const base = repository;
      repository = new Proxy(base, {
        get(target, property) {
          if (property === "applyFlagCorrectScore")
            return async (...args: Parameters<DeploymentsRepository["applyFlagCorrectScore"]>) => {
              await base.markDeleting(args[0], binding.tenantId, AT, EXPIRES);
              await base.compensateDeleteToFailed(
                args[0],
                binding.tenantId,
                "simulated cleanup failure",
                AT,
                EXPIRES,
              );
              return base.applyFlagCorrectScore(...args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const client = await connect(await signedToken());
      const denied = await call(client, "submit_flag", {
        problem_id: "sim-race",
        flag: "simulator-answer",
      });
      expect(denied.isError).toBe(true);
      expect(denied.value.status).toBe(401);
      expect(await base.getDeployment(jobId("sim-race"))).toMatchObject({
        status: "FAILED",
        teardownRequestedAt: AT,
        score: 0,
      });
      expect(await base.listScoreEvents(jobId("sim-race"), { pageSize: 20 })).toEqual([]);
      expect((await call(client, "get_problem", { problem_id: "sim-live" })).value.status).toBe(
        200,
      );
    });
  });
}
