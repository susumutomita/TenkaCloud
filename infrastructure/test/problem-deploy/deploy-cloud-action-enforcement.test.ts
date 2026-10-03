/**
 * Issue #2019: completion-criteria proof for staged TrustBridge
 * enforcement of high-risk `CloudActionIntent`.
 *
 * The security-critical assertions (issue COMPLETION CRITERIA #2 + #3):
 *
 *   - In `enforce` mode, a high-risk deploy (one that replaces a live stack)
 *     returns `APPROVAL_PENDING` and the AssumeRole / CloudFormation path is
 *     **never reached** — proven by `eventsSend` (the EventBridge publish the
 *     AWS/CFn adapter uses to kick off AssumeRole + CFn CreateStack) NOT being
 *     called, plus a single DDB UpdateCommand flipping the row to
 *     `APPROVAL_PENDING`.
 *   - In the default `shadow` mode the deploy proceeds exactly as before:
 *     `eventsSend` IS called (backward compatibility).
 *
 * `eventsSend` is the faithful proxy for "the dangerous boundary ran": the
 * AWS/CFn runtime adapter dispatches by publishing a `DeployCreateRequested`
 * EventBridge event, which the worker Lambda picks up to AssumeRole into the
 * competitor account and run CFn. If no event is published, no AssumeRole /
 * CloudFormation can happen.
 */

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeployContext,
  type DeployInvocation,
  startDeployment,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

vi.mock("../../lib/problem-deploy/handlers/deploy-handler/presigned-url", () => ({
  generateChallengePayloadUrl: vi.fn(async () => "https://example.invalid/fake.zip"),
}));

/** A live (non-terminal) deployment row sharing the deploy's namePrefix. */
/** A live (non-terminal) deployment row from ANOTHER (prior) deploy. */
function liveReplacementRow(namePrefix: string): Record<string, unknown> {
  return { namePrefix, jobId: "01HPRIORDEPLOY00000000000", status: "COMPLETE" };
}

function buildContext(
  overrides: Partial<DeployContext> = {},
  replacementRows: readonly Record<string, unknown>[] = [],
): {
  ctx: DeployContext;
  putSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
  updateSend: ReturnType<typeof vi.fn>;
} {
  const putSend = vi.fn().mockResolvedValue({});
  const eventsSend = vi.fn().mockResolvedValue({});
  const updateSend = vi.fn().mockResolvedValue({});
  const ddbSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand && cmd.input.TableName === "TestCompetitorAccounts") {
      const sk = String(cmd.input.Key?.SK ?? "");
      const awsAccountId = sk.replace(/^ACCOUNT#/, "");
      return {
        Item: {
          PK: cmd.input.Key?.PK,
          SK: cmd.input.Key?.SK,
          awsAccountId,
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
        },
      };
    }
    // The enforcement gate's replacement lookup (FilterExpression namePrefix = :np).
    if (cmd instanceof QueryCommand && cmd.input.FilterExpression === "namePrefix = :np") {
      return { Items: replacementRows };
    }
    if (cmd instanceof UpdateCommand) {
      return updateSend(cmd);
    }
    return putSend(cmd);
  });
  const ctx: DeployContext = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeployContext["ddb"],
    events: { send: eventsSend } as unknown as DeployContext["events"],
    now: () => 1_700_000_000_000,
    ttlMs: 60_000,
    tenantId: "tenant-acme",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    ...overrides,
  };
  return { ctx, putSend, eventsSend, updateSend };
}

const sampleRequest = (overrides: Partial<DeployInvocation> = {}): DeployInvocation => ({
  problemId: "hello-world",
  region: "ap-northeast-1",
  awsAccountId: "123456789012",
  teamName: "Alpha Team",
  ...overrides,
});

// problemId "hello-world" + teamName "Alpha Team" → buildStackPrefix.
const NAME_PREFIX = "tc-hello-world-alpha-team";

describe("startDeployment TrustBridge enforcement (Issue #2019)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should proceed and run the AssumeRole/CFn path in the default shadow mode (backward compat)", async () => {
    // No cloudActionEnforcementMode set → handler defaults to shadow.
    const { ctx, putSend, eventsSend, updateSend } = buildContext(
      {},
      // Even with a live replacement present, shadow mode must not hold.
      [liveReplacementRow(NAME_PREFIX)],
    );
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    // The deployment row is written and the AssumeRole/CFn path (EventBridge) ran.
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
    expect(eventsSend).toHaveBeenCalledOnce();
    // No APPROVAL_PENDING flip in shadow mode.
    expect(updateSend).not.toHaveBeenCalled();
  });

  it("should proceed in shadow mode even when explicitly set to shadow", async () => {
    const { ctx, eventsSend } = buildContext({ cloudActionEnforcementMode: "shadow" }, [
      liveReplacementRow(NAME_PREFIX),
    ]);
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(eventsSend).toHaveBeenCalledOnce();
  });

  it("should HOLD a high-risk (stack-replacing) deploy in enforce mode and NOT run AssumeRole/CFn", async () => {
    const { ctx, putSend, eventsSend, updateSend } = buildContext(
      { cloudActionEnforcementMode: "enforce" },
      [liveReplacementRow(NAME_PREFIX)],
    );
    const res = await startDeployment(ctx, sampleRequest());

    // Held, not executed.
    expect(res.status).toBe("APPROVAL_PENDING");
    // The deployment row was still written (so an operator can approve it later).
    expect(putSend.mock.calls.some((c) => c[0] instanceof PutCommand)).toBe(true);
    // THE security assertion: no EventBridge publish → no AssumeRole / CFn ran.
    expect(eventsSend).not.toHaveBeenCalled();
    // The row was flipped PENDING → APPROVAL_PENDING via a single conditional Update.
    expect(updateSend).toHaveBeenCalledOnce();
    const update = updateSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(update.input.ExpressionAttributeValues?.[":approvalPending"]).toBe("APPROVAL_PENDING");
    expect(update.input.ConditionExpression).toContain("#s = :pending");
  });

  it("should proceed in enforce mode when the deploy is NOT high-risk (no live stack to replace)", async () => {
    // No replacement rows → not high-risk → enforce mode allows it through.
    const { ctx, eventsSend, updateSend } = buildContext(
      { cloudActionEnforcementMode: "enforce" },
      [],
    );
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(eventsSend).toHaveBeenCalledOnce();
    expect(updateSend).not.toHaveBeenCalled();
  });

  it("should treat only FAILED / deleted prior rows as non-replacement in enforce mode", async () => {
    // A terminal-without-stack prior row (FAILED) is not a live stack → allow.
    const { ctx, eventsSend } = buildContext({ cloudActionEnforcementMode: "enforce" }, [
      { namePrefix: NAME_PREFIX, status: "FAILED" },
      { namePrefix: NAME_PREFIX, status: "DELETED" },
    ]);
    const res = await startDeployment(ctx, sampleRequest());
    expect(res.status).toBe("PENDING");
    expect(eventsSend).toHaveBeenCalledOnce();
  });
});
