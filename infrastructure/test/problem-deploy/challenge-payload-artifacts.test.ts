import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchChallengePayloadArtifacts,
  fetchChallengePayloadDirectory,
  fetchChallengePayloadEntry,
  MAX_PAYLOAD_BYTES,
} from "../../lib/problem-deploy/challenge-payload-artifacts.js";

/**
 * Issue #2291 (#642): private-problem payload fetch on the Lambda deploy path.
 *
 * The module HTTP-GETs a presigned S3 URL and unzips `payload.zip` in memory, returning the
 * problem's `template.yaml` + `metadata.json`. Tests inject a fake `httpGet` (no real network) and,
 * for the default `fetch` primitive, stub the global `fetch`. All the security bounds (compressed
 * size, decompressed size, entry count, non-2xx, missing template) are pinned as fail-loud paths.
 */

/** Build a real zip for the fake httpGet (mirrors what our own publisher would produce). */
function payloadZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = strToU8(body);
  return zipSync(entries);
}

const TEMPLATE = "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n";
const METADATA = JSON.stringify({ cfnParameters: { FlagSeed: "seed-value" } });

describe("fetchChallengePayloadArtifacts (#2291)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("should fetch + unzip a private payload and return template + metadata", async () => {
    const zip = payloadZip({
      "challenges/sample-flag/template.yaml": TEMPLATE,
      "challenges/sample-flag/metadata.json": METADATA,
    });
    const httpGet = vi.fn(async () => zip);

    const out = await fetchChallengePayloadArtifacts("https://s3.example/presigned", { httpGet });

    expect(httpGet).toHaveBeenCalledWith("https://s3.example/presigned");
    expect(out.templateBody).toBe(TEMPLATE);
    expect(out.metadataText).toBe(METADATA);
  });

  it("should resolve a template.yaml at the zip root (no directory prefix)", async () => {
    const zip = payloadZip({ "template.yaml": TEMPLATE, "metadata.json": METADATA });
    const out = await fetchChallengePayloadArtifacts("https://s3.example/p", {
      httpGet: async () => zip,
    });
    expect(out.templateBody).toBe(TEMPLATE);
    expect(out.metadataText).toBe(METADATA);
  });

  it("should throw when template.yaml is absent from the payload", async () => {
    const zip = payloadZip({ "challenges/sample-flag/metadata.json": METADATA });
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", { httpGet: async () => zip }),
    ).rejects.toThrow(/does not contain a template\.yaml/);
  });

  it("should throw when the sibling metadata.json is missing beside template.yaml", async () => {
    const zip = payloadZip({ "challenges/sample-flag/template.yaml": TEMPLATE });
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", { httpGet: async () => zip }),
    ).rejects.toThrow(/missing challenges\/sample-flag\/metadata\.json/);
  });

  it("should reject an oversized payload before unzip (zip-bomb blast-radius cap)", async () => {
    // Injected fetcher returns more bytes than the (test-lowered) cap → rejected before unzip.
    const httpGet = vi.fn(async () => new Uint8Array(11));
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", { httpGet, maxPayloadBytes: 10 }),
    ).rejects.toThrow(/exceeding the 10-byte cap/);
  });

  it("should reject a payload with too many (target) entries", async () => {
    // Only target entries are inflated, so trip the count cap with multiple template/metadata pairs.
    const zip = payloadZip({
      "a/template.yaml": TEMPLATE,
      "a/metadata.json": METADATA,
      "b/template.yaml": TEMPLATE,
      "b/metadata.json": METADATA,
    });
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", {
        httpGet: async () => zip,
        maxEntryCount: 2,
      }),
    ).rejects.toThrow(/exceeding the 2 cap/);
  });

  it("should skip a non-target entry (a bomb hidden beside the two files never inflates)", async () => {
    // A large non-target entry: the `filter` excludes it, so it is never decompressed and does not
    // count toward the entry cap. Extraction of the two target files still succeeds.
    const zip = payloadZip({
      "p/template.yaml": TEMPLATE,
      "p/metadata.json": METADATA,
      "p/huge.bin": "z".repeat(50_000),
    });
    const out = await fetchChallengePayloadArtifacts("https://s3.example/p", {
      httpGet: async () => zip,
      maxEntryCount: 2,
    });
    expect(out.templateBody).toBe(TEMPLATE);
    expect(out.metadataText).toBe(METADATA);
  });

  it("should reject a target entry whose declared size exceeds the per-entry cap (pre-inflation)", async () => {
    // template.yaml is bigger than the (test-lowered) per-entry cap → the filter drops it BEFORE
    // decompression, so it is treated as absent (fail loud).
    const zip = payloadZip({
      "p/template.yaml": "x".repeat(4096),
      "p/metadata.json": METADATA,
    });
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", {
        httpGet: async () => zip,
        maxEntryBytes: 1024,
      }),
    ).rejects.toThrow(/does not contain a template\.yaml/);
  });

  it("should reject a payload whose decompressed size exceeds the cap", async () => {
    const zip = payloadZip({
      "a/template.yaml": TEMPLATE,
      "a/metadata.json": METADATA,
    });
    await expect(
      fetchChallengePayloadArtifacts("https://s3.example/p", {
        httpGet: async () => zip,
        maxDecompressedBytes: 1,
      }),
    ).rejects.toThrow(/decompressed size exceeds the 1-byte cap/);
  });

  it("should GET the presigned URL via the default fetch primitive and return the artifacts", async () => {
    const zip = payloadZip({
      "challenges/x/template.yaml": TEMPLATE,
      "challenges/x/metadata.json": METADATA,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(zip.byteLength) },
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchChallengePayloadArtifacts("https://s3.example/presigned");

    // Plain GET, redirect refused (SSRF-via-redirect hardening).
    expect(fetchMock).toHaveBeenCalledWith(
      "https://s3.example/presigned",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(out.templateBody).toBe(TEMPLATE);
    expect(out.metadataText).toBe(METADATA);
  });

  it("should reject a non-2xx response (fail loud, never an empty payload)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchChallengePayloadArtifacts("https://s3.example/expired")).rejects.toThrow(
      /HTTP status 403/,
    );
  });

  it("should reject a Content-Length over the cap before downloading the body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_PAYLOAD_BYTES + 1) },
      arrayBuffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchChallengePayloadArtifacts("https://s3.example/huge")).rejects.toThrow(
      /Content-Length .* exceeds the/,
    );
    // Body was never read (rejected on the declared length first).
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

