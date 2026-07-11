/**
 * [Composite Runtime / Issue #2076] Provider-neutral participant access
 * capability for a composite target.
 *
 * Covers the contract + lookup defined in #2076 (NO credential issuance, NO
 * sign-in, NO federation — those are later bridge issues):
 *   - the pure capability matrix (aws → console + cli-credentials; gcp / azure /
 *     sakura → external-portal; anything else → unsupported),
 *   - capability is a pure function of provider + readiness,
 *   - a target lookup scoped to the authenticated participant team,
 *   - a cross-team target is indistinguishable from not-found,
 *   - a target that is not COMPLETE is not_ready,
 *   - the descriptor leaks no provider config / role ARN / account id / secret.
 */

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeDeploymentRepositoryDeps } from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import {
  lookupTargetAccess,
  resolveTargetAccessCapability,
  TargetAccessDescriptorSchema,
  type TargetAccessProvider,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-target-access";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const PARENT_ID = "01HPARENTAAAAAAAAAAAAAAAAA";
const TARGET_ID = "01HTARGETxxxxxxxxxxxxxxxxxx";
const TEAM_KEY = "TEAM_LOGIN_KEY_1";

function buildDeps(): {
  deps: CompositeDeploymentRepositoryDeps;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const deps: CompositeDeploymentRepositoryDeps = {
    runtime: makeTestControlDataRuntime(),
    ddb: { send: ddbSend },
    tableName: "TestDeployments",
  };
  return { deps, ddbSend };
}

/**
 * A composite target row carrying the full secret / identity surface a real row
 * has, so the leak guard can assert none of it escapes into the descriptor.
 */
const targetRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${TARGET_ID}`,
  SK: "META",
  jobId: TARGET_ID,
  parentDeploymentId: PARENT_ID,
  targetId: "edge",
  targetOrdinal: 0,
  tenantId: "tenant-acme",
  problemId: "multicloud-relay",
  runtimeProvider: "aws",
  runtimeEngine: "cloudformation",
  runtimeEntry: "template.yaml",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "Alpha",
  namePrefix: "tc-multicloud-relay-alpha",
  teamLoginKey: TEAM_KEY,
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/tenkacloud/tenant-acme/external-id",
  status: "COMPLETE",
  createdAt: "2026-06-29T00:00:00.000Z",
  updatedAt: "2026-06-29T00:00:03.000Z",
  expiresAt: 1_800_000_000,
  GSI3PK: `PARENT_DEPLOYMENT#${PARENT_ID}`,
  GSI3SK: "ORDINAL#00#TARGET#edge",
  ...over,
});

describe("resolveTargetAccessCapability", () => {
  it("should return AWS console and CLI capabilities for a ready AWS target", () => {
    expect(resolveTargetAccessCapability("aws", "COMPLETE")).toEqual([
      "console",
      "cli-credentials",
    ]);
  });

  it("should return external portal capability for ready GCP Azure and Sakura targets", () => {
    expect(resolveTargetAccessCapability("gcp", "COMPLETE")).toEqual(["external-portal"]);
    expect(resolveTargetAccessCapability("azure", "COMPLETE")).toEqual(["external-portal"]);
    expect(resolveTargetAccessCapability("sakura", "COMPLETE")).toEqual(["external-portal"]);
  });

  it("should return an unsupported capability for an unknown provider", () => {
    expect(resolveTargetAccessCapability("oracle" as TargetAccessProvider, "COMPLETE")).toEqual([
      "unsupported",
    ]);
  });

  it("should be a pure function of provider and readiness only", () => {
    // No readiness consideration here — the matrix depends only on the provider.
    // (Readiness gating happens in the lookup, which never reaches the resolver
    // until the target is COMPLETE.) Calling twice yields the same array.
    expect(resolveTargetAccessCapability("aws", "COMPLETE")).toEqual(
      resolveTargetAccessCapability("aws", "COMPLETE"),
    );
    expect(resolveTargetAccessCapability("gcp", "COMPLETE")).toEqual(
      resolveTargetAccessCapability("gcp", "COMPLETE"),
    );
  });
});

