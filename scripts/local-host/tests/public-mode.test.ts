import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as transport from "../../lib/node-http";
import { localCompetitionEngine } from "../application";
import { parseGatewayPorts } from "../gateway-ports";
import { startHttpHost } from "../http";
import { definitionKind } from "../model";
import { type PublicExposure, parseOptions } from "../options";
import { type RunningLocalHost, startLocalHost } from "../server";
import { HistoricalCompetitionEngine as CompetitionEngine } from "./historical-competition-fixture";

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
const codespaces = {
  CODESPACES: "true",
  CODESPACE_NAME: "fixture-codespace-abc123",
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
};

test("Codespaces derives exact HTTPS origins from validated environment and selected ports", () => {
  const options = parseOptions([], root, codespaces);
  expect(options.public).toEqual({
    adminOrigin: "https://fixture-codespace-abc123-5174.app.github.dev",
    participantOrigin: "https://fixture-codespace-abc123-5175.app.github.dev",
    behindProxy: false,
  });
  expect(options.hostname).toBe("0.0.0.0");
  const changed = parseOptions(
    ["--admin-port", "6100", "--participant-port", "6101"],
    root,
    codespaces,
  );
  expect(changed.public?.adminOrigin).toBe("https://fixture-codespace-abc123-6100.app.github.dev");
  expect(changed.public?.participantOrigin).toBe(
    "https://fixture-codespace-abc123-6101.app.github.dev",
  );
});

test("Codespaces preserves explicit origins and networking choices without enabling proxy trust", () => {
  expect(parseOptions(publicArgs, root, { CODESPACES: "true" }).public?.adminOrigin).toBe(ADMIN);
  expect(() => parseOptions(["--public-admin-origin", ADMIN], root, codespaces)).toThrow(
    "Give both",
  );
  const lan = parseOptions(["--lan", sharedAddresses[1], "--unsafe-lan"], root, codespaces);
  expect(lan.public).toBeUndefined();
  expect(lan.hostname).toBe(sharedAddresses[1]);
  expect(parseOptions([], root, { ...codespaces, CODESPACES: "false" }).hostname).toBe("127.0.0.1");
  expect(parseOptions([], root, {}).public).toBeUndefined();
});

test("Codespaces preserves explicit native VPN/appliance configuration and excludes Compose in its default factory", () => {
  // eslint-disable-next-line sonarjs/no-hardcoded-ip -- Parser-only private pool fixture.
  const isolated = ["--competition-network", "--docker-network-pool", "10.240.0.0/16"];
  const vpn = parseOptions([...isolated, "--vpn-peers", "/fixture/peers.json"], root, codespaces);
  expect(vpn.public).toBeUndefined();
  expect(vpn.vpnPeerPath).toBe("/fixture/peers.json");
  const appliance = parseOptions(
    [
      ...isolated,
      "--console-origin",
      PLAY,
      "--web-origin-template",
      "https://{target}.labs.example.test",
    ],
    root,
    codespaces,
  );
  expect(appliance.public).toBeUndefined();
  expect(appliance.hostname).toBe("127.0.0.1");
  const directory = mkdtempSync(join(tmpdir(), "tenka-codespaces-factory-"));
  directories.push(directory);
  const engine = localCompetitionEngine(root, directory, parseOptions([], root, codespaces));
  expect(engine.catalog().some((problem) => problem.problemId === "crypto-battle")).toBe(true);
  expect(engine.catalog().some((problem) => definitionKind(problem.definition) === "compose")).toBe(
    false,
  );
});

test("incomplete or unsafe Codespaces metadata fails before opening listeners", () => {
  for (const name of [
    "",
    "with.dot",
    "UPPER",
    "-leading",
    "trailing-",
    "a".repeat(64),
    "name/path",
  ])
    expect(() => parseOptions([], root, { ...codespaces, CODESPACE_NAME: name })).toThrow(
      "Codespaces",
    );
  for (const domain of [
    undefined,
    "",
    "evil.test",
    "app.github.dev.evil.test",
    "https://app.github.dev",
    "*.app.github.dev",
  ])
    expect(() =>
      parseOptions([], root, { ...codespaces, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain }),
    ).toThrow("Codespaces");
  expect(() => parseOptions([], root, { CODESPACES: "true" })).toThrow("Codespaces");
});

