import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchChallengePayloadArtifacts,
  MAX_PAYLOAD_BYTES,
} from "../../lib/problem-deploy/challenge-payload-artifacts.js";

/**
 * Issue #2291 (ADR-008 Phase 3 / #642): private-problem payload fetch on the Lambda deploy path.
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
