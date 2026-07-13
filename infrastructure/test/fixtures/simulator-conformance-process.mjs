import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";

const protocol = "2026-07-11";
const host = process.env.TENKACLOUD_SIMULATOR_HOST;
const port = Number(process.env.TENKACLOUD_SIMULATOR_PORT);
const publicOrigin = process.env.TENKACLOUD_SIMULATOR_PUBLIC_ORIGIN ?? `http://${host}:${port}`;
const stateDir = process.env.TENKACLOUD_SIMULATOR_STATE_DIR;
const secretValue = process.env.TENKACLOUD_SIMULATOR_LAUNCH_SECRET;
const awsAccessKeyId = process.env.TENKACLOUD_SIMULATOR_AWS_ACCESS_KEY_ID;
const azureCredential = process.env.TENKACLOUD_SIMULATOR_AZURE_CREDENTIAL;
const gcpCredential = process.env.TENKACLOUD_SIMULATOR_GCP_CREDENTIAL;
const sakuraCredential = process.env.TENKACLOUD_SIMULATOR_SAKURA_CREDENTIAL;
const inheritedHostCredentials = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "SAKURACLOUD_ACCESS_TOKEN",
].filter((name) => process.env[name] !== undefined);
const workloadPolicy = {
  allowedImages: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_ALLOWED_IMAGES,
  maxMemoryBytes: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MEMORY_BYTES,
  maxMilliCpu: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_MAX_MILLI_CPU,
  maxPids: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_MAX_PIDS,
  proxyImage: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_PROXY_IMAGE,
  controlContainer: process.env.TENKACLOUD_SIMULATOR_WORKLOAD_CONTROL_CONTAINER,
};

