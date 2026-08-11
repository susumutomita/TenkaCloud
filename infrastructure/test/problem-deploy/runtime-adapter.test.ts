/**
 * [Issue #1268] Unit tests for the runtime adapter abstraction.
 *
 * Coverage:
 *   - `normalizeRuntime`: legacy `cfnTemplate` → aws/cloudformation, explicit
 *     `runtime` block parses through, malformed `runtime` returns undefined.
 *   - `selectAdapter`: aws/cloudformation resolves to
 *     `AwsCloudFormationRuntimeAdapter`; any other combination throws
 *     `RuntimeNotSupportedError` (= LOUD failure, no fallback).
 *   - `AwsCloudFormationRuntimeAdapter.deploy`: publishes the same
 *     `DeployCreateRequested` shape the legacy inline call did (behavior
 *     preservation).
 *   - Unimplemented methods (`collectOutputs` / `getStatus` / `destroy`) throw
 *     `AdapterMethodNotWiredError` instead of a placeholder result.
 */

import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterMethodNotWiredError,
  AwsCloudFormationRuntimeAdapter,
  classifyRuntimeSupport,
  EXECUTABLE_ENGINE,
  EXECUTABLE_PROVIDER,
  isExecutableRuntime,
  isReservedRuntime,
  normalizeRuntime,
  type ProblemRuntime,
  RESERVED_RUNTIMES,
  RuntimeNotSupportedError,
  selectAdapter,
} from "../../lib/problem-deploy/handlers/shared/runtime/index";

describe("normalizeRuntime", () => {
  it("should normalize a legacy cfnTemplate-only problem to aws/cloudformation", () => {
    const out = normalizeRuntime({ cfnTemplate: "template.yaml" });
    expect(out).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
  });

  it("should pass through an explicit aws/cloudformation runtime block", () => {
    const out = normalizeRuntime({
      runtime: { provider: "aws", engine: "cloudformation", entry: "template.yaml" },
      cfnTemplate: "template.yaml",
    });
    expect(out).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
  });

  it("should return the explicit runtime even when provider/engine is non-AWS", () => {
    // normalization stays loose; the registry / validator is what rejects
    // unsupported combinations. Normalization only fails on shape errors.
    const out = normalizeRuntime({
      runtime: { provider: "azure", engine: "bicep", entry: "main.bicep" },
    });
    expect(out).toEqual({ provider: "azure", engine: "bicep", entry: "main.bicep" });
  });

  it("should return undefined for a malformed runtime block (missing entry)", () => {
    const out = normalizeRuntime({ runtime: { provider: "aws", engine: "cloudformation" } });
    expect(out).toBeUndefined();
  });

  it("should default to template.yaml when neither runtime nor cfnTemplate is declared", () => {
    const out = normalizeRuntime({});
    expect(out).toEqual({
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    });
  });

  it("should mark aws/cloudformation as the executable combination", () => {
    expect(
      isExecutableRuntime({ provider: "aws", engine: "cloudformation", entry: "template.yaml" }),
    ).toBe(true);
    expect(isExecutableRuntime({ provider: "azure", engine: "bicep", entry: "main.bicep" })).toBe(
      false,
    );
  });
});

describe("classifyRuntimeSupport (reserved runtimes)", () => {
  it("should classify aws/cloudformation as executable", () => {
    expect(
      classifyRuntimeSupport({ provider: "aws", engine: "cloudformation", entry: "template.yaml" }),
    ).toBe("executable");
  });

  it.each(
    RESERVED_RUNTIMES.map((r) => [r.provider, r.engine] as const),
  )("should classify the planned runtime %s/%s as reserved", (provider, engine) => {
    const runtime: ProblemRuntime = { provider, engine, entry: "entry" };
    expect(classifyRuntimeSupport(runtime)).toBe("reserved");
    expect(isReservedRuntime(runtime)).toBe(true);
  });

  it("should reserve the three planned cloud runtime providers", () => {
    expect(RESERVED_RUNTIMES).toEqual([
      { provider: "sakura", engine: "apprun" },
      { provider: "azure", engine: "bicep" },
      { provider: "gcp", engine: "infra-manager" },
    ]);
  });

  it("should classify an unrecognized runtime as unknown (likely a typo)", () => {
    const runtime: ProblemRuntime = { provider: "kubernetes", engine: "helm", entry: "Chart.yaml" };
    expect(classifyRuntimeSupport(runtime)).toBe("unknown");
    expect(isReservedRuntime(runtime)).toBe(false);
  });

  it("should not treat a reserved provider with a different engine as reserved", () => {
    // azure/bicep is reserved, but azure/arm-template is not — only the exact
    // pair on the roadmap counts, so a typo'd engine still reads as unknown.
    expect(classifyRuntimeSupport({ provider: "azure", engine: "arm-template", entry: "x" })).toBe(
      "unknown",
    );
  });
});

