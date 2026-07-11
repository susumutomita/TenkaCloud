import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import {
  InvalidRetryRequestError,
  retryDeployments,
  validateRetryRequest,
} from "../../lib/problem-deploy/handlers/deploy-handler/retry";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #911 (#895 Phase 2.D): retry API の挙動契約 test。
 *
 * 重点 4 経路:
 *  1. FAILED → PENDING + event publish (= action: "requeued")
 *  2. not_found (DDB row 無し) → action: "skipped", reason: "not_found"
 *  3. cross-tenant (= 別 tenant の row) → action: "skipped", reason: "not_found" (= 漏洩防止)
 *  4. not FAILED (= COMPLETE / IN_PROGRESS 等) → action: "skipped", reason: "not_failed"
 *  5. unknown_problem (= problemsCatalog にない problemId) → action: "skipped", reason: "unknown_problem"
 *  6. publish_failed (= EventBridge throw) → action: "skipped", reason: "publish_failed",
 *     status は FAILED に巻き戻し
 */

const VALID_JOB_ID = "01J0RETRYABCDEFGHJKMNPQRST";
const VALID_JOB_ID_2 = "01J0RETRYABCDEFGHJKMNPQRSV";

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: DeploySharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: { send: eventsSend } as unknown as DeploySharedResources["events"],
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsVisibility: {} as DeploySharedResources["problemsVisibility"],
    challengePayloadBucket: undefined,
    s3: {} as DeploySharedResources["s3"],
  };
  return { shared, ddbSend, eventsSend };
}

const failedRow = (over: Record<string, unknown> = {}) => ({
  jobId: VALID_JOB_ID,
  problemId: "hello-world",
  tenantId: "tenant-a",
  awsAccountId: "111111111111",
  region: "ap-northeast-1",
  teamName: "team-alpha",
  namePrefix: "tc-hello-world-alpha",
  status: "FAILED",
  failureReason: "CodeBuild exit 1",
  ...over,
});

describe("validateRetryRequest", () => {
  it("body が object でないとき throw", () => {
    expect(() => validateRetryRequest("not object")).toThrow(InvalidRetryRequestError);
  });
  it("failedJobIds が array でないとき throw", () => {
    expect(() => validateRetryRequest({ failedJobIds: "string" })).toThrow(
      InvalidRetryRequestError,
    );
  });
  it("failedJobIds が空配列のとき throw", () => {
    expect(() => validateRetryRequest({ failedJobIds: [] })).toThrow(InvalidRetryRequestError);
  });
  it("失敗 jobId が ULID でないとき throw", () => {
    expect(() => validateRetryRequest({ failedJobIds: ["not-ulid"] })).toThrow(
      InvalidRetryRequestError,
    );
  });
  it("配列要素が string でないとき throw (Zod 化後も型不正を拒否)", () => {
    expect(() => validateRetryRequest({ failedJobIds: [123] })).toThrow(InvalidRetryRequestError);
    expect(() => validateRetryRequest({ failedJobIds: [null] })).toThrow(InvalidRetryRequestError);
  });
  it("failedJobIds が欠落しているとき throw", () => {
    expect(() => validateRetryRequest({})).toThrow(InvalidRetryRequestError);
  });
  it("750 件超のとき throw", () => {
    const big = Array.from({ length: 751 }, () => VALID_JOB_ID);
    expect(() => validateRetryRequest({ failedJobIds: big })).toThrow(InvalidRetryRequestError);
  });
  it("正常 input は dedupe して返す", () => {
    const res = validateRetryRequest({
      failedJobIds: [VALID_JOB_ID, VALID_JOB_ID, VALID_JOB_ID_2],
    });
    expect(res.failedJobIds.length).toBe(2);
    expect(res.failedJobIds).toContain(VALID_JOB_ID);
    expect(res.failedJobIds).toContain(VALID_JOB_ID_2);
  });
});

describe("retryDeployments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should revert FAILED rows to PENDING, re-publish the event, and return action='requeued'", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: failedRow() }); // Get
    ddbSend.mockResolvedValueOnce({}); // Update FAILED → PENDING
    eventsSend.mockResolvedValueOnce({});

    const res = await retryDeployments(
      shared,
      "tenant-a",
      { failedJobIds: [VALID_JOB_ID] },
      () => 1700000000000,
    );

    expect(res.items).toEqual([{ jobId: VALID_JOB_ID, action: "requeued" }]);
    // Update が status FAILED → PENDING を書いている
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.ExpressionAttributeValues?.[":pending"]).toBe("PENDING");
    expect(updateCmd.input.ExpressionAttributeValues?.[":failed"]).toBe("FAILED");
    // EventBridge にも publish
    expect(eventsSend).toHaveBeenCalledOnce();
    const eventCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(eventCmd).toBeInstanceOf(PutEventsCommand);
  });

  it("DDB row 無しなら 'not_found'", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const res = await retryDeployments(shared, "tenant-a", { failedJobIds: [VALID_JOB_ID] });

    expect(res.items[0]?.action).toBe("skipped");
    expect(res.items[0]?.reason).toBe("not_found");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("別 tenant の row は 'not_found' 扱い (= cross-tenant 漏洩防止)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: failedRow({ tenantId: "tenant-other" }) });

    const res = await retryDeployments(shared, "tenant-a", { failedJobIds: [VALID_JOB_ID] });

    expect(res.items[0]?.reason).toBe("not_found");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("FAILED 以外 (COMPLETE / IN_PROGRESS) は 'not_failed' でスキップ、 巻き戻さない", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: failedRow({ status: "COMPLETE" }) });

    const res = await retryDeployments(shared, "tenant-a", { failedJobIds: [VALID_JOB_ID] });

    expect(res.items[0]?.reason).toBe("not_failed");
    expect(eventsSend).not.toHaveBeenCalled();
    // Update は呼ばれない (= Get のみ)
    expect(ddbSend).toHaveBeenCalledOnce();
  });

  it("unknown problemId は 'unknown_problem' でスキップ", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: failedRow({ problemId: "no-such-problem" }) });

    const res = await retryDeployments(shared, "tenant-a", { failedJobIds: [VALID_JOB_ID] });

    expect(res.items[0]?.reason).toBe("unknown_problem");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("publish 失敗時は status を FAILED に巻き戻して 'publish_failed' を返す", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: failedRow() }); // Get
    ddbSend.mockResolvedValueOnce({}); // Update FAILED → PENDING
    eventsSend.mockRejectedValueOnce(new Error("EventBridge throttle"));
    ddbSend.mockResolvedValueOnce({}); // Update PENDING → FAILED (rollback)

    const res = await retryDeployments(shared, "tenant-a", { failedJobIds: [VALID_JOB_ID] });

    expect(res.items[0]?.reason).toBe("publish_failed");
    // 3 回 ddbSend (Get + Update forward + Update rollback)
    expect(ddbSend).toHaveBeenCalledTimes(3);
  });

  it("should bundle partial success / partial skip across multiple jobIds into a single response", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // jobId 1: FAILED → requeued
    ddbSend.mockResolvedValueOnce({ Item: failedRow({ jobId: VALID_JOB_ID }) });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});
    // jobId 2: not_found
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const res = await retryDeployments(shared, "tenant-a", {
      failedJobIds: [VALID_JOB_ID, VALID_JOB_ID_2],
    });

    expect(res.items.length).toBe(2);
    expect(res.items[0]?.action).toBe("requeued");
    expect(res.items[1]?.action).toBe("skipped");
    expect(res.items[1]?.reason).toBe("not_found");
  });
});
