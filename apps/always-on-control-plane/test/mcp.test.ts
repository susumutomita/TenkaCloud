import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { organizerForTest, teamForTest } from "../src/auth.js";
import { mcpRequestWithoutCredentials, organizerMcpResourceMetadata } from "../src/mcp.js";

const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "tenkacloud-conformance-test",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

interface JsonRpcResponse {
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
  readonly result?: Record<string, unknown>;
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
  init: { readonly origin?: string; readonly protocolVersion?: string } = {},
): RequestInit {
  const protocolVersion = init.protocolVersion ?? PROTOCOL_VERSION;
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      host: "control.example",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          ...CLIENT_META,
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
        },
      },
    }),
  };
}

async function rpc(
  app: ReturnType<typeof createApp>,
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
): Promise<{ readonly response: Response; readonly body: JsonRpcResponse }> {
  const response = await app.request(
    `https://control.example${path}`,
    modernRequest(method, params, name),
    env,
  );
  return { response, body: (await response.json()) as JsonRpcResponse };
}

async function seedMcpData(): Promise<void> {
  const now = "2026-07-28T00:00:00.000Z";
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO events (event_id, tenant_id, name, status, created_at, updated_at)
       VALUES ('evt-a', 'tenant-a', 'Tenant A event', 'ACTIVE', ?, ?)`,
    ).bind(now, now),
    env.CONTROL_DB.prepare(
      `INSERT INTO events (event_id, tenant_id, name, status, created_at, updated_at)
       VALUES ('evt-b', 'tenant-b', 'Tenant B event', 'ACTIVE', ?, ?)`,
    ).bind(now, now),
    env.CONTROL_DB.prepare(
      `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
       VALUES ('team-a', 'evt-a', 'tenant-a', 'Alpha', 'login-hash-alpha', ?)`,
    ).bind(now),
    env.CONTROL_DB.prepare(
      `INSERT INTO teams (team_id, event_id, tenant_id, display_name, login_key_hash, created_at)
       VALUES ('team-other', 'evt-a', 'tenant-a', 'Secret rival', 'login-hash-rival', ?)`,
    ).bind(now),
  ]);
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `UPDATE score_summary
          SET score = 30, solved_checkpoints = 2, updated_at = ?
        WHERE event_id = 'evt-a' AND team_id = 'team-a'`,
    ).bind(now),
    env.CONTROL_DB.prepare(
      `UPDATE score_summary
          SET score = 999, solved_checkpoints = 9, updated_at = ?
        WHERE event_id = 'evt-a' AND team_id = 'team-other'`,
    ).bind(now),
    env.CONTROL_DB.prepare(
      `INSERT INTO runtime_score (event_id, team_id, points, updated_at)
       VALUES ('evt-a', 'team-a', 12, ?)`,
    ).bind(now),
    env.CONTROL_DB.prepare(
      `INSERT INTO challenge_checkpoints (
         event_id, problem_id, checkpoint_id, flag_hash, points
       ) VALUES ('evt-a', 'problem-secret', 'checkpoint-secret', 'flag-hash-secret', 10)`,
    ),
  ]);
}

beforeEach(async () => {
  await env.CONTROL_DB.exec(`
    DELETE FROM runtime_score;
    DELETE FROM submissions;
    DELETE FROM score_summary;
    DELETE FROM challenge_checkpoints;
    DELETE FROM teams;
    DELETE FROM events;
  `);
});

describe("MCP 2026-07-28 stateless role endpoints (#2819)", () => {
  it("should strip bearer and cookie credentials before SDK dispatch", () => {
    const sanitized = mcpRequestWithoutCredentials(
      new Request("https://control.example/mcp/organizer", {
        method: "POST",
        headers: {
          authorization: "Bearer raw-secret",
          cookie: "session=raw-secret",
          "proxy-authorization": "Basic raw-secret",
          "Mcp-Method": "tools/list",
        },
        body: "{}",
      }),
    );
    expect(sanitized.headers.get("authorization")).toBeNull();
    expect(sanitized.headers.get("cookie")).toBeNull();
    expect(sanitized.headers.get("proxy-authorization")).toBeNull();
    expect(sanitized.headers.get("Mcp-Method")).toBe("tools/list");
  });

  it("should discover the modern protocol without a session or sticky instance", async () => {
    const first = await rpc(createApp(), "/mcp/developer", "server/discover");
    const second = await rpc(createApp(), "/mcp/developer", "server/discover");

    expect(first.response.status).toBe(200);
    expect(first.response.headers.has("Mcp-Session-Id")).toBe(false);
    expect(first.body).toEqual(second.body);
    expect(first.body.result).toMatchObject({
      supportedVersions: [PROTOCOL_VERSION],
      resultType: "complete",
      cacheScope: "public",
    });
  });

  it("should reject legacy, unsupported, and inconsistent protocol envelopes", async () => {
    const app = createApp();
    const legacy = await app.request(
      "https://control.example/mcp/developer",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          host: "control.example",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy", version: "1" },
          },
        }),
      },
      env,
    );
    expect(((await legacy.json()) as JsonRpcResponse).error).toBeDefined();

    const unsupported = await app.request(
      "https://control.example/mcp/developer",
      modernRequest("server/discover", {}, undefined, {
        protocolVersion: "2099-01-01",
      }),
      env,
    );
    expect(((await unsupported.json()) as JsonRpcResponse).error?.code).toBe(-32022);

    const mismatch = await app.request(
      "https://control.example/mcp/developer",
      {
        ...modernRequest("tools/list"),
        headers: {
          ...modernRequest("tools/list").headers,
          "Mcp-Method": "resources/list",
        },
      },
      env,
    );
    expect(((await mismatch.json()) as JsonRpcResponse).error?.code).toBe(-32020);

    const missingMethodHeaders = new Headers(modernRequest("tools/list").headers);
    missingMethodHeaders.delete("Mcp-Method");
    const missingMethod = await app.request(
      "https://control.example/mcp/developer",
      {
        ...modernRequest("tools/list"),
        headers: missingMethodHeaders,
      },
      env,
    );
    expect(((await missingMethod.json()) as JsonRpcResponse).error?.code).toBe(-32020);

    const missingNameHeaders = new Headers(
      modernRequest(
        "tools/call",
        { name: "explain_concept", arguments: { term: "docker" } },
        "explain_concept",
      ).headers,
    );
    missingNameHeaders.delete("Mcp-Name");
    const missingName = await app.request(
      "https://control.example/mcp/developer",
      {
        ...modernRequest(
          "tools/call",
          { name: "explain_concept", arguments: { term: "docker" } },
          "explain_concept",
        ),
        headers: missingNameHeaders,
      },
      env,
    );
    expect(((await missingName.json()) as JsonRpcResponse).error?.code).toBe(-32020);
  });

  it("should reject an oversized request before tool dispatch", async () => {
    const response = await createApp().request(
      "https://control.example/mcp/developer",
      modernRequest(
        "tools/call",
        {
          name: "explain_concept",
          arguments: { term: "docker", padding: "x".repeat(32 * 1024) },
        },
        "explain_concept",
      ),
      env,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request body too large" });
  });

  it("should expose deterministic read-only developer tools and reject cross-origin browsers", async () => {
    const app = createApp();
    const listed = await rpc(app, "/mcp/developer", "tools/list");
    const tools = listed.body.result?.tools as Array<{
      readonly name: string;
      readonly annotations?: Record<string, boolean>;
    }>;
    expect(tools.map(({ name }) => name)).toEqual(["explain_concept", "list_runtime_capabilities"]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(listed.body.result).toMatchObject({
      resultType: "complete",
      cacheScope: "public",
    });
    const resources = await rpc(app, "/mcp/developer", "resources/list");
    expect(
      ((resources.body.result?.resources as Array<{ readonly uri: string }> | undefined) ?? []).map(
        ({ uri }) => uri,
      ),
    ).toEqual(["tenkacloud://developer/roles"]);
    const roleGuide = await rpc(
      app,
      "/mcp/developer",
      "resources/read",
      { uri: "tenkacloud://developer/roles" },
      "tenkacloud://developer/roles",
    );
    expect(JSON.stringify(roleGuide.body)).toContain("/mcp/problem-author");

    const explained = await rpc(
      app,
      "/mcp/developer",
      "tools/call",
      { name: "explain_concept", arguments: { term: "docker" } },
      "explain_concept",
    );
    expect(explained.body.result?.structuredContent).toMatchObject({
      term: "docker",
    });
    const runtimes = await rpc(
      app,
      "/mcp/developer",
      "tools/call",
      { name: "list_runtime_capabilities", arguments: {} },
      "list_runtime_capabilities",
    );
    expect(runtimes.body.result?.structuredContent).toHaveProperty("runtimes");

    const rejected = await app.request(
      "https://control.example/mcp/developer",
      modernRequest("server/discover", {}, undefined, { origin: "https://attacker.example" }),
      env,
    );
    expect(rejected.status).toBe(403);
  });

  it("should validate author input deterministically without filesystem or cloud access", async () => {
    const app = createApp();
    const listed = await rpc(app, "/mcp/problem-author", "tools/list");
    expect(
      ((listed.body.result?.tools as Array<{ readonly name: string }> | undefined) ?? []).map(
        ({ name }) => name,
      ),
    ).toEqual(["validate_pack_manifest", "validate_problem_metadata"]);
    const guide = await rpc(
      app,
      "/mcp/problem-author",
      "resources/read",
      { uri: "tenkacloud://problem-author/validation" },
      "tenkacloud://problem-author/validation",
    );
    expect(JSON.stringify(guide.body)).toContain("validate_problem_metadata");

    const input = {
      schemaVersion: 1,
      id: "example.training",
      version: "1.0.0",
      core: "^0.2.0",
      title: "Training",
      description: "Training pack",
      license: "Apache-2.0",
      problemsRoot: "problems",
      requiredRuntimes: [],
    };
    const first = await rpc(
      app,
      "/mcp/problem-author",
      "tools/call",
      { name: "validate_pack_manifest", arguments: { manifest: input } },
      "validate_pack_manifest",
    );
    const second = await rpc(
      createApp(),
      "/mcp/problem-author",
      "tools/call",
      { name: "validate_pack_manifest", arguments: { manifest: input } },
      "validate_pack_manifest",
    );
    expect(first.body).toEqual(second.body);
    expect(first.body.result?.structuredContent).toMatchObject({
      valid: true,
      diagnostics: [],
    });
    const invalidMetadata = await rpc(
      app,
      "/mcp/problem-author",
      "tools/call",
      { name: "validate_problem_metadata", arguments: { metadata: null } },
      "validate_problem_metadata",
    );
    expect(invalidMetadata.body.result?.structuredContent).toMatchObject({
      valid: false,
    });
  });

  it("should scope organizer MCP reads to the authenticated tenant", async () => {
    await seedMcpData();
    const noAuth = await rpc(createApp(), "/mcp/organizer", "tools/list");
    expect(noAuth.response.status).toBe(401);
    expect(noAuth.response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://control.example/.well-known/oauth-protected-resource/mcp/organizer"',
    );

    const metadata = await createApp().request(
      "https://control.example/.well-known/oauth-protected-resource/mcp/organizer",
      { headers: { host: "control.example" } },
      env,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(metadata.json()).resolves.toMatchObject({
      resource: "https://control.example/mcp/organizer",
      authorization_servers: [env.AUTH0_ISSUER],
      resource_name: "TenkaCloud organizer MCP",
    });
    expect(() =>
      organizerMcpResourceMetadata(
        new Request("https://control.example/mcp/organizer"),
        "http://issuer.example/",
      ),
    ).toThrow("AUTH0_ISSUER must be an HTTPS issuer URL");
    expect(() =>
      organizerMcpResourceMetadata(
        new Request("https://control.example/mcp/organizer"),
        "ftp://localhost/",
      ),
    ).toThrow("AUTH0_ISSUER must be an HTTPS issuer URL");
    expect(() =>
      organizerMcpResourceMetadata(
        new Request("https://control.example/mcp/organizer"),
        "https://user:password@issuer.example/",
      ),
    ).toThrow("AUTH0_ISSUER must be an HTTPS issuer URL");
    expect(() =>
      organizerMcpResourceMetadata(
        new Request("https://control.example/mcp/organizer"),
        "https://issuer.example/?unexpected=true",
      ),
    ).toThrow("AUTH0_ISSUER must be an HTTPS issuer URL");
    expect(() =>
      organizerMcpResourceMetadata(
        new Request("https://control.example/mcp/organizer"),
        "https://issuer.example/#unexpected",
      ),
    ).toThrow("AUTH0_ISSUER must be an HTTPS issuer URL");
    expect(
      organizerMcpResourceMetadata(
        new Request("http://localhost:8787/mcp/organizer"),
        "http://localhost:8787/",
      ).status,
    ).toBe(200);
    expect(
      organizerMcpResourceMetadata(
        new Request("http://127.0.0.1:8787/mcp/organizer"),
        "http://127.0.0.1:8787/",
      ).status,
    ).toBe(200);

    const organizer = {
      subject: "auth0|organizer-a",
      organizationId: "org-a",
      tenantId: "tenant-a",
      roles: ["TenantViewer"],
    };
    const app = createApp({
      organizerJwt: organizerForTest(organizer),
      organizerProjection: organizerForTest(organizer),
    });
    const listed = await rpc(app, "/mcp/organizer", "tools/list");
    expect(
      ((listed.body.result?.tools as Array<{ readonly name: string }> | undefined) ?? []).map(
        ({ name }) => name,
      ),
    ).toEqual(["list_events"]);
    expect(listed.body.result).toMatchObject({
      ttlMs: 0,
      cacheScope: "private",
    });

    const events = await rpc(
      app,
      "/mcp/organizer",
      "tools/call",
      { name: "list_events", arguments: {} },
      "list_events",
    );
    const serialized = JSON.stringify(events.body);
    expect(serialized).toContain("evt-a");
    expect(serialized).not.toContain("evt-b");
    expect(events.body.result).toMatchObject({
      resultType: "complete",
    });
    const eventsResource = await rpc(
      app,
      "/mcp/organizer",
      "resources/read",
      { uri: "tenkacloud://organizer/events" },
      "tenkacloud://organizer/events",
    );
    expect(JSON.stringify(eventsResource.body)).toContain("evt-a");
    expect(JSON.stringify(eventsResource.body)).not.toContain("evt-b");

    const teamOnly = createApp({
      teamAuth: teamForTest({
        teamId: "team-a",
        eventId: "evt-a",
        displayName: "Alpha",
      }),
    });
    expect((await rpc(teamOnly, "/mcp/organizer", "tools/list")).response.status).toBe(401);
  });

  it("should return only the participant's own score without flags, credentials, or rivals", async () => {
    await seedMcpData();
    const noAuth = await rpc(createApp(), "/mcp/participant", "tools/list");
    expect(noAuth.response.status).toBe(401);

    const app = createApp({
      teamAuth: teamForTest({
        teamId: "team-a",
        eventId: "evt-a",
        displayName: "Alpha",
      }),
    });
    const score = await rpc(
      app,
      "/mcp/participant",
      "tools/call",
      { name: "get_my_score", arguments: {} },
      "get_my_score",
    );
    expect(score.body.result?.structuredContent).toEqual({
      eventId: "evt-a",
      teamId: "team-a",
      displayName: "Alpha",
      score: 42,
      solvedCheckpoints: 2,
      updatedAt: "2026-07-28T00:00:00.000Z",
    });
    const serialized = JSON.stringify(score.body);
    for (const secret of [
      "team-other",
      "Secret rival",
      "login-hash-alpha",
      "login-hash-rival",
      "flag-hash-secret",
      "checkpoint-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const identity = await rpc(
      app,
      "/mcp/participant",
      "resources/read",
      { uri: "tenkacloud://participant/me" },
      "tenkacloud://participant/me",
    );
    expect(identity.body.result).toBeDefined();
    const identityContents = identity.body.result?.contents as
      | Array<{ readonly text: string }>
      | undefined;
    expect(JSON.parse(identityContents?.[0]?.text ?? "null")).toEqual({
      teamId: "team-a",
      eventId: "evt-a",
      displayName: "Alpha",
    });
    expect(JSON.stringify(identity.body)).not.toContain("login-hash-alpha");

    const missingTeamApp = createApp({
      teamAuth: teamForTest({
        teamId: "team-missing",
        eventId: "evt-a",
        displayName: "Missing",
      }),
    });
    const missingScore = await rpc(
      missingTeamApp,
      "/mcp/participant",
      "tools/call",
      { name: "get_my_score", arguments: {} },
      "get_my_score",
    );
    expect(missingScore.body.result?.structuredContent).toEqual({ found: false });

    const organizer = {
      subject: "auth0|organizer-a",
      organizationId: "org-a",
      tenantId: "tenant-a",
      roles: ["TenantViewer"],
    };
    const organizerOnly = createApp({
      organizerJwt: organizerForTest(organizer),
      organizerProjection: organizerForTest(organizer),
    });
    expect((await rpc(organizerOnly, "/mcp/participant", "tools/list")).response.status).toBe(401);
  });

  it("should write audit metadata without request arguments or credentials", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = createApp();
    await rpc(
      app,
      "/mcp/developer",
      "tools/call",
      {
        name: "explain_concept",
        arguments: { term: "docker", secretCanary: "MUST_NOT_LOG" },
      },
      "explain_concept",
    );

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("always-on.mcp.request");
    expect(output).toContain("explain_concept");
    expect(output).not.toContain("MUST_NOT_LOG");
  });
});