test("Codespaces HTTP accepts only the selected forwarded origins and retains organizer authentication", async () => {
  const exposure = parseOptions([], root, codespaces).public;
  expect(exposure).toBeDefined();
  const { adminPort, participantPort } = await host({ public: true, exposure });
  const adminHost = new URL(exposure?.adminOrigin ?? "").host;
  const playHost = new URL(exposure?.participantOrigin ?? "").host;
  const adminConfig = await call(adminPort, { path: "/runtime-config.json", host: adminHost });
  expect(adminConfig.status).toBe(200);
  expect(adminConfig.body.participantPortalUrl).toBe(exposure?.participantOrigin);
  expect(
    (await call(participantPort, { path: "/runtime-config.json", host: playHost })).status,
  ).toBe(200);
  expect(
    (await call(participantPort, { path: "/runtime-config.json", host: adminHost })).status,
  ).toBe(403);
  expect(
    (
      await call(participantPort, {
        path: "/runtime-config.json",
        host: "another-5175.app.github.dev",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(participantPort, {
        path: "/runtime-config.json",
        host: playHost,
        headers: { origin: ADMIN },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(adminPort, {
        path: "/api/host/login",
        method: "POST",
        host: adminHost,
        headers: { origin: exposure?.adminOrigin ?? "" },
        body: { key: INVALID_KEY },
      })
    ).status,
  ).toBe(401);
});

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

// Parser/transport test vectors only; no shared-address interface is opened.
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC6598 boundary fixtures, never real host addresses.
const sharedAddresses = ["100.64.0.0", "100.96.12.34", "100.127.255.255"] as const;

test("explicit LAN hosting accepts one shared-address IPv4 and still requires acknowledgement", () => {
  expect(parse().hostname).toBe("127.0.0.1");
  for (const address of sharedAddresses) {
    const options = parse("--lan", address, "--unsafe-lan");
    expect(options.hostname).toBe(address);
    expect(options.public).toBeUndefined();
    expect(() => parse("--lan", address)).toThrow("Add --unsafe-lan");
  }
  for (const address of [
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- parser rejection fixture; no connection.
    "100.63.255.255",
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- parser rejection fixture; no connection.
    "100.128.0.0",
    "100.64.0.256",
    "100.064.0.1",
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- parser rejection fixture; no connection.
    "100.64.0.1/32",
    "0.0.0.0",
    "::",
    "example.test",
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- parser rejection fixture; no connection.
    "8.8.8.8",
  ]) {
    expect(() => parse("--lan", address, "--unsafe-lan")).toThrow("explicit private IPv4");
  }
});

test("shared-address hosting keeps admin loopback, exact participant URLs and origin checks", async () => {
  const address = sharedAddresses[1];
  const original = transport.listen;
  const binds: string[] = [];
  // Exercise server wiring on ephemeral loopback sockets without publishing a real interface.
  const listener = spyOn(transport, "listen").mockImplementation(async (server, hostname) => {
    binds.push(hostname);
    const bound = new URL(await original(server, "127.0.0.1", 0));
    bound.hostname = hostname;
    return bound.origin;
  });
  let started: Awaited<ReturnType<typeof host>> | undefined;
  try {
    started = await host({ public: false, hostname: address, dynamicPorts: true });
  } finally {
    listener.mockRestore();
  }
  const { adminPort, participantPort } = started;
  expect(binds).toEqual([address, "127.0.0.1"]);
  const participantHost = `${address}:${participantPort}`;
  const participantOrigin = `http://${participantHost}`;
  const config = await call(participantPort, {
    path: "/runtime-config.json",
    host: participantHost,
  });
  expect(config.status).toBe(200);
  expect(config.body.apiBaseUrl).toBe(`${participantOrigin}/api`);
  const admin = await call(adminPort, {
    path: "/runtime-config.json",
    host: `127.0.0.1:${adminPort}`,
  });
  expect(admin.body.participantPortalUrl).toBe(participantOrigin);
  expect(
    (await call(participantPort, { path: "/healthz", host: `127.0.0.1:${participantPort}` }))
      .status,
  ).toBe(403);
  expect(
    (
      await call(participantPort, {
        path: "/healthz",
        host: participantHost,
        headers: { origin: participantOrigin },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(participantPort, {
        path: "/healthz",
        host: participantHost,
        headers: { origin: "http://other.example" },
      })
    ).status,
  ).toBe(403);
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

async function host(options: {
  public: boolean;
  behindProxy?: boolean;
  dynamicPorts?: boolean;
  hostname?: string;
  exposure?: PublicExposure;
}) {
  const data = mkdtempSync(join(tmpdir(), "tenka-public-"));
  directories.push(data);
  let adminPort = options.dynamicPorts ? 0 : await freePort();
  let participantPort = options.dynamicPorts ? 0 : await freePort();
  const started = await startLocalHost(
    root,
    {
      dataDirectory: data,
      hostname: options.public ? "0.0.0.0" : (options.hostname ?? "127.0.0.1"),
      adminPort,
      participantPort,
      gatewayPorts: parseGatewayPorts("5200-5239"),
      ...(options.public
        ? {
            public: options.exposure ?? {
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
  adminPort = started.admin.boundPort;
  participantPort = started.participant.boundPort;
  const bootstrap = await call(adminPort, {
    path: "/api/host/login",
    method: "POST",
    host: options.public
      ? new URL(options.exposure?.adminOrigin ?? ADMIN).host
      : `127.0.0.1:${adminPort}`,
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
  expect(catalog.body.items).toEqual(
    ["crypto-battle", "forensic-casebook"].map((problemId) => ({
      problemId,
      name: expect.any(String),
      runtime: "coordination",
      content: {
        description: expect.any(String),
        learningGoals: expect.arrayContaining([expect.any(String)]),
        i18n: {
          en: {
            description: expect.any(String),
            learningGoals: expect.arrayContaining([expect.any(String)]),
          },
        },
      },
    })),
  );
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

test("dynamic listeners reserve their actual ports and allow dormant Docker preparation", async () => {
  const { started, adminPort, participantPort, adminToken } = await host({
    public: false,
    dynamicPorts: true,
  });
  expect(adminPort).toBeGreaterThan(0);
  expect(participantPort).toBeGreaterThan(0);
  expect(adminPort).not.toBe(participantPort);
  expect(Number(new URL(started.admin.origin).port)).toBe(adminPort);
  const fields = {
    method: "POST",
    host: `127.0.0.1:${adminPort}`,
    headers: { authorization: `Bearer ${adminToken}` },
  };
  const created = await call(adminPort, {
    ...fields,
    path: "/api/events",
    body: {
      name: "Dynamic listener preparation",
      teams: [{ internalSlug: "team" }],
      problems: [{ problemId: "sqli-demo" }],
    },
  });
  expect(created.status).toBe(201);
  const deploy = await call(adminPort, {
    ...fields,
    path: `/api/events/${String(created.body.eventId)}/deploy`,
    body: {},
  });
  expect(deploy.status).toBe(202);
});

test("dynamic listeners cannot consume a declared gateway port", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-listener-overlap-"));
  directories.push(data);
  await expect(
    startLocalHost(
      root,
      {
        dataDirectory: data,
        hostname: "127.0.0.1",
        adminPort: 0,
        participantPort: 0,
        gatewayPorts: parseGatewayPorts("1024-65535"),
      },
      (directory) => new CompetitionEngine(root, directory, false),
      () => undefined,
    ),
  ).rejects.toThrow("overlaps listener port");
});
