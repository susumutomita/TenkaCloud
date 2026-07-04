import { verifyIntent } from "@TenkaCloud/trust-bridge";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import {
  type DeployIntentCommand,
  INTENT_TTL_SECONDS,
  INTENT_WORKLOAD_ID,
  type IntentGateway,
  intentGatewayFromEnvironment,
  issueDeployIntentCommand,
} from "../src/deploy-intents.js";

const SECRET_TEXT = "worker-intent-signing-secret 0123456789";
const SECRET = new TextEncoder().encode(SECRET_TEXT);
const INGRESS_URL = "https://ingress.example/intents";
const AUDIENCE = "plane://tenkacloud/intent-ingress";

function command(overrides: Partial<DeployIntentCommand> = {}): DeployIntentCommand {
  return {
    action: "deploy",
    tenantId: "tenant-acme",
    eventId: "event-1",
    teamId: "team-1",
    problemId: "hello-world",
    awsAccountId: "111111111111",
    region: "ap-northeast-1",
    ...overrides,
  };
}

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function gatewayWithResponse(
  response: () => Response,
  overrides: Partial<IntentGateway> = {},
): { gateway: IntentGateway; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return response();
  });
  return {
    gateway: {
      ingressUrl: INGRESS_URL,
      audience: AUDIENCE,
      signingSecret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...overrides,
    },
    captured,
  };
}

function accepted(): Response {
  return new Response(JSON.stringify({ requestId: "ignored-by-worker" }), {
    status: StatusCodes.ACCEPTED,
  });
}

function capturedAt(captured: CapturedRequest[], index: number): CapturedRequest {
  const request = captured[index];
  if (!request) throw new Error(`no captured request at index ${index}`);
  return request;
}

async function verifyCapturedToken(captured: CapturedRequest[]) {
  expect(captured).toHaveLength(1);
  const body = JSON.parse(String(capturedAt(captured, 0).init.body)) as { token: string };
  const outcome = await verifyIntent(body.token, { resolveSecret: () => SECRET });
  if (!outcome.ok) throw new Error(`token did not verify: ${outcome.reason}`);
  return outcome.intent;
}