if (host !== "127.0.0.1" || !Number.isInteger(port) || !stateDir || !secretValue) {
  throw new Error("Simulator conformance process environment is invalid");
}
if (
  !/^TCSIM[A-Z0-9]{11,123}$/.test(awsAccessKeyId ?? "") ||
  !/^tcsim_[A-Za-z0-9_-]{16,128}$/.test(azureCredential ?? "") ||
  !/^tcsim_[A-Za-z0-9_-]{16,128}$/.test(gcpCredential ?? "") ||
  !/^tcsim_[A-Za-z0-9_-]{16,128}:tcsim_[A-Za-z0-9_-]{16,128}$/.test(sakuraCredential ?? "")
) {
  throw new Error("Simulator conformance native credentials are invalid");
}
const secret = Buffer.from(secretValue, "base64url");
if (secret.byteLength < 32) throw new Error("Simulator conformance secret is too short");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const worlds = new Map();

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-tenkacloud-simulator-protocol": protocol,
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function claims(request) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer tc_sim_v1.")) throw new Error("missing launch token");
  const token = header.slice("Bearer ".length);
  const [prefix, payload, signature] = token.split(".");
  const expected = createHmac("sha256", secret).update(`${prefix}.${payload}`).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (prefix !== "tc_sim_v1" || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("invalid launch token");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function deployment(world) {
  return {
    deploymentId: world.deploymentId,
    status: "running",
    outputs: {
      ParameterName: "/local/hello",
      ParameterValue: "TC{simulated}",
      InstanceId: "i-simulator",
      BaseUrl: publicOrigin,
    },
    diagnostics: [],
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", publicOrigin);
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      json(response, StatusCodes.OK, {
        protocolVersion: protocol,
        simulatorVersion: "conformance-process",
        providers: {
          aws: { engines: { cloudformation: { operations: ["deploy", "delete", "get", "capabilities", "world"] } } },
          gcp: { engines: { "infra-manager": { operations: ["deploy", "delete", "get", "capabilities", "world"] } } },
        },
        workloadPolicy,
        inheritedHostCredentials,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/workload/meta") {
      json(response, StatusCodes.OK, { platform: "ec2" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/workload/score") {
      json(response, StatusCodes.OK, { ok: true });
      return;
    }
    const tokenClaims = claims(request);
    if (request.method === "POST" && url.pathname === "/v1/worlds") {
      const input = await body(request);
      if (
        input.tenantId !== tokenClaims.tenantId ||
        input.eventId !== tokenClaims.eventId ||
        input.teamId !== tokenClaims.teamId ||
        input.deploymentId !== tokenClaims.deploymentId
      ) {
        throw new Error("namespace mismatch");
      }
      const worldId = `world-${input.deploymentId}`;
      worlds.set(worldId, { ...input, worldId, deploymentId: input.deploymentId });
      writeFileSync(join(stateDir, "worlds.json"), JSON.stringify([...worlds.values()]));
      json(response, StatusCodes.CREATED, {
        worldId,
        consoleUrl: `${publicOrigin}/console/${encodeURIComponent(worldId)}`,
      });
      return;
    }
    const deploymentMatch = /^\/v1\/worlds\/([^/]+)\/deployments(?:\/([^/]+))?$/.exec(url.pathname);
    if (deploymentMatch) {
      const world = worlds.get(decodeURIComponent(deploymentMatch[1]));
      if (!world || world.deploymentId !== tokenClaims.deploymentId) {
        json(response, StatusCodes.NOT_FOUND, { error: { code: "NotFound" } });
        return;
      }
      if (request.method === "POST" && !deploymentMatch[2]) {
        world.request = await body(request);
        writeFileSync(join(stateDir, "worlds.json"), JSON.stringify([...worlds.values()]));
        json(response, StatusCodes.CREATED, deployment(world));
        return;
      }
      if (request.method === "GET" && deploymentMatch[2] === world.deploymentId) {
        json(response, StatusCodes.OK, deployment(world));
        return;
      }
    }
    const snapshotMatch = /^\/v1\/worlds\/([^/]+)\/snapshots$/.exec(url.pathname);
    if (snapshotMatch) {
      const world = worlds.get(decodeURIComponent(snapshotMatch[1]));
      if (!world) {
        json(response, StatusCodes.NOT_FOUND, { error: { code: "NotFound" } });
        return;
      }
      if (request.method === "GET") {
        json(response, StatusCodes.OK, {
          snapshotVersion: "1",
          protocolVersion: protocol,
          worldId: world.worldId,
          namespace: { tenantId: world.tenantId, eventId: world.eventId, teamId: world.teamId },
          seed: "conformance",
          clock: "2026-01-01T00:00:00.000Z",
          lastSequence: 1,
          resourceGraph: {},
          providerProjections: {},
          hash: "conformance",
        });
        return;
      }
      if (request.method === "POST") {
        await body(request);
        json(response, StatusCodes.CREATED, {
          worldId: world.worldId,
          consoleUrl: `${publicOrigin}/console/${encodeURIComponent(world.worldId)}`,
        });
        return;
      }
    }
    const clockMatch = /^\/v1\/worlds\/([^/]+)\/clock\/advance$/.exec(url.pathname);
    if (request.method === "POST" && clockMatch) {
      const world = worlds.get(decodeURIComponent(clockMatch[1]));
      if (!world) {
        json(response, StatusCodes.NOT_FOUND, { error: { code: "NotFound" } });
        return;
      }
      const input = await body(request);
      if (!Number.isSafeInteger(input.milliseconds) || input.milliseconds <= 0) {
        throw new Error("clock advance milliseconds must be a positive safe integer");
      }
      world.clockAdvances ??= [];
      world.clockAdvances.push(input.milliseconds);
      writeFileSync(join(stateDir, "worlds.json"), JSON.stringify([...worlds.values()]));
      json(response, StatusCodes.OK, {
        clock: new Date(Date.UTC(2026, 0, 1) + input.milliseconds).toISOString(),
        appliedTransitions: [{ provider: "aws", transitionId: "degraded" }],
      });
      return;
    }
    const operationMatch =
      /^\/v1\/worlds\/([^/]+)\/providers\/([^/]+)\/operations\/([^/]+)$/.exec(url.pathname);
    if (request.method === "POST" && operationMatch) {
      const world = worlds.get(decodeURIComponent(operationMatch[1]));
      if (!world) {
        json(response, StatusCodes.NOT_FOUND, { error: { code: "NotFound" } });
        return;
      }
      const command = await body(request);
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
        throw new Error("missing provider operation idempotency key");
      }
      const provider = decodeURIComponent(operationMatch[2]);
      const operation = decodeURIComponent(operationMatch[3]);
      world.providerOperations ??= [];
      world.providerOperations.push({ provider, operation, idempotencyKey, command });
      writeFileSync(join(stateDir, "worlds.json"), JSON.stringify([...worlds.values()]));
      if (operation === "AttackProbe") {
        json(response, StatusCodes.OK, {
          provider,
          operation,
          StatusCode: StatusCodes.FORBIDDEN,
          Landed: false,
        });
        return;
      }
      json(response, StatusCodes.OK, {
        provider,
        operation,
        command,
      });
      return;
    }
    const worldMatch = /^\/v1\/worlds\/([^/]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && worldMatch) {
      worlds.delete(decodeURIComponent(worldMatch[1]));
      writeFileSync(join(stateDir, "worlds.json"), JSON.stringify([...worlds.values()]));
      response.writeHead(StatusCodes.NO_CONTENT, { "x-tenkacloud-simulator-protocol": protocol });
      response.end();
      return;
    }
    json(response, StatusCodes.NOT_FOUND, { error: { code: "NotFound" } });
  } catch (error) {
    json(response, StatusCodes.UNAUTHORIZED, {
      error: { code: "UnauthorizedOperation", message: error instanceof Error ? error.message : String(error) },
    });
  }
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
