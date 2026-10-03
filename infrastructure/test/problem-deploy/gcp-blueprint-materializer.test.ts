import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeterministicBlueprintZip,
  computeBlueprintObjectKey,
  materializeGcpBlueprint,
  resolveGcpTerraformSource,
  type TerraformSourceFile,
} from "../../lib/problem-deploy/runtime-clients/gcp-blueprint-materializer.js";

/**
 * [Issue #2745] Unit tests for the GCP Terraform blueprint materializer: the missing
 * INPUT-side step that turns `runtime.entry` (a repository-relative path) into the `gs://` object
 * `gcp-infra-manager-rest-client.ts`'s fail-closed `assertGcsBlueprintRef` requires.
 *
 * No real S3 / GCS / network call anywhere — S3 is a fake `{ send }`, GCS upload/reuse is a fake
 * `fetch`, and the private-problem path injects a fake `fetchPayloadDirectory`.
 */

const FILE_A: TerraformSourceFile = { relativePath: "main.tf", bytes: strToU8('resource "x" {}') };
const FILE_B: TerraformSourceFile = {
  relativePath: "variables.tf",
  bytes: strToU8('variable "y" {}'),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildDeterministicBlueprintZip (#2745)", () => {
  it("should produce byte-identical output for the same input regardless of call order", () => {
    const zipA = buildDeterministicBlueprintZip([FILE_A, FILE_B]);
    const zipB = buildDeterministicBlueprintZip([FILE_B, FILE_A]); // reversed input order
    expect(Buffer.from(zipA).equals(Buffer.from(zipB))).toBe(true);
  });

  it("should produce byte-identical output across repeated calls (no embedded timestamp)", () => {
    const first = buildDeterministicBlueprintZip([FILE_A]);
    const second = buildDeterministicBlueprintZip([FILE_A]);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("should change output when file content changes", () => {
    const zipA = buildDeterministicBlueprintZip([FILE_A]);
    const changed: TerraformSourceFile = {
      relativePath: "main.tf",
      bytes: strToU8('resource "z" {}'),
    };
    const zipC = buildDeterministicBlueprintZip([changed]);
    expect(Buffer.from(zipA).equals(Buffer.from(zipC))).toBe(false);
  });

  it("should throw when given zero files", () => {
    expect(() => buildDeterministicBlueprintZip([])).toThrow(/zero files/);
  });
});

describe("computeBlueprintObjectKey (#2745)", () => {
  it("should build a tenant/team/problem-scoped, content-addressed key", () => {
    const zipBytes = buildDeterministicBlueprintZip([FILE_A]);
    const key = computeBlueprintObjectKey({
      tenantId: "tenant-1",
      teamSlug: "team-a",
      problemId: "gcp-run",
      zipBytes,
    });
    expect(key).toMatch(/^tenkacloud\/tenant-1\/team-a\/gcp-run\/[0-9a-f]{64}\.zip$/);
  });

  it("should produce the same key for the same bytes (idempotency precondition)", () => {
    const zipBytes = buildDeterministicBlueprintZip([FILE_A, FILE_B]);
    const args = { tenantId: "t", teamSlug: "team", problemId: "p", zipBytes };
    expect(computeBlueprintObjectKey(args)).toBe(computeBlueprintObjectKey(args));
  });
});

describe("resolveGcpTerraformSource (#2745)", () => {
  it("should reject an absolute entry before any I/O", async () => {
    await expect(
      resolveGcpTerraformSource({ problemDir: "problems/x", entry: "/etc/passwd" }, {}),
    ).rejects.toThrow(/not a valid relative path/);
  });

  it("should reject a traversal entry before any I/O", async () => {
    await expect(
      resolveGcpTerraformSource({ problemDir: "problems/x", entry: "../../secrets" }, {}),
    ).rejects.toThrow(/not a valid relative path/);
  });

  it("should throw fail-closed when neither a payload URL nor S3 wiring is configured", async () => {
    await expect(
      resolveGcpTerraformSource({ problemDir: "problems/x", entry: "targets/gcp" }, {}),
    ).rejects.toThrow(/neither a private challengePayloadUrl nor a materialized source bucket/);
  });

  it("should prefer the private payload path when challengePayloadUrl is set", async () => {
    const fetchPayloadDirectory = vi.fn().mockResolvedValue([FILE_A]);
    const files = await resolveGcpTerraformSource(
      {
        problemDir: "problems/x",
        entry: "targets/gcp",
        challengePayloadUrl: "https://s3.example/presigned",
      },
      { fetchPayloadDirectory, s3: { send: vi.fn() }, sourceBucketName: "should-not-be-used" },
    );
    expect(files).toEqual([FILE_A]);
    expect(fetchPayloadDirectory).toHaveBeenCalledWith(
      "https://s3.example/presigned",
      "targets/gcp",
    );
  });

  it("should read every object under the materialized-tree directory listing", async () => {
    const send = vi
      .fn()
      .mockImplementation((cmd: { constructor: { name: string }; input?: unknown }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return Promise.resolve({
            Contents: [
              { Key: "problems/battles/four-corners/targets/gcp/main.tf" },
              { Key: "problems/battles/four-corners/targets/gcp/variables.tf" },
              { Key: "problems/battles/four-corners/targets/gcp/" }, // directory marker, must be skipped
            ],
          });
        }
        const key = (cmd.input as { Key: string }).Key;
        const body = key.endsWith("main.tf") ? FILE_A.bytes : FILE_B.bytes;
        return Promise.resolve({ Body: { transformToByteArray: async () => body } });
      });

    const files = await resolveGcpTerraformSource(
      { problemDir: "problems/battles/four-corners", entry: "targets/gcp" },
      { s3: { send }, sourceBucketName: "source-bucket" },
    );

    expect([...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))).toEqual([
      { relativePath: "main.tf", bytes: FILE_A.bytes },
      { relativePath: "variables.tf", bytes: FILE_B.bytes },
    ]);
  });

  it("should fall back to a single-object GetObject when nothing is listed under the directory", async () => {
    const send = vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [] });
      }
      return Promise.resolve({ Body: { transformToByteArray: async () => FILE_A.bytes } });
    });

    const files = await resolveGcpTerraformSource(
      { problemDir: "problems/challenges/gcp-single", entry: "main.tf" },
      { s3: { send }, sourceBucketName: "source-bucket" },
    );

    expect(files).toEqual([{ relativePath: "main.tf", bytes: FILE_A.bytes }]);
  });

  it("should fail loud (never a silently empty archive) when nothing is listed AND the fallback object is missing", async () => {
    const send = vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [] });
      }
      return Promise.reject(new Error("NoSuchKey"));
    });

    await expect(
      resolveGcpTerraformSource(
        { problemDir: "problems/challenges/gone", entry: "targets/gcp" },
        { s3: { send }, sourceBucketName: "source-bucket" },
      ),
    ).rejects.toThrow(/GCP Terraform source not found/);
  });
});

