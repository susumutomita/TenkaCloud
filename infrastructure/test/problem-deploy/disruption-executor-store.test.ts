import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisruptionFiredDetail } from "../../lib/problem-deploy/handlers/disruption-executor-handler/execute";
import {
  claimExecution,
  type ExecutorResources,
  resolveDeployment,
} from "../../lib/problem-deploy/handlers/disruption-executor-handler/executor-store";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [#1419] executor の DDB dep 実装。 claimExecution (冪等 Put) と resolveDeployment
 * (GSI1 query + COMPLETE filter + stackOutputs parse) を mocked ddb で pin する。
 */

const detail: DisruptionFiredDetail = {
  disruptionId: "ec2-latency-injection",
  eventId: "evt-1",
  problemId: "microservice-migration-battle",
  tenantId: "tenant-1",
  teamId: "team-1",
  parameters: { delayMs: 200 },
  requestId: "req-1",
  firedAt: "2026-06-02T00:00:00.000Z",
};

function makeResources(send: ReturnType<typeof vi.fn>): ExecutorResources {
  return {
    runtime: makeTestControlDataRuntime(),
    ddb: { send } as unknown as ExecutorResources["ddb"],
    deploymentsTableName: "Deployments",
    disruptionsTableName: "Disruptions",
  };
}

describe("claimExecution (#1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should Put the EXEC# row with attribute_not_exists and return claimed", async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await claimExecution(makeResources(send), detail, 1_000_000)).toBe("claimed");
    const put = send.mock.calls[0][0];
    expect(put.input.TableName).toBe("Disruptions");
    expect(put.input.Item.PK).toBe("EXEC#req-1#team-1");
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(put.input.Item.expiresAt).toBe(Math.floor(1_000_000 / 1000) + 7 * 24 * 60 * 60);
  });

  it("should Put a distinct EXEC#...#INJECT row for phase='inject'", async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await claimExecution(makeResources(send), detail, 1_000_000, "inject")).toBe("claimed");
    expect(send.mock.calls[0][0].input.Item.PK).toBe("EXEC#req-1#team-1#INJECT");
  });

  it("phase='event' uses the same key as the default", async () => {
    const send = vi.fn().mockResolvedValue({});
    await claimExecution(makeResources(send), detail, 1_000_000, "event");
    expect(send.mock.calls[0][0].input.Item.PK).toBe("EXEC#req-1#team-1");
  });

  it("phase='recurring' keys per-tick on firedAt so each tick claims once", async () => {
    const send = vi.fn().mockResolvedValue({});
    // tick 1 (one firedAt)
    await claimExecution(makeResources(send), detail, 1_000_000, "recurring");
    expect(send.mock.calls[0][0].input.Item.PK).toBe(
      "EXEC#req-1#team-1#RECUR#2026-06-02T00:00:00.000Z",
    );
    // tick 2 (a later firedAt = the next aws-scheduler scheduled-time) → distinct key
    await claimExecution(
      makeResources(send),
      { ...detail, firedAt: "2026-06-02T00:05:00.000Z" },
      1_000_000,
      "recurring",
    );
    expect(send.mock.calls[1][0].input.Item.PK).toBe(
      "EXEC#req-1#team-1#RECUR#2026-06-02T00:05:00.000Z",
    );
  });

  it("should return duplicate on ConditionalCheckFailed", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    expect(await claimExecution(makeResources(send), detail, 0)).toBe("duplicate");
  });

  it("should propagate non-conditional errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    await expect(claimExecution(makeResources(send), detail, 0)).rejects.toThrow("throttled");
  });

  it("should honor a custom execTtlSeconds", async () => {
    const send = vi.fn().mockResolvedValue({});
    const resources = { ...makeResources(send), execTtlSeconds: 60 };
    await claimExecution(resources, detail, 5000);
    expect(send.mock.calls[0][0].input.Item.expiresAt).toBe(Math.floor(5000 / 1000) + 60);
  });
});

