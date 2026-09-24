import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbDeploymentsRepository } from "../../../lib/problem-deploy/control-data/deployments-repository";

const loginKey = "team-key";
const complete = {
  PK: "DEPLOYMENT#old-job",
  SK: "META",
  GSI2PK: `TEAMKEY#${loginKey}`,
  GSI2SK: "2026-09-22T09:00:00.000Z",
  jobId: "old-job",
  tenantId: "tenant-a",
  eventId: "event-a",
  teamId: "team-a",
  problemId: "problem-a",
  status: "COMPLETE",
  createdAt: "2026-09-22T09:00:00.000Z",
  teamLoginKey: loginKey,
};
const cursor = {
  PK: complete.PK,
  SK: complete.SK,
  GSI2PK: complete.GSI2PK,
  GSI2SK: complete.GSI2SK,
};

describe("participant deployment lookup pagination", () => {
  it.each([
    "FAILED",
    "IN_PROGRESS",
  ])("includes the newer %s retry after an old COMPLETE job on page one", async (status) => {
    const latest = {
      ...complete,
      PK: "DEPLOYMENT#new-job",
      GSI2SK: "2026-09-22T09:01:00.000Z",
      jobId: "new-job",
      createdAt: "2026-09-22T09:01:00.000Z",
      status,
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [complete], LastEvaluatedKey: cursor })
      .mockResolvedValueOnce({ Items: [latest] });
    const repo = new DynamoDbDeploymentsRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Deployments",
    );

    const rows = await repo.listByTeamLoginKey(loginKey);

    expect(rows.map((row) => ({ jobId: row.jobId, status: row.status }))).toEqual([
      { jobId: "old-job", status: "COMPLETE" },
      { jobId: "new-job", status },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const next = send.mock.calls[1]?.[0];
    expect(next).toBeInstanceOf(QueryCommand);
    expect(next.input).toEqual({
      TableName: "Deployments",
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": `TEAMKEY#${loginKey}` },
      ExclusiveStartKey: cursor,
    });
  });

  it("propagates a later page failure instead of returning a partial successful history", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [complete], LastEvaluatedKey: cursor })
      .mockRejectedValueOnce(new Error("query unavailable"));
    const repo = new DynamoDbDeploymentsRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "Deployments",
    );

    await expect(repo.listByTeamLoginKey(loginKey)).rejects.toThrow("query unavailable");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