describe("materializeGcpBlueprint (#2745)", () => {
  function s3ReturningSingleFile(file: TerraformSourceFile) {
    return vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return Promise.resolve({ Contents: [] });
      }
      return Promise.resolve({ Body: { transformToByteArray: async () => file.bytes } });
    });
  }

  it("should throw an actionable diagnostic when artifactBucket is not registered", async () => {
    await expect(
      materializeGcpBlueprint(
        {
          tenantId: "tenant-1",
          teamSlug: "team-a",
          problemId: "gcp-run",
          source: { problemDir: "problems/x", entry: "main.tf" },
          accessToken: "tok",
          artifactBucket: undefined,
        },
        {},
      ),
    ).rejects.toThrow(/register artifactBucket in the team's GCP connection/);
  });

  it("should upload a new blueprint with the ifGenerationMatch=0 precondition and return gs://bucket/key#generation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ generation: "1700000000000001" }));
    const s3Send = s3ReturningSingleFile(FILE_A);

    const ref = await materializeGcpBlueprint(
      {
        tenantId: "tenant-1",
        teamSlug: "team-a",
        problemId: "gcp-run",
        source: { problemDir: "problems/x", entry: "main.tf" },
        accessToken: "wif-token",
        artifactBucket: "team-a-artifacts",
      },
      {
        s3: { send: s3Send },
        sourceBucketName: "source-bucket",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(ref).toMatch(
      /^gs:\/\/team-a-artifacts\/tenkacloud\/tenant-1\/team-a\/gcp-run\/[0-9a-f]{64}\.zip#1700000000000001$/,
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("https://storage.googleapis.com/upload/storage/v1/b/team-a-artifacts/o?");
    expect(url).toContain("uploadType=media");
    expect(url).toContain("ifGenerationMatch=0");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer wif-token");
    expect(init.headers["Content-Type"]).toBe("application/zip");
  });

  it("should reuse the existing object's generation on a 412 (content-addressed collision, idempotent)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("already exists", { status: 412 }))
      .mockResolvedValueOnce(jsonResponse({ generation: "42" }));
    const s3Send = s3ReturningSingleFile(FILE_A);

    const ref = await materializeGcpBlueprint(
      {
        tenantId: "tenant-1",
        teamSlug: "team-a",
        problemId: "gcp-run",
        source: { problemDir: "problems/x", entry: "main.tf" },
        accessToken: "wif-token",
        artifactBucket: "team-a-artifacts",
      },
      {
        s3: { send: s3Send },
        sourceBucketName: "source-bucket",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(ref).toMatch(/#42$/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // ref = gs://{bucket}/{objectKey}#{generation} — recover the exact object key the upload used.
    const objectKey = ref.slice("gs://team-a-artifacts/".length, ref.lastIndexOf("#"));
    const [getUrl, getInit] = fetchImpl.mock.calls[1];
    expect(getUrl).toBe(
      `https://storage.googleapis.com/storage/v1/b/team-a-artifacts/o/${encodeURIComponent(objectKey)}`,
    );
    expect(getInit.method).toBe("GET");
    expect(getInit.headers.Authorization).toBe("Bearer wif-token");
  });

  it("should throw loud on a non-2xx/non-412 upload response", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const s3Send = s3ReturningSingleFile(FILE_A);

    await expect(
      materializeGcpBlueprint(
        {
          tenantId: "t",
          teamSlug: "team",
          problemId: "p",
          source: { problemDir: "problems/x", entry: "main.tf" },
          accessToken: "tok",
          artifactBucket: "bucket",
        },
        {
          s3: { send: s3Send },
          sourceBucketName: "source-bucket",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/GCS blueprint upload failed: 500/);
  });

  it("should propagate a missing-artifact error without calling GCS at all (fail-closed, no upload attempt)", async () => {
    const fetchImpl = vi.fn();
    const s3Send = vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") return Promise.resolve({ Contents: [] });
      return Promise.reject(new Error("NoSuchKey"));
    });

    await expect(
      materializeGcpBlueprint(
        {
          tenantId: "t",
          teamSlug: "team",
          problemId: "p",
          source: { problemDir: "problems/x", entry: "main.tf" },
          accessToken: "tok",
          artifactBucket: "bucket",
        },
        {
          s3: { send: s3Send },
          sourceBucketName: "source-bucket",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/GCP Terraform source not found/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should throw when the GCS reuse GET (412 branch) itself fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("conflict", { status: 412 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const s3Send = s3ReturningSingleFile(FILE_A);

    await expect(
      materializeGcpBlueprint(
        {
          tenantId: "t",
          teamSlug: "team",
          problemId: "p",
          source: { problemDir: "problems/x", entry: "main.tf" },
          accessToken: "tok",
          artifactBucket: "bucket",
        },
        {
          s3: { send: s3Send },
          sourceBucketName: "source-bucket",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/GCS blueprint reuse GET failed: 403/);
  });

  it("should throw when the upload response is missing 'generation'", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    const s3Send = s3ReturningSingleFile(FILE_A);

    await expect(
      materializeGcpBlueprint(
        {
          tenantId: "t",
          teamSlug: "team",
          problemId: "p",
          source: { problemDir: "problems/x", entry: "main.tf" },
          accessToken: "tok",
          artifactBucket: "bucket",
        },
        {
          s3: { send: s3Send },
          sourceBucketName: "source-bucket",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/missing 'generation'/);
  });
});