/**
 * [Issue #2745] `fetchChallengePayloadDirectory` extends the same bounded fetch + unzip primitive
 * to pull a DIRECTORY of files out of a private payload (a GCP Terraform root module, unlike the
 * two fixed filenames above).
 */
describe("fetchChallengePayloadDirectory (#2745)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MAIN_TF = 'resource "google_storage_bucket" "x" {}';
  const VARS_TF = 'variable "y" {}';

  it("should return every file under the declared directory, sorted by relative path", async () => {
    const zip = payloadZip({
      "targets/gcp/main.tf": MAIN_TF,
      "targets/gcp/variables.tf": VARS_TF,
    });
    const files = await fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
      httpGet: async () => zip,
    });
    expect(files.map((f) => f.relativePath)).toEqual(["main.tf", "variables.tf"]);
    expect(new TextDecoder().decode(files[0].bytes)).toBe(MAIN_TF);
  });

  it("should match a directory nested under an unknown organizer root folder (any depth)", async () => {
    const zip = payloadZip({ "four-corners/targets/gcp/main.tf": MAIN_TF });
    const files = await fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
      httpGet: async () => zip,
    });
    expect(files).toEqual([{ relativePath: "main.tf", bytes: strToU8(MAIN_TF) }]);
  });

  it("should not match a sibling directory that merely shares the entry's prefix", async () => {
    // "targets/gcp-old" must never satisfy an entry of "targets/gcp".
    const zip = payloadZip({ "targets/gcp-old/main.tf": MAIN_TF });
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
        httpGet: async () => zip,
      }),
    ).rejects.toThrow(/does not contain any file under 'targets\/gcp\/'/);
  });

  it("should reject an absolute, traversal, or empty directory entry before any I/O", async () => {
    const httpGet = vi.fn();
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "/etc/passwd", { httpGet }),
    ).rejects.toThrow(/not a valid relative path/);
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "../secrets", { httpGet }),
    ).rejects.toThrow(/not a valid relative path/);
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "", { httpGet }),
    ).rejects.toThrow(/not a valid relative path/);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("should throw when the directory has no matching files (fail loud, never an empty archive)", async () => {
    const zip = payloadZip({ "targets/azure/main.bicep": "resource x {}" });
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
        httpGet: async () => zip,
      }),
    ).rejects.toThrow(/does not contain any file under 'targets\/gcp\/'/);
  });

  it("should skip directory marker entries (zero-length names ending in '/')", async () => {
    // zipSync from fflate does not itself emit directory markers for flat data, so build the zip
    // by hand with an explicit empty directory entry alongside a real file.
    const zip = zipSync({
      "targets/gcp/": new Uint8Array(0),
      "targets/gcp/main.tf": strToU8(MAIN_TF),
    });
    const files = await fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
      httpGet: async () => zip,
    });
    expect(files).toEqual([{ relativePath: "main.tf", bytes: strToU8(MAIN_TF) }]);
  });

  it("should reject an oversized payload before unzip (shares the same cap as fetchChallengePayloadArtifacts)", async () => {
    const httpGet = vi.fn(async () => new Uint8Array(11));
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
        httpGet,
        maxPayloadBytes: 10,
      }),
    ).rejects.toThrow(/exceeding the 10-byte cap/);
  });

  it("should reject too many matched entries under the directory", async () => {
    const zip = payloadZip({
      "targets/gcp/a.tf": MAIN_TF,
      "targets/gcp/b.tf": VARS_TF,
      "targets/gcp/c.tf": MAIN_TF,
    });
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
        httpGet: async () => zip,
        maxEntryCount: 2,
      }),
    ).rejects.toThrow(/exceeding the 2 cap/);
  });

  it("should reject a directory whose decompressed size exceeds the cap", async () => {
    const zip = payloadZip({ "targets/gcp/main.tf": MAIN_TF });
    await expect(
      fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
        httpGet: async () => zip,
        maxDecompressedBytes: 1,
      }),
    ).rejects.toThrow(/decompressed size exceeds the 1-byte cap/);
  });

  it("should drop (never inflate) an entry whose declared size exceeds the per-entry cap", async () => {
    const zip = payloadZip({
      "targets/gcp/main.tf": "x".repeat(4096),
      "targets/gcp/small.tf": VARS_TF,
    });
    const files = await fetchChallengePayloadDirectory("https://s3.example/p", "targets/gcp", {
      httpGet: async () => zip,
      maxEntryBytes: 1024,
    });
    // main.tf was dropped pre-inflation (over cap); small.tf still comes through.
    expect(files).toEqual([{ relativePath: "small.tf", bytes: strToU8(VARS_TF) }]);
  });
});