describe("selectAdapter", () => {
  const deps = {
    aws: {
      events: { send: vi.fn() } as unknown as Parameters<typeof selectAdapter>[1]["aws"]["events"],
      eventBusName: "test-bus",
    },
  };

  it("should return the AWS CloudFormation adapter for aws/cloudformation", () => {
    const runtime: ProblemRuntime = {
      provider: "aws",
      engine: "cloudformation",
      entry: "template.yaml",
    };
    const adapter = selectAdapter(runtime, deps);
    expect(adapter).toBeInstanceOf(AwsCloudFormationRuntimeAdapter);
    expect(adapter.provider).toBe("aws");
    expect(adapter.engine).toBe("cloudformation");
  });

  it("should throw RuntimeNotSupportedError for azure/bicep", () => {
    const runtime: ProblemRuntime = {
      provider: "azure",
      engine: "bicep",
      entry: "main.bicep",
    };
    expect(() => selectAdapter(runtime, deps)).toThrow(RuntimeNotSupportedError);
  });

  it("should report a recognized runtime whose provider context is not configured", () => {
    const runtime: ProblemRuntime = { provider: "azure", engine: "bicep", entry: "main.bicep" };
    try {
      selectAdapter(runtime, deps);
      throw new Error("expected selectAdapter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeNotSupportedError);
      if (err instanceof RuntimeNotSupportedError) {
        expect(err.message).toContain("azure/bicep");
        expect(err.message).toContain("not configured");
        expect(err.message).toContain("credentials or client");
        expect(err.message).not.toContain("typo");
      }
    }
  });

  it("should reject a local container runtime with a make-local message, not a typo", () => {
    // docker/compose is a deliberate local-only runtime, so the cloud
    // deploy rejection must point at `make local` rather than calling it a typo.
    const runtime: ProblemRuntime = {
      provider: "docker",
      engine: "compose",
      entry: "local/docker-compose.yml",
    };
    try {
      selectAdapter(runtime, deps);
      throw new Error("expected selectAdapter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeNotSupportedError);
      if (err instanceof RuntimeNotSupportedError) {
        expect(err.message).toContain("docker/compose");
        expect(err.message).toContain("make local");
        expect(err.message).not.toContain("typo");
      }
    }
  });

  it("should include the rejected runtime in the error and flag an unknown runtime as a typo", () => {
    const runtime: ProblemRuntime = {
      provider: "kubernetes",
      engine: "helm",
      entry: "Chart.yaml",
    };
    try {
      selectAdapter(runtime, deps);
      throw new Error("expected selectAdapter to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeNotSupportedError);
      if (err instanceof RuntimeNotSupportedError) {
        expect(err.runtime).toEqual(runtime);
        expect(err.message).toContain("kubernetes/helm");
        expect(err.message).toContain("No adapter is registered");
        expect(err.message).toContain("typo");
      }
    }
  });

  // Reservation guard: even though normalize emits aws/cloudformation as the
  // baseline, the registry must not accept partial matches like
  // aws/<something-else>. We assert this explicitly so a future contributor
  // who reaches for `if (provider === "aws")` short-circuits has to update the
  // test too.
  it("should reject aws/<non-cloudformation> engines", () => {
    const runtime: ProblemRuntime = {
      provider: "aws",
      engine: "cdk",
      entry: "cdk.json",
    };
    expect(() => selectAdapter(runtime, deps)).toThrow(RuntimeNotSupportedError);
  });
});

describe("AwsCloudFormationRuntimeAdapter", () => {
  function build(): {
    adapter: AwsCloudFormationRuntimeAdapter;
    eventsSend: ReturnType<typeof vi.fn>;
  } {
    const eventsSend = vi.fn().mockResolvedValue({});
    const adapter = new AwsCloudFormationRuntimeAdapter({
      events: { send: eventsSend } as unknown as Parameters<
        typeof selectAdapter
      >[1]["aws"]["events"],
      eventBusName: "test-bus",
    });
    return { adapter, eventsSend };
  }

  it("should advertise aws/cloudformation as its provider/engine", () => {
    const { adapter } = build();
    expect(adapter.provider).toBe(EXECUTABLE_PROVIDER);
    expect(adapter.engine).toBe(EXECUTABLE_ENGINE);
  });

  it("should publish DeployCreateRequested with the legacy detail shape", async () => {
    const { adapter, eventsSend } = build();
    await adapter.deploy({
      jobId: "01HJOB",
      correlationId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
      externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    });
    expect(eventsSend).toHaveBeenCalledOnce();
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(cmd).toBeInstanceOf(PutEventsCommand);
    const entry = cmd.input.Entries?.[0];
    expect(entry?.EventBusName).toBe("test-bus");
    expect(entry?.Source).toBe("tenkacloud.deploy");
    expect(entry?.DetailType).toBe("DeployCreateRequested");
    const detail = JSON.parse(entry?.Detail ?? "{}");
    expect(detail).toMatchObject({
      jobId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      competitorRoleArn: "arn:aws:iam::123456789012:role/TenkaCloud-CompetitorDeploy-Role",
      externalIdParameterName: "/development/tenants/tenant-acme/external-id",
    });
  });

  it("should omit optional fields from the detail when absent (= legacy compat)", async () => {
    const { adapter, eventsSend } = build();
    await adapter.deploy({
      jobId: "01HJOB",
      correlationId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
    });
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail).not.toHaveProperty("competitorRoleArn");
    expect(detail).not.toHaveProperty("externalIdParameterName");
    expect(detail).not.toHaveProperty("challengePayloadUrl");
    expect(detail).not.toHaveProperty("parameters");
  });

  it("should forward bound Composite parameters in the published detail (#2747)", async () => {
    const { adapter, eventsSend } = build();
    await adapter.deploy({
      jobId: "01HJOB",
      correlationId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      parameters: { GcpEndpoint: "https://gcp.example" },
    });
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.parameters).toEqual({ GcpEndpoint: "https://gcp.example" });
  });

  it("should omit `parameters` from the detail when empty (= single-provider byte-compat)", async () => {
    const { adapter, eventsSend } = build();
    await adapter.deploy({
      jobId: "01HJOB",
      correlationId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
      parameters: {},
    });
    const cmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(cmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail).not.toHaveProperty("parameters");
  });

  it("should return status=pending after a successful publish", async () => {
    const { adapter } = build();
    const result = await adapter.deploy({
      jobId: "01HJOB",
      correlationId: "01HJOB",
      tenantId: "tenant-acme",
      problemId: "hello-world",
      problemDir: "problems/challenges/hello-world",
      teamSlug: "alpha-team",
      namePrefix: "tc-hello-world-alpha-team",
      region: "ap-northeast-1",
      awsAccountId: "123456789012",
    });
    expect(result.status).toBe("pending");
  });

  it("should throw AdapterMethodNotWiredError for collectOutputs", async () => {
    const { adapter } = build();
    await expect(
      adapter.collectOutputs({
        jobId: "01HJOB",
        namePrefix: "tc-hello-world-alpha-team",
        region: "ap-northeast-1",
        awsAccountId: "123456789012",
      }),
    ).rejects.toBeInstanceOf(AdapterMethodNotWiredError);
  });

  it("should throw AdapterMethodNotWiredError for getStatus", async () => {
    const { adapter } = build();
    await expect(
      adapter.getStatus({
        jobId: "01HJOB",
        namePrefix: "tc-hello-world-alpha-team",
        region: "ap-northeast-1",
        awsAccountId: "123456789012",
      }),
    ).rejects.toBeInstanceOf(AdapterMethodNotWiredError);
  });

  it("should throw AdapterMethodNotWiredError for destroy", async () => {
    const { adapter } = build();
    await expect(
      adapter.destroy({
        jobId: "01HJOB",
        namePrefix: "tc-hello-world-alpha-team",
        region: "ap-northeast-1",
        awsAccountId: "123456789012",
      }),
    ).rejects.toBeInstanceOf(AdapterMethodNotWiredError);
  });
});
