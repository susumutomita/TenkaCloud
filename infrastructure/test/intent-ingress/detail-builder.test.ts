import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { describe, expect, it } from "vitest";
import {
  buildDeployCreateDetail,
  buildDeployDeleteDetail,
} from "../../lib/intent-ingress/detail-builder";
import { buildStackPrefix } from "../../lib/problem-deploy/handlers/deploy-handler/naming";
import {
  DeployCreateRequestedDetailSchema,
  DeployDeleteRequestedDetailSchema,
} from "../../lib/problem-deploy/handlers/shared/events";
import { AwsCloudFormationRuntimeAdapter } from "../../lib/problem-deploy/handlers/shared/runtime/aws-cfn-adapter";
import { makeVerified } from "./intent-fixtures";

const catalog: Record<string, string> = {
  "hello-world": "problems/challenges/hello-world",
};
const resolveProblemDir = (problemId: string): string | undefined => catalog[problemId];

describe("buildDeployCreateDetail (ADR-049 Phase 4 / #2293)", () => {
  it("should build a frozen DeployCreateRequested detail from intent identifiers", () => {
    const intent = makeVerified();
    const result = buildDeployCreateDetail(intent, { resolveProblemDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Conforms to the authoritative frozen schema.
    expect(DeployCreateRequestedDetailSchema.safeParse(result.detail).success).toBe(true);
    expect(result.detail).toEqual({
      jobId: "job-abc", // source.deploymentId
      correlationId: "job-abc", // requestId
      tenantId: "tenant-a",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "team-alpha",
      namePrefix: "tc-hello-world-team-alpha",
      region: "us-east-1",
      awsAccountId: "111111111111",
    });
  });

  it("should fall back to requestId for jobId when deploymentId is absent", () => {
    const intent = makeVerified({ requestId: "req-77", source: { deploymentId: undefined } });
    const result = buildDeployCreateDetail(intent, { resolveProblemDir });
    expect(result.ok && result.detail.jobId).toBe("req-77");
  });

  it("should reject problem-id-missing when the intent carries no problemId", () => {
    const intent = makeVerified({ source: { problemId: undefined } });
    expect(buildDeployCreateDetail(intent, { resolveProblemDir })).toEqual({
      ok: false,
      reason: "problem-id-missing",
    });
  });

  it("should reject team-id-missing when the intent carries no teamId", () => {
    const intent = makeVerified({ source: { teamId: undefined } });
    expect(buildDeployCreateDetail(intent, { resolveProblemDir })).toEqual({
      ok: false,
      reason: "team-id-missing",
    });
  });

  it("should reject region-missing when the target carries no region", () => {
    const intent = makeVerified({ target: { region: undefined } });
    expect(buildDeployCreateDetail(intent, { resolveProblemDir })).toEqual({
      ok: false,
      reason: "region-missing",
    });
  });

  it("should reject unknown-problem-dir when the catalog has no entry", () => {
    const intent = makeVerified({ source: { problemId: "not-in-catalog" } });
    expect(buildDeployCreateDetail(intent, { resolveProblemDir })).toEqual({
      ok: false,
      reason: "unknown-problem-dir",
    });
  });

  it("should reject detail-schema-invalid for a non-12-digit account ref", () => {
    const intent = makeVerified({ target: { providerAccountRef: "not-an-account" } });
    const result = buildDeployCreateDetail(intent, { resolveProblemDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("detail-schema-invalid");
    expect(result.details?.some((d) => d.startsWith("awsAccountId"))).toBe(true);
  });

  // The crux of the slice: the re-emitted detail must be byte-compatible with what the
  // existing publisher (AwsCloudFormationRuntimeAdapter) puts on the deploy bus.
  it("should produce the exact detail the existing DeployCreateRequested publisher emits", async () => {
    const jobId = "job-abc";
    const teamSlug = "team-alpha";
    const problemId = "hello-world";
    const problemDir = "problems/challenges/hello-world";
    const region = "us-east-1";
    const awsAccountId = "111111111111";

    // Capture what the real adapter publishes for an equivalent RuntimeDeployInput.
    let captured: unknown;
    const fakeEvents = {
      send: async (cmd: { input: { Entries: { Detail: string }[] } }) => {
        captured = JSON.parse(cmd.input.Entries[0].Detail);
        return { FailedEntryCount: 0 };
      },
    } as unknown as EventBridgeClient;
    const adapter = new AwsCloudFormationRuntimeAdapter({
      events: fakeEvents,
      eventBusName: "bus",
    });
    await adapter.deploy({
      jobId,
      correlationId: jobId,
      tenantId: "tenant-a",
      problemId,
      problemDir,
      teamSlug,
      namePrefix: buildStackPrefix(problemId, teamSlug),
      region,
      awsAccountId,
    });

    // Build from an equivalent intent and assert deep equality.
    const intent = makeVerified({
      requestId: jobId,
      source: { deploymentId: jobId, tenantId: "tenant-a", problemId, teamId: teamSlug },
      target: { providerAccountRef: awsAccountId, region },
    });
    const result = buildDeployCreateDetail(intent, { resolveProblemDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail).toEqual(captured);
  });
});

describe("buildDeployDeleteDetail (ADR-049 Phase 4 / #2293)", () => {
  it("should build a frozen DeployDeleteRequested detail from intent identifiers", () => {
    const intent = makeVerified({ action: { type: "destroy" } });
    const result = buildDeployDeleteDetail(intent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(DeployDeleteRequestedDetailSchema.safeParse(result.detail).success).toBe(true);
    expect(result.detail).toEqual({
      jobId: "job-abc",
      correlationId: "job-abc",
      tenantId: "tenant-a",
      stackName: "tc-hello-world-team-alpha",
      region: "us-east-1",
      awsAccountId: "111111111111",
    });
  });

  it("should reject problem-id-missing for a destroy intent without a problemId", () => {
    const intent = makeVerified({ action: { type: "destroy" }, source: { problemId: undefined } });
    expect(buildDeployDeleteDetail(intent)).toEqual({ ok: false, reason: "problem-id-missing" });
  });

  it("should reject team-id-missing for a destroy intent without a teamId", () => {
    const intent = makeVerified({ action: { type: "destroy" }, source: { teamId: undefined } });
    expect(buildDeployDeleteDetail(intent)).toEqual({ ok: false, reason: "team-id-missing" });
  });

  it("should reject region-missing for a destroy intent without a region", () => {
    const intent = makeVerified({ action: { type: "destroy" }, target: { region: undefined } });
    expect(buildDeployDeleteDetail(intent)).toEqual({ ok: false, reason: "region-missing" });
  });

  it("should reject detail-schema-invalid for a non-12-digit account ref", () => {
    const intent = makeVerified({
      action: { type: "destroy" },
      target: { providerAccountRef: "bad" },
    });
    const result = buildDeployDeleteDetail(intent);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("detail-schema-invalid");
  });
});