/**
 * [Issue #2743] `fetchChallengePayloadEntry` extends the same bounded fetch + unzip primitive to
 * pull exactly ONE author-chosen named entry out of a private payload (an Azure ARM/Bicep target,
 * unlike the two fixed filenames or the whole-directory reads above).
 */
describe("fetchChallengePayloadEntry (#2743)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ARM_JSON = JSON.stringify({ $schema: "s", resources: [] });

  it("should fetch + unzip a private payload and return the one named entry", async () => {
    const zip = payloadZip({ "targets/azure.json": ARM_JSON, "targets/gcp/main.tf": "unrelated" });
    const httpGet = vi.fn(async () => zip);

    const out = await fetchChallengePayloadEntry("https://s3.example/presigned", "azure.json", {
      httpGet,
    });

    expect(httpGet).toHaveBeenCalledWith("https://s3.example/presigned");
    expect(out).toBe(ARM_JSON);
  });

  it("should resolve an entry at the zip root (no directory prefix)", async () => {
    const zip = payloadZip({ "azure.json": ARM_JSON });
    const out = await fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
      httpGet: async () => zip,
    });
    expect(out).toBe(ARM_JSON);
  });

  it("should throw when the named entry is absent from the payload", async () => {
    const zip = payloadZip({ "targets/gcp/main.tf": "unrelated" });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
      }),
    ).rejects.toThrow(/does not contain a 'azure\.json' entry/);
  });

  it("should reject an ambiguous match — both a root and a nested entry with the same name — instead of silently picking one", async () => {
    const zip = payloadZip({ "azure.json": ARM_JSON, "targets/azure.json": ARM_JSON });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
      }),
    ).rejects.toThrow(/2 entries matching 'azure\.json'.*must be unambiguous/);
  });

  it("should reject an ambiguous match under a generous default maxEntryCount (independent of the cap)", async () => {
    const zip = payloadZip({ "a/azure.json": ARM_JSON, "b/azure.json": ARM_JSON });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
      }),
    ).rejects.toThrow(/2 entries matching 'azure\.json'.*must be unambiguous/);
  });

  it("should reject an oversized payload before unzip", async () => {
    const httpGet = vi.fn(async () => new Uint8Array(11));
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet,
        maxPayloadBytes: 10,
      }),
    ).rejects.toThrow(/exceeding the 10-byte cap/);
  });

  it("should reject a matched entry whose declared size exceeds the per-entry cap (pre-inflation)", async () => {
    const zip = payloadZip({ "azure.json": "x".repeat(4096) });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
        maxEntryBytes: 1024,
      }),
    ).rejects.toThrow(/does not contain a 'azure\.json' entry/);
  });

  it("should reject when more matching entries exist than the cap allows", async () => {
    const zip = payloadZip({ "a/azure.json": ARM_JSON, "b/azure.json": ARM_JSON });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
        maxEntryCount: 1,
      }),
    ).rejects.toThrow(/exceeding the 1 cap/);
  });

  it("should reject a payload whose decompressed size exceeds the cap", async () => {
    const zip = payloadZip({ "azure.json": ARM_JSON });
    await expect(
      fetchChallengePayloadEntry("https://s3.example/p", "azure.json", {
        httpGet: async () => zip,
        maxDecompressedBytes: 1,
      }),
    ).rejects.toThrow(/decompressed size exceeds the 1-byte cap/);
  });

  it("should GET the presigned URL via the default fetch primitive and return the entry", async () => {
    const zip = payloadZip({ "azure.json": ARM_JSON });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(zip.byteLength) },
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchChallengePayloadEntry("https://s3.example/presigned", "azure.json");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://s3.example/presigned",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(out).toBe(ARM_JSON);
  });

  it("should reject a non-2xx response (fail loud, never an empty payload)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchChallengePayloadEntry("https://s3.example/expired", "azure.json"),
    ).rejects.toThrow(/HTTP status 403/);
  });

  it("should reject a Content-Length over the cap before downloading the body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_PAYLOAD_BYTES + 1) },
      arrayBuffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchChallengePayloadEntry("https://s3.example/huge", "azure.json"),
    ).rejects.toThrow(/Content-Length .* exceeds the/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