describe("issueDeployIntentCommand (ADR-049 Phase 4 / #2293)", () => {
  it("should POST a signed deploy intent the ingress verify-side accepts", async () => {
    const { gateway, captured } = gatewayWithResponse(accepted);
    const outcome = await issueDeployIntentCommand(command(), gateway);

    expect(outcome).toEqual({ accepted: true, requestId: expect.any(String) });
    const request = capturedAt(captured, 0);
    expect(request.url).toBe(INGRESS_URL);
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({ "content-type": "application/json" });

    const intent = await verifyCapturedToken(captured);
    expect(intent.source).toEqual({
      system: "tenkacloud",
      tenantId: "tenant-acme",
      workloadId: INTENT_WORKLOAD_ID,
      problemId: "hello-world",
      deploymentId: intent.requestId,
      teamId: "team-1",
      eventId: "event-1",
    });
    expect(intent.target).toEqual({
      provider: "aws",
      providerAccountRef: "111111111111",
      region: "ap-northeast-1",
    });
    expect(intent.action).toEqual({
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack"],
    });
    expect(intent.audience).toBe(AUDIENCE);
    expect(intent.constraints.ttlSeconds).toBe(INTENT_TTL_SECONDS);
    expect(intent.constraints.allowPrivilegeEscalation).toBe(false);
  });

  it("should return the minted requestId as the deployment identity (jobId contract)", async () => {
    const { gateway, captured } = gatewayWithResponse(accepted);
    const outcome = await issueDeployIntentCommand(command(), gateway);
    const intent = await verifyCapturedToken(captured);
    // The ingress derives jobId from source.deploymentId ?? requestId; pinning
    // deploymentId === requestId keeps one identity across both planes.
    expect(outcome).toEqual({ accepted: true, requestId: intent.requestId });
    expect(intent.source.deploymentId).toBe(intent.requestId);
  });

  it("should mint a destroy intent with action.type=destroy and the DeleteStack scope", async () => {
    const { gateway, captured } = gatewayWithResponse(accepted);
    await issueDeployIntentCommand(command({ action: "destroy" }), gateway);
    const intent = await verifyCapturedToken(captured);
    expect(intent.action.type).toBe("destroy");
    expect(intent.action.requestedScopes).toEqual(["cloudformation:DeleteStack"]);
  });

  it("should mint a fresh requestId and nonce per command (no replayable token reuse)", async () => {
    const { gateway, captured } = gatewayWithResponse(accepted);
    await issueDeployIntentCommand(command(), gateway);
    await issueDeployIntentCommand(command(), gateway);
    const first = JSON.parse(String(capturedAt(captured, 0).init.body)) as { token: string };
    const second = JSON.parse(String(capturedAt(captured, 1).init.body)) as { token: string };
    const firstIntent = await verifyIntent(first.token, { resolveSecret: () => SECRET });
    const secondIntent = await verifyIntent(second.token, { resolveSecret: () => SECRET });
    if (!firstIntent.ok || !secondIntent.ok) throw new Error("tokens did not verify");
    expect(firstIntent.intent.requestId).not.toBe(secondIntent.intent.requestId);
    expect(firstIntent.intent.nonce).not.toBe(secondIntent.intent.nonce);
  });

  it("should omit the audience claim when the gateway has none configured", async () => {
    const { gateway, captured } = gatewayWithResponse(accepted, { audience: undefined });
    await issueDeployIntentCommand(command(), gateway);
    const intent = await verifyCapturedToken(captured);
    expect("audience" in intent).toBe(false);
  });

  it("should surface the ingress' stable reason code on a rejection", async () => {
    const { gateway } = gatewayWithResponse(
      () =>
        new Response(JSON.stringify({ reason: "tenant-not-allowed" }), {
          status: StatusCodes.FORBIDDEN,
        }),
    );
    const outcome = await issueDeployIntentCommand(command(), gateway);
    expect(outcome).toEqual({
      accepted: false,
      ingressStatus: StatusCodes.FORBIDDEN,
      reason: "tenant-not-allowed",
    });
  });

  it("should collapse a non-JSON ingress rejection to the stable fallback reason", async () => {
    const { gateway } = gatewayWithResponse(
      () => new Response("boom", { status: StatusCodes.INTERNAL_SERVER_ERROR }),
    );
    const outcome = await issueDeployIntentCommand(command(), gateway);
    expect(outcome).toEqual({
      accepted: false,
      ingressStatus: StatusCodes.INTERNAL_SERVER_ERROR,
      reason: "ingress-rejected",
    });
  });

  it("should collapse a JSON rejection without a string reason to the stable fallback reason", async () => {
    const { gateway } = gatewayWithResponse(
      () => new Response(JSON.stringify({ message: 42 }), { status: StatusCodes.BAD_REQUEST }),
    );
    const outcome = await issueDeployIntentCommand(command(), gateway);
    expect(outcome).toEqual({
      accepted: false,
      ingressStatus: StatusCodes.BAD_REQUEST,
      reason: "ingress-rejected",
    });
  });
});

describe("intentGatewayFromEnvironment (ADR-049 Phase 4 / #2293)", () => {
  const fetchImpl = (() => {
    throw new Error("not called");
  }) as unknown as typeof fetch;

  it("should build a gateway from the Worker bindings", () => {
    const gateway = intentGatewayFromEnvironment(
      {
        INTENT_INGRESS_URL: INGRESS_URL,
        INTENT_AUDIENCE: AUDIENCE,
        INTENT_SIGNING_SECRET: SECRET_TEXT,
      },
      fetchImpl,
    );
    expect(gateway.ingressUrl).toBe(INGRESS_URL);
    expect(gateway.audience).toBe(AUDIENCE);
    expect(gateway.signingSecret).toEqual(SECRET);
    expect(gateway.fetchImpl).toBe(fetchImpl);
  });

  it("should treat an empty audience binding as unset", () => {
    const gateway = intentGatewayFromEnvironment(
      {
        INTENT_INGRESS_URL: INGRESS_URL,
        INTENT_AUDIENCE: "",
        INTENT_SIGNING_SECRET: SECRET_TEXT,
      },
      fetchImpl,
    );
    expect("audience" in gateway).toBe(false);
  });

  it("should fail loudly when the ingress URL binding is missing", () => {
    expect(() =>
      intentGatewayFromEnvironment({ INTENT_SIGNING_SECRET: SECRET_TEXT }, fetchImpl),
    ).toThrow(/INTENT_INGRESS_URL is not configured/);
  });

  it("should fail loudly when the signing secret binding is missing or empty", () => {
    expect(() =>
      intentGatewayFromEnvironment({ INTENT_INGRESS_URL: INGRESS_URL }, fetchImpl),
    ).toThrow(/INTENT_SIGNING_SECRET is not configured/);
    expect(() =>
      intentGatewayFromEnvironment(
        { INTENT_INGRESS_URL: INGRESS_URL, INTENT_SIGNING_SECRET: "" },
        fetchImpl,
      ),
    ).toThrow(/INTENT_SIGNING_SECRET is not configured/);
  });
});
