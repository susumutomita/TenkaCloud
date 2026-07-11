/**
 * [Composite Runtime / Issue #2069] Tests for the target-namespaced composite
 * output collector. Seeds target rows (with the GSI3 keys + per-target
 * `stackOutputs`) into an in-memory DynamoDB fake and drives the real GSI3 query.
 */

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  compositeTargetGsi3Pk,
  compositeTargetGsi3Sk,
  deploymentPk,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-deployment";
import {
  CompositeOutputsError,
  collectCompositeOutputs,
} from "../../lib/problem-deploy/handlers/deploy-handler/composite-outputs";
import type { CompositeDeploymentRepositoryDeps } from "../../lib/problem-deploy/handlers/deploy-handler/composite-repository";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const PARENT = "parent-1";

interface SeedTarget {
  targetId: string;
  ordinal: number;
  status: string;
  stackOutputs?: string;
}

function makeFake(targets: SeedTarget[]): CompositeDeploymentRepositoryDeps {
  const rows = targets.map((t) => ({
    PK: deploymentPk(`dep-${t.targetId}`),
    SK: "META",
    jobId: `dep-${t.targetId}`,
    parentDeploymentId: PARENT,
    targetId: t.targetId,
    targetOrdinal: t.ordinal,
    status: t.status,
    GSI3PK: compositeTargetGsi3Pk(PARENT),
    GSI3SK: compositeTargetGsi3Sk(t.ordinal, t.targetId),
    ...(t.stackOutputs !== undefined ? { stackOutputs: t.stackOutputs } : {}),
  }));
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof QueryCommand) {
      const pk = cmd.input.ExpressionAttributeValues?.[":pk"];
      const matched = rows
        .filter((r) => r.GSI3PK === pk)
        .sort((a, b) => String(a.GSI3SK).localeCompare(String(b.GSI3SK)));
      return { Items: matched.map((r) => ({ ...r })) };
    }
    throw new Error("unexpected command");
  });
  return { runtime: makeTestControlDataRuntime(), ddb: { send }, tableName: "T" };
}

describe("collectCompositeOutputs (#2069)", () => {
  it("namespaces duplicate output keys by target id", async () => {
    const deps = makeFake([
      {
        targetId: "aws-api",
        ordinal: 0,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Url: "https://aws" }),
      },
      {
        targetId: "gcp-worker",
        ordinal: 1,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Url: "https://gcp" }),
      },
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(out).toEqual({
      "aws-api": { Url: "https://aws" },
      "gcp-worker": { Url: "https://gcp" },
    });
  });

  it("includes COMPLETE AWS GCP Azure and Sakura target outputs", async () => {
    const deps = makeFake([
      {
        targetId: "aws-api",
        ordinal: 0,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ ApiUrl: "https://a.aws" }),
      },
      {
        targetId: "gcp-worker",
        ordinal: 1,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ ServiceUrl: "https://g.run.app" }),
      },
      {
        targetId: "azure-edge",
        ordinal: 2,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Endpoint: "https://a.azure" }),
      },
      {
        targetId: "sakura-svc",
        ordinal: 3,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Url: "https://s.sakura" }),
      },
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(out).toEqual({
      "aws-api": { ApiUrl: "https://a.aws" },
      "gcp-worker": { ServiceUrl: "https://g.run.app" },
      "azure-edge": { Endpoint: "https://a.azure" },
      "sakura-svc": { Url: "https://s.sakura" },
    });
  });

  it("returns an empty object for a COMPLETE target with no outputs", async () => {
    const deps = makeFake([
      { targetId: "aws-api", ordinal: 0, status: "COMPLETE" }, // no stackOutputs
      { targetId: "gcp-worker", ordinal: 1, status: "COMPLETE", stackOutputs: "" }, // empty string
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(out).toEqual({ "aws-api": {}, "gcp-worker": {} });
  });

  it("omits non-COMPLETE targets", async () => {
    const deps = makeFake([
      {
        targetId: "aws-api",
        ordinal: 0,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Url: "https://aws" }),
      },
      { targetId: "gcp-worker", ordinal: 1, status: "PENDING" },
      { targetId: "azure-edge", ordinal: 2, status: "FAILED" },
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(out).toEqual({ "aws-api": { Url: "https://aws" } });
  });

  it("throws with parent and target identity for malformed outputs", async () => {
    const deps = makeFake([
      { targetId: "aws-api", ordinal: 0, status: "COMPLETE", stackOutputs: "{not-json" },
    ]);
    const error = await collectCompositeOutputs(deps, PARENT).catch((e) => e);
    expect(error).toBeInstanceOf(CompositeOutputsError);
    expect(error.parentDeploymentId).toBe(PARENT);
    expect(error.targetId).toBe("aws-api");
  });

  it("applies the existing output parsing rules unchanged (map and CFn-array forms)", async () => {
    const deps = makeFake([
      {
        targetId: "map-form",
        ordinal: 0,
        status: "COMPLETE",
        stackOutputs: JSON.stringify({ Key: "v" }),
      },
      {
        targetId: "array-form",
        ordinal: 1,
        status: "COMPLETE",
        stackOutputs: JSON.stringify([{ OutputKey: "ApiUrl", OutputValue: "https://x" }]),
      },
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(out["map-form"]).toEqual({ Key: "v" });
    expect(out["array-form"]).toEqual({ ApiUrl: "https://x" });
  });

  it("preserves target declaration (ordinal) order in collector iteration", async () => {
    const deps = makeFake([
      { targetId: "third", ordinal: 2, status: "COMPLETE", stackOutputs: "{}" },
      { targetId: "first", ordinal: 0, status: "COMPLETE", stackOutputs: "{}" },
      { targetId: "second", ordinal: 1, status: "COMPLETE", stackOutputs: "{}" },
    ]);
    const out = await collectCompositeOutputs(deps, PARENT);
    expect(Object.keys(out)).toEqual(["first", "second", "third"]);
  });
});
