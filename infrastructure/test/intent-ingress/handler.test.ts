import { signIntent } from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIntent, TEST_SECRET } from "./intent-fixtures";

/**
 * Handler-level wiring test for the intent-ingress Lambda. trust-bridge (sign/verify)
 * runs for real; only the AWS SDK edges are mocked so the full adapter — SSM secret
 * resolution, DDB nonce put, orchestrator, and EventBridge re-emit — runs offline.
 */

const SECRET_STRING = "intent-ingress-test-secret-0123456789";

/** Captured AWS_REGION so per-test mutations never leak to other test files. */
const ORIGINAL_AWS_REGION = process.env.AWS_REGION;

const captured = vi.hoisted(() => ({ entries: undefined as unknown }));

/**
 * Mutable SSM behaviour: `value` drives the empty-parameter branch; `reject` (when set)
 * makes the SDK call throw an arbitrary value so the handler's non-Error catch path runs.
 */
const ssmSecret = vi.hoisted(() => ({
  value: undefined as string | undefined,
  reject: undefined as unknown,
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      if (ssmSecret.reject !== undefined) {
        throw ssmSecret.reject;
      }
      return { Parameter: { Value: ssmSecret.value } };
    }
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class {
    async send(cmd: { input: { Entries: unknown } }) {
      captured.entries = cmd.input.Entries;
      return { FailedEntryCount: 0 };
    }
  },
  PutEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));

async function loadHandler() {
  vi.resetModules();
  const mod = await import("../../lib/intent-ingress/handler/index");
  return mod.handler;
}

describe("intent-ingress handler (ADR-049 Phase 4 / #2293)", () => {
  beforeEach(() => {
    captured.entries = undefined;
    ssmSecret.value = SECRET_STRING;
    ssmSecret.reject = undefined;
    process.env.NONCE_TABLE_NAME = "nonce-table";
    process.env.VERIFY_SECRET_PARAM = "/tenkacloud/intent-verify-secret";
    process.env.DEPLOY_EVENT_BUS_NAME = "tenkacloud-deploy";
    process.env.PROBLEMS_CATALOG = JSON.stringify({
      "hello-world": "problems/challenges/hello-world",
    });
  });

  afterEach(() => {
    delete process.env.NONCE_TABLE_NAME;
    delete process.env.VERIFY_SECRET_PARAM;
    delete process.env.DEPLOY_EVENT_BUS_NAME;
    delete process.env.PROBLEMS_CATALOG;
    delete process.env.EXPECTED_AUDIENCE;
    delete process.env.ALLOWED_TENANT_IDS;
    delete process.env.ALLOWED_EVENT_IDS;
    if (ORIGINAL_AWS_REGION === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = ORIGINAL_AWS_REGION;
    }
  });

  it("should 202 and re-emit a frozen DeployCreateRequested event for a signed deploy intent", async () => {
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({
      body: Buffer.from(JSON.stringify({ token })).toString("base64"),
      isBase64Encoded: true,
    });

    expect(res.statusCode).toBe(StatusCodes.ACCEPTED);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ requestId: "job-abc" });

    const entries = captured.entries as { DetailType: string; Detail: string; Source: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].Source).toBe("tenkacloud.deploy");
    expect(entries[0].DetailType).toBe("DeployCreateRequested");
    expect(JSON.parse(entries[0].Detail)).toMatchObject({
      jobId: "job-abc",
      tenantId: "tenant-a",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      awsAccountId: "111111111111",
    });
  });

  it("should 400 a malformed request body without publishing", async () => {
    const handler = await loadHandler();
    const res = await handler({ body: "not json" });
    expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST);
    expect(JSON.parse(res.body)).toEqual({ reason: "malformed-request-body" });
    expect(captured.entries).toBeUndefined();
  });

  it("should 400 malformed-request-body when the event carries no body", async () => {
    // event.body is undefined → readBody's `?? ""` yields an empty string, which is not JSON.
    const handler = await loadHandler();
    const res = await handler({});
    expect(res.statusCode).toBe(StatusCodes.BAD_REQUEST);
    expect(JSON.parse(res.body)).toEqual({ reason: "malformed-request-body" });
    expect(captured.entries).toBeUndefined();
  });

  it("should 500 internal-error when a required env var is missing", async () => {
    delete process.env.NONCE_TABLE_NAME;
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(JSON.parse(res.body)).toEqual({ reason: "internal-error" });
  });

  it("should 500 internal-error when the verify secret parameter is empty", async () => {
    // SSM returns a parameter with no value → resolveVerifySecret throws, and the
    // handler collapses it to a loud 5xx without leaking the raw error.
    ssmSecret.value = "";
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(JSON.parse(res.body)).toEqual({ reason: "internal-error" });
    expect(captured.entries).toBeUndefined();
  });

  it("should 500 internal-error and stringify a non-Error thrown during setup", async () => {
    // A rejected AWS SDK call with a non-Error value must still collapse to a loud 5xx;
    // the catch takes its `String(err)` side instead of reading `.message`.
    ssmSecret.reject = "ssm exploded (non-Error)";
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(JSON.parse(res.body)).toEqual({ reason: "internal-error" });
    expect(captured.entries).toBeUndefined();
  });

  it("should authorize and 202 when the scope env vars match the signed intent", async () => {
    // Populate every scope axis so buildScopeConfig takes its truthy conditional
    // spreads and optionalCsv keeps non-empty members; the intent matches all of them.
    process.env.EXPECTED_AUDIENCE = "plane://tenka/ingress";
    process.env.ALLOWED_TENANT_IDS = "tenant-a,tenant-b";
    process.env.ALLOWED_EVENT_IDS = "event-a";
    const token = signIntent(makeIntent({ audience: "plane://tenka/ingress" }), {
      secret: TEST_SECRET,
    });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });

    expect(res.statusCode).toBe(StatusCodes.ACCEPTED);
    expect(JSON.parse(res.body)).toEqual({ requestId: "job-abc" });
    const entries = captured.entries as { DetailType: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].DetailType).toBe("DeployCreateRequested");
  });

  it("should build the SDK clients with an explicit region when AWS_REGION is set", async () => {
    process.env.AWS_REGION = "us-east-1";
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.ACCEPTED);
  });

  it("should build the SDK clients without a region when AWS_REGION is absent", async () => {
    delete process.env.AWS_REGION;
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.ACCEPTED);
  });
});