describe("resolveDeployment (#1419)", () => {
  beforeEach(() => vi.clearAllMocks());

  const completeRow = {
    status: "COMPLETE",
    jobId: "job-1",
    region: "ap-northeast-1",
    competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
    externalIdParameterName: "/tenkacloud/tenant-1/external-id",
    teamId: "team-1",
    problemId: "microservice-migration-battle",
    eventId: "evt-1",
    stackOutputs: JSON.stringify({ WorkerInstanceIds: "i-aaa,i-bbb" }),
  };

  it("should query GSI1 by tenant + filter event/team/problem and return the parsed target", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [completeRow] });
    const target = await resolveDeployment(makeResources(send), detail);
    expect(target).toEqual({
      jobId: "job-1",
      region: "ap-northeast-1",
      competitorRoleArn: "arn:aws:iam::111122223333:role/TenkaCloud-CompetitorDeploy-Role",
      externalIdParameterName: "/tenkacloud/tenant-1/external-id",
      stackOutputs: { WorkerInstanceIds: "i-aaa,i-bbb" },
    });
    const query = send.mock.calls[0][0];
    expect(query.input.IndexName).toBe("GSI1");
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ":pk": "TENANT#tenant-1",
      ":ev": "evt-1",
      ":tid": "team-1",
      ":pid": "microservice-migration-battle",
    });
  });

  it("should return undefined when no row is COMPLETE", async () => {
    const send = vi.fn().mockResolvedValue({ Items: [{ ...completeRow, status: "IN_PROGRESS" }] });
    expect(await resolveDeployment(makeResources(send), detail)).toBeUndefined();
  });

  it("#1710: should return a same-account target for a Lite COMPLETE row without cross-account fields", async () => {
    // Lite mode (= same-account deploy) は competitorRoleArn / externalIdParameterName を持たない。
    // 旧実装はこれを skip して disruption が silently no-op していた。 今は target を返し、
    // executor は AssumeRole せず自分の credentials で同一アカウントへ注入する。
    const send = vi.fn().mockResolvedValue({
      Items: [{ ...completeRow, competitorRoleArn: undefined, externalIdParameterName: undefined }],
    });
    const target = await resolveDeployment(makeResources(send), detail);
    expect(target).toEqual({
      jobId: "job-1",
      region: "ap-northeast-1",
      stackOutputs: { WorkerInstanceIds: "i-aaa,i-bbb" },
    });
    expect(target?.competitorRoleArn).toBeUndefined();
    expect(target?.externalIdParameterName).toBeUndefined();
  });

  it("#1710: should treat an asymmetric row (role set, externalId absent) as same-account", async () => {
    // deploy-handler は competitorRoleArn を行に永続化するが externalIdParameterName は
    // event detail にしか載せない (deploy.ts:177 vs 259-261)。 結果、 実際の Lite/SaaS 行は
    // 「role 有・externalId 無」の非対称になる。 片方だけでは AssumeRole できない
    // (assumeCompetitorRole の both-or-neither 契約) ので same-account injection 扱いにする。
    // role だけを target に載せると assumeCompetitorRole が "must be provided together" で throw する。
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          ...completeRow,
          competitorRoleArn: "arn:aws:iam::672726205532:role/TenkaCloud-local-deploy-Role",
          externalIdParameterName: undefined,
        },
      ],
    });
    const target = await resolveDeployment(makeResources(send), detail);
    expect(target).toEqual({
      jobId: "job-1",
      region: "ap-northeast-1",
      stackOutputs: { WorkerInstanceIds: "i-aaa,i-bbb" },
    });
    expect(target?.competitorRoleArn).toBeUndefined();
    expect(target?.externalIdParameterName).toBeUndefined();
  });

  it("should default stackOutputs to {} when the row has no stackOutputs", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ Items: [{ ...completeRow, stackOutputs: undefined }] });
    expect((await resolveDeployment(makeResources(send), detail))?.stackOutputs).toEqual({});
  });

  it("should return undefined on an empty result set", async () => {
    const send = vi.fn().mockResolvedValue({});
    expect(await resolveDeployment(makeResources(send), detail)).toBeUndefined();
  });
});