describe("lookupTargetAccess", () => {
  let ddbSend: ReturnType<typeof vi.fn>;
  let deps: CompositeDeploymentRepositoryDeps;

  beforeEach(() => {
    ({ deps, ddbSend } = buildDeps());
  });

  it("should return AWS console and CLI capabilities for a ready AWS target", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [targetRow({ runtimeProvider: "aws" })] });

    const out = await lookupTargetAccess(deps, {
      teamLoginKey: TEAM_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: TARGET_ID,
    });

    expect(out).toEqual({
      kind: "ok",
      descriptor: {
        targetId: "edge",
        targetDeploymentId: TARGET_ID,
        provider: "aws",
        capability: ["console", "cli-credentials"],
      },
    });
    // The lookup resolves the target through the GSI3 parent->target query.
    const queryCmd = ddbSend.mock.calls
      .map((c) => c[0])
      .find((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queryCmd?.input.IndexName).toBe("GSI3");
    expect(queryCmd?.input.ExpressionAttributeValues?.[":pk"]).toBe(
      `PARENT_DEPLOYMENT#${PARENT_ID}`,
    );
  });

  it("should return external portal capability for ready GCP Azure and Sakura targets", async () => {
    for (const provider of ["gcp", "azure", "sakura"] as const) {
      const { deps: d, ddbSend: send } = buildDeps();
      send.mockResolvedValueOnce({
        Items: [targetRow({ runtimeProvider: provider, targetId: provider })],
      });

      const out = await lookupTargetAccess(d, {
        teamLoginKey: TEAM_KEY,
        parentDeploymentId: PARENT_ID,
        targetDeploymentId: TARGET_ID,
      });

      expect(out).toEqual({
        kind: "ok",
        descriptor: {
          targetId: provider,
          targetDeploymentId: TARGET_ID,
          provider,
          capability: ["external-portal"],
        },
      });
    }
  });

  it("should return not ready before target completion", async () => {
    for (const status of ["PENDING", "APPROVAL_PENDING", "IN_PROGRESS", "FAILED"] as const) {
      const { deps: d, ddbSend: send } = buildDeps();
      send.mockResolvedValueOnce({ Items: [targetRow({ status })] });

      const out = await lookupTargetAccess(d, {
        teamLoginKey: TEAM_KEY,
        parentDeploymentId: PARENT_ID,
        targetDeploymentId: TARGET_ID,
      });

      expect(out).toEqual({ kind: "not_ready" });
    }
  });

  it("should return not found for another team target", async () => {
    // The target exists, but it belongs to a different participant team. The
    // cross-team case must be indistinguishable from a missing target.
    ddbSend.mockResolvedValueOnce({
      Items: [targetRow({ teamLoginKey: "SOME_OTHER_TEAM_KEY" })],
    });

    const out = await lookupTargetAccess(deps, {
      teamLoginKey: TEAM_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: TARGET_ID,
    });

    expect(out).toEqual({ kind: "not_found" });
  });

  it("should return not found when the target does not exist under the parent", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await lookupTargetAccess(deps, {
      teamLoginKey: TEAM_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: "01HDOESNOTEXISTxxxxxxxxxxx",
    });

    expect(out).toEqual({ kind: "not_found" });
  });

  it("should not expose connection or credential fields", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        targetRow({
          competitorRoleArn: "arn:aws:iam::999999999999:role/PLANTED-SECRET-ROLE",
          externalIdParameterName: "/planted/external-id",
          teamLoginKey: TEAM_KEY,
          awsAccountId: "111122223333",
        }),
      ],
    });

    const out = await lookupTargetAccess(deps, {
      teamLoginKey: TEAM_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: TARGET_ID,
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;

    const serialized = JSON.stringify(out.descriptor);
    expect(serialized).not.toContain("PLANTED-SECRET-ROLE");
    expect(serialized).not.toContain("/planted/external-id");
    expect(serialized).not.toContain("111122223333");
    expect(serialized).not.toContain("competitorRoleArn");
    expect(serialized).not.toContain("externalIdParameterName");
    expect(serialized).not.toContain("teamLoginKey");
    expect(serialized).not.toContain("awsAccountId");
    expect(serialized).not.toContain("region");
    expect(serialized).not.toContain("namePrefix");
    expect(serialized).not.toContain("runtimeEntry");
    // Only the whitelisted descriptor keys are present.
    expect(Object.keys(out.descriptor).sort()).toEqual(
      ["capability", "provider", "targetDeploymentId", "targetId"].sort(),
    );
  });

  it("should describe an unsupported provider target without exposing config", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [targetRow({ runtimeProvider: "oracle", status: "COMPLETE" })],
    });

    const out = await lookupTargetAccess(deps, {
      teamLoginKey: TEAM_KEY,
      parentDeploymentId: PARENT_ID,
      targetDeploymentId: TARGET_ID,
    });

    expect(out).toEqual({
      kind: "ok",
      descriptor: {
        targetId: "edge",
        targetDeploymentId: TARGET_ID,
        provider: "unsupported",
        capability: ["unsupported"],
      },
    });
  });
});

describe("TargetAccessDescriptor contract", () => {
  it("should accept the four-provider capability matrix and reject leaked fields", () => {
    const matrix: Array<{ provider: TargetAccessProvider; capability: string[] }> = [
      { provider: "aws", capability: ["console", "cli-credentials"] },
      { provider: "gcp", capability: ["external-portal"] },
      { provider: "azure", capability: ["external-portal"] },
      { provider: "sakura", capability: ["external-portal"] },
    ];
    for (const { provider, capability } of matrix) {
      const parsed = TargetAccessDescriptorSchema.safeParse({
        targetId: "edge",
        targetDeploymentId: TARGET_ID,
        provider,
        capability,
      });
      expect(parsed.success).toBe(true);
    }

    // The contract rejects an unknown capability value — it cannot silently
    // widen to a credential-bearing variant.
    const badCapability = TargetAccessDescriptorSchema.safeParse({
      targetId: "edge",
      targetDeploymentId: TARGET_ID,
      provider: "aws",
      capability: ["full-admin"],
    });
    expect(badCapability.success).toBe(false);

    // The contract rejects an unknown provider.
    const badProvider = TargetAccessDescriptorSchema.safeParse({
      targetId: "edge",
      targetDeploymentId: TARGET_ID,
      provider: "oracle",
      capability: ["unsupported"],
    });
    expect(badProvider.success).toBe(false);
  });
});
