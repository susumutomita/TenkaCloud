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

const captured = vi.hoisted(() => ({ entries: undefined as unknown }));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    async send() {
      return { Parameter: { Value: SECRET_STRING } };
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

  it("should 500 internal-error when a required env var is missing", async () => {
    delete process.env.NONCE_TABLE_NAME;
    const token = signIntent(makeIntent(), { secret: TEST_SECRET });
    const handler = await loadHandler();
    const res = await handler({ body: JSON.stringify({ token }) });
    expect(res.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(JSON.parse(res.body)).toEqual({ reason: "internal-error" });
  });
});
