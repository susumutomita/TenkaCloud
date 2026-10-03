import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { parseGatewayPorts } from "../gateway-ports";
import { startHttpHost } from "../http";
import { parseOptions } from "../options";
import { type RunningLocalHost, startLocalHost } from "../server";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ADMIN = "https://admin.example.test";
const PLAY = "https://play.example.test";
const INVALID_KEY = "wrong";
const running: RunningLocalHost[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const parse = (...args: string[]) => parseOptions(args, root);
const publicArgs = ["--public-admin-origin", ADMIN, "--public-participant-origin", PLAY];

test("public origins bind every interface and keep both origins", () => {
  const options = parse(...publicArgs, "--behind-proxy");
  expect(options.hostname).toBe("0.0.0.0");
  expect(options.public).toEqual({
    adminOrigin: ADMIN,
    participantOrigin: PLAY,
    behindProxy: true,
  });
  expect(parse().public).toBeUndefined();
});

test("the hosted image refuses to start without public origins", () => {
  const image = { TENKACLOUD_HOST_REQUIRE_PUBLIC: "1" };
  expect(() => parseOptions([], root, image)).toThrow("This image runs behind a TLS proxy.");
  expect(parseOptions(publicArgs, root, image).public?.adminOrigin).toBe(ADMIN);
});

test("public origins are refused when they could expose the host console unsafely", () => {
  expect(() =>
    parse(
      "--public-admin-origin",
      "http://admin.example.test",
      "--public-participant-origin",
      PLAY,
    ),
  ).toThrow("uses HTTP");
  expect(() => parse("--public-admin-origin", ADMIN)).toThrow("Give both");
  expect(() =>
    parse("--public-admin-origin", `${ADMIN}/console`, "--public-participant-origin", PLAY),
  ).toThrow("must be an origin only");
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC1918 parser test vector; no connection is made.
  expect(() => parse(...publicArgs, "--lan", "192.168.1.10", "--unsafe-lan")).toThrow(
    "either --lan or the public origins",
  );
  expect(() => parse("--behind-proxy")).toThrow("need the public origins");
  expect(() => parse("--public-admin-origin", ADMIN, "--public-participant-origin", ADMIN)).toThrow(
    "different origins",
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  await new Promise<void>((accept) => server.close(() => accept()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function host(options: { public: boolean; behindProxy?: boolean }) {
  const data = mkdtempSync(join(tmpdir(), "tenka-public-"));
  directories.push(data);
  const adminPort = await freePort();
  const participantPort = await freePort();
  const started = await startLocalHost(
    root,
    {
      dataDirectory: data,
      hostname: options.public ? "0.0.0.0" : "127.0.0.1",
      adminPort,
      participantPort,
      gatewayPorts: parseGatewayPorts("5200-5239"),
      ...(options.public
        ? {
            public: {
              adminOrigin: ADMIN,
              participantOrigin: PLAY,
              behindProxy: options.behindProxy ?? false,
            },
          }
        : {}),
    },
    (directory) => new CompetitionEngine(root, directory, !options.public),
    () => undefined,
  );
  running.push(started);
  const bootstrap = await call(adminPort, {
    path: "/api/host/login",
    method: "POST",
    host: options.public ? "admin.example.test" : `127.0.0.1:${adminPort}`,
    body: { key: started.organizerKey },
  });
  if (bootstrap.status !== 200) throw new Error("Public-mode organizer-key sign-in failed.");
  return { started, adminPort, participantPort, adminToken: String(bootstrap.body.idToken) };
}

function call(
  port: number,
  fields: {
    path: string;
    host: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = fields.body === undefined ? undefined : JSON.stringify(fields.body);
  return new Promise((accept, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path: fields.path,
        method: fields.method ?? "GET",
        headers: {
          host: fields.host,
          ...(payload ? { "content-type": "application/json" } : {}),
          ...fields.headers,
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () =>
          accept({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as Record<
              string,
              unknown
            >,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

test("the host console answers only at its advertised origin and links the advertised portal", async () => {
  const { adminPort } = await host({ public: true });
  const wrong = await call(adminPort, {
    path: "/runtime-config.json",
    host: `127.0.0.1:${adminPort}`,
  });
  expect(wrong.status).toBe(403);
  expect(wrong.body.message).toBe("Untrusted Host header. Expected admin.example.test.");

  const config = await call(adminPort, {
    path: "/runtime-config.json",
    host: "admin.example.test",
  });
  expect(config.status).toBe(200);
  expect(config.body).toEqual({
    mode: "local-host",
    apiBaseUrl: `${ADMIN}/api`,
    participantPortalUrl: PLAY,
    role: "admin",
    hasAws: false,
  });
});

test("health checks answer any Host only in public mode", async () => {
  const exposed = await host({ public: true });
  const health = await call(exposed.participantPort, { path: "/healthz", host: "10.0.0.5:8080" });
  expect(health).toEqual({
    status: 200,
    body: { status: "ok", mode: "local-host", role: "participant" },
  });
  const local = await host({ public: false });
  expect((await call(local.adminPort, { path: "/healthz", host: "10.0.0.5:8080" })).status).toBe(
    403,
  );
});

async function failLogins(port: number, forwardedFor: (attempt: number) => string, count: number) {
  for (let attempt = 0; attempt < count; attempt += 1)
    await call(port, {
      path: "/api/host/login",
      method: "POST",
      host: "admin.example.test",
      headers: { "x-forwarded-for": forwardedFor(attempt) },
      body: { key: INVALID_KEY },
    });
}

const login = (port: number, forwardedFor: string) =>
  call(port, {
    path: "/api/host/login",
    method: "POST",
    host: "admin.example.test",
    headers: { "x-forwarded-for": forwardedFor },
    body: { key: INVALID_KEY },
  });

test("behind a proxy, one client's failed logins do not lock out the others", async () => {
  const { adminPort } = await host({ public: true, behindProxy: true });
  await failLogins(adminPort, (attempt) => `forged-${attempt}, 203.0.113.5`, 10);
  expect((await login(adminPort, "anything, 203.0.113.5")).status).toBe(429);
  expect((await login(adminPort, "203.0.113.5, 198.51.100.7")).status).toBe(401);
});

test("without --behind-proxy, X-Forwarded-For is ignored", async () => {
  const { adminPort } = await host({ public: true });
  await failLogins(adminPort, (attempt) => `198.51.100.${attempt}`, 10);
  expect((await login(adminPort, "198.51.100.200")).status).toBe(429);
});

test("public mode offers only problems that need no per-team gateway", async () => {
  const { adminPort, adminToken } = await host({ public: true });
  const catalog = await call(adminPort, {
    path: "/api/host/catalog",
    host: "admin.example.test",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(catalog.body.items).toEqual([
    {
      problemId: "ac26-crypto-battle",
      name: expect.any(String),
      runtime: "coordination",
      content: {
        description: expect.any(String),
        learningGoals: expect.arrayContaining([expect.any(String)]),
      },
    },
  ]);
});

test("the host console refuses a non-loopback bind unless a proxy publishes it", async () => {
  const unused = {};
  await expect(
    startHttpHost({
      kind: "admin",
      hostname: "0.0.0.0",
      port: 0,
      staticRoot: root,
      service: unused as never,
    }),
  ).rejects.toThrow("The host console must bind to IPv4 loopback.");
});
