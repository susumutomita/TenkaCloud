import { describe, expect, it } from "vitest";
import type { DeploymentProvenance } from "../../lib/problem-deploy/handlers/shared/deployment-provenance.js";
import {
  provenanceAuditExtra,
  provenanceItemFields,
  toDeploymentProvenance,
} from "../../lib/problem-deploy/handlers/shared/deployment-provenance.js";

/**
 * [Problem Packs / Issue #2096] Pack provenance is copied from the EVENT-pinned
 * catalog snapshot (#2095), never from client input. Core (non-pack) deployments
 * keep the existing row shape and response unchanged: no provenance field at all.
 */
describe("toDeploymentProvenance", () => {
  it("should map a pack snapshot provenance into the display/audit-safe shape", () => {
    const result = toDeploymentProvenance(
      {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.2.0",
        contentDigest: "sha256-abc",
      },
      "snap-123",
    );
    expect(result).toEqual({
      packId: "com.example.cloud-pack",
      packVersion: "1.2.0",
      contentDigest: "sha256-abc",
      catalogSnapshotId: "snap-123",
    });
  });

  it("should return undefined for a core problem so the row shape stays unchanged", () => {
    expect(toDeploymentProvenance({ source: "core" }, "snap-123")).toBeUndefined();
  });

  it("should return undefined when no snapshot provenance was resolved", () => {
    expect(toDeploymentProvenance(undefined, "snap-123")).toBeUndefined();
  });

  it("should never carry a local path or source credential field", () => {
    const result = toDeploymentProvenance(
      {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.2.0",
        contentDigest: "sha256-abc",
      },
      "snap-123",
    );
    const keys = Object.keys(result ?? {});
    expect(keys).toEqual(["packId", "packVersion", "contentDigest", "catalogSnapshotId"]);
    expect(keys).not.toContain("sourceRef");
    expect(keys).not.toContain("snapshotPath");
    expect(keys).not.toContain("directory");
  });
});

describe("provenanceItemFields", () => {
  it("should add a provenance attribute only for a pack deployment", () => {
    const provenance: DeploymentProvenance = {
      packId: "com.example.cloud-pack",
      packVersion: "1.2.0",
      contentDigest: "sha256-abc",
      catalogSnapshotId: "snap-123",
    };
    expect(provenanceItemFields(provenance)).toEqual({ provenance });
  });

  it("should add no attribute for a core deployment (byte-identical row)", () => {
    expect(provenanceItemFields(undefined)).toEqual({});
  });
});

describe("provenanceAuditExtra", () => {
  it("should include every provenance field as audit extra for a pack deployment", () => {
    const provenance: DeploymentProvenance = {
      packId: "com.example.cloud-pack",
      packVersion: "1.2.0",
      contentDigest: "sha256-abc",
      catalogSnapshotId: "snap-123",
    };
    expect(provenanceAuditExtra(provenance)).toEqual({
      packId: "com.example.cloud-pack",
      packVersion: "1.2.0",
      contentDigest: "sha256-abc",
      catalogSnapshotId: "snap-123",
    });
  });

  it("should produce no extra fields for a core deployment", () => {
    expect(provenanceAuditExtra(undefined)).toEqual({});
  });
});
