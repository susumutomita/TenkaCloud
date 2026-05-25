import type { EventBridgeEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as auditLog from "../../../lib/problem-deploy/handlers/shared/audit-log";

/**
 * Issue #1335 Phase 1: Cognito sign-in audit Lambda の event mapping を pin する。
 * EventBridge / CloudTrail Cognito events → AdminAuditLog row 変換が drift しないようにする。
 */
describe("control-plane sign-in audit handler (#1335)", () => {
  const ORIGINAL_TABLE = process.env.ADMIN_AUDIT_LOG_TABLE_NAME;

  beforeEach(() => {
    process.env.ADMIN_AUDIT_LOG_TABLE_NAME = "TestAuditTable";
  });
  afterEach(() => {
    if (ORIGINAL_TABLE === undefined) {
      delete process.env.ADMIN_AUDIT_LOG_TABLE_NAME;
    } else {
      process.env.ADMIN_AUDIT_LOG_TABLE_NAME = ORIGINAL_TABLE;
    }
    vi.restoreAllMocks();
  });

  async function importHandler() {
    return await import("../../../lib/control-plane/handlers/sign-in-audit");
  }

  function buildCloudTrailEvent(
    detail: Record<string, unknown>,
  ): EventBridgeEvent<string, Record<string, unknown>> {
    return {
      version: "0",
      id: "test-id",
      "detail-type": "AWS API Call via CloudTrail",
      source: "aws.cognito-idp",
      account: "111111111111",
      time: "2026-05-25T00:00:00Z",
      region: "ap-northeast-1",
      resources: [],
      detail: {
        eventSource: "cognito-idp.amazonaws.com",
        requestParameters: { userPoolId: "ap-northeast-1_test" },
        ...detail,
      },
    };
  }

  it("should write auth.sign_in_succeeded when InitiateAuth returns an authenticationResult", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(
      buildCloudTrailEvent({
        eventName: "InitiateAuth",
        responseElements: {
          authenticationResult: { IdToken: "..." },
          user: { Username: "user@example.com" },
        },
      }),
    );
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]?.[0];
    expect(call?.action).toBe("auth.sign_in_succeeded");
    expect(call?.outcome).toBe("success");
    expect(call?.tenantId).toBe("SYSTEM");
    expect(call?.extra?.idp).toBe("COGNITO");
  });

  it("should resolve idp=<provider> for federated username `{provider}_{subject}`", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(
      buildCloudTrailEvent({
        eventName: "InitiateAuth",
        responseElements: {
          authenticationResult: { IdToken: "..." },
          user: { Username: "corp-entra_subject-abc" },
        },
      }),
    );
    expect(spy.mock.calls[0]?.[0]?.extra?.idp).toBe("corp-entra");
  });

  it("should write auth.sign_in_denied when CloudTrail records errorCode (= failed sign-in)", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(
      buildCloudTrailEvent({
        eventName: "InitiateAuth",
        errorCode: "NotAuthorizedException",
        errorMessage: "Incorrect username or password.",
        requestParameters: {
          userPoolId: "ap-northeast-1_test",
          authParameters: { USERNAME: "user@example.com" },
        },
      }),
    );
    const call = spy.mock.calls[0]?.[0];
    expect(call?.action).toBe("auth.sign_in_denied");
    expect(call?.outcome).toBe("error");
  });

  it("should NOT emit a row when RespondToAuthChallenge returns a follow-up challenge (= MFA mid-flight)", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(
      buildCloudTrailEvent({
        eventName: "RespondToAuthChallenge",
        responseElements: { challengeName: "SOFTWARE_TOKEN_MFA" },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("should skip non-sign-in event names (= e.g. CreateUserPool)", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(buildCloudTrailEvent({ eventName: "CreateUserPool" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("should record sourceIPAddress and userAgent when present on the CloudTrail event", async () => {
    const spy = vi.spyOn(auditLog, "writeAuditEvent").mockResolvedValue(true);
    const { handler } = await importHandler();
    await handler(
      buildCloudTrailEvent({
        eventName: "InitiateAuth",
        sourceIPAddress: "203.0.113.1",
        userAgent: "Mozilla/5.0",
        responseElements: {
          authenticationResult: { IdToken: "..." },
          user: { Username: "u@example.com" },
        },
      }),
    );
    const call = spy.mock.calls[0]?.[0];
    expect(call?.ipAddress).toBe("203.0.113.1");
    expect(call?.userAgent).toBe("Mozilla/5.0");
  });

  it("should swallow write errors so the EventBridge rule does not retry-storm", async () => {
    vi.spyOn(auditLog, "writeAuditEvent").mockRejectedValue(new Error("ddb down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = await importHandler();
    await expect(
      handler(
        buildCloudTrailEvent({
          eventName: "InitiateAuth",
          responseElements: { authenticationResult: { IdToken: "..." } },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
  });
});
