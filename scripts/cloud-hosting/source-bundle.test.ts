import { describe, expect, it } from "bun:test";
import type { ProcessRequest, ProcessResult } from "./process";
import { prepareCloudSourceBundle } from "./source-bundle";

const key = "staging/source.zip.executions/00000000-0000-4000-8000-000000000000.zip";
const etag = "abcdefabcdefabcdefabcdefabcdefab";
const receipt = `SOURCE_UPLOAD_KEY=${key}\nSOURCE_UPLOAD_ETAG="${etag}"\nSOURCE_UPLOAD_VERSION_ID=version-A\n`;
function fixture(
  options: {
    resolution?: string;
    prepareFails?: boolean;
    receipt?: string;
    verified?: unknown;
  } = {},
) {
  const calls: ProcessRequest[] = [];
  const context = {
    root: "/fixture/root with spaces",
    env: {
      ACCOUNT_ID: "123456789012",
      REGION: "ap-northeast-1",
      ENV: "staging",
      AWS_PROFILE: "selected",
      PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY: "1",
      CDK_PARAM_COMMIT_ID: "stale",
      CDK_SOURCE_VERSION_ID: "stale-version",
    },
  };
  const io = {
    run: async (request: ProcessRequest): Promise<ProcessResult> => {
      calls.push(request);
      if (request.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY === "1")
        return {
          code: 0,
          stderr: "",
          stdout:
            options.resolution ??
            "CDK_PARAM_S3_BUCKET_NAME=tenkacloud-source-owned\nCDK_SOURCE_NAME=staging/source.zip\n",
        };
      if (request.command === "bash")
        return {
          code: options.prepareFails ? 9 : 0,
          stderr: options.prepareFails ? "local build failed" : "",
          stdout: options.receipt ?? receipt,
        };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(options.verified ?? { ETag: `"${etag}"`, VersionId: "version-A" }),
      };
    },
  };
  return { calls, context, io };
}
describe("CodeBuild source bundle command wiring", () => {
  it("uses the version from the upload receipt even when another upload could replace latest", async () => {
    const f = fixture();
    const env = await prepareCloudSourceBundle(f.context, f.io);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1]?.env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY).toBeUndefined();
    expect(f.calls[1]?.inherit).toBe(true);
    expect(f.calls[1]?.captureOutput).toBe(true);
    expect(f.calls[2]?.args).toEqual([
      "s3api",
      "head-object",
      "--bucket",
      "tenkacloud-source-owned",
      "--key",
      key,
      "--version-id",
      "version-A",
      "--expected-bucket-owner",
      "123456789012",
      "--region",
      "ap-northeast-1",
      "--query",
      "{ETag:ETag,VersionId:VersionId}",
      "--output",
      "json",
    ]);
    expect(
      f.calls.every((call) => call.cwd === f.context.root && call.env.AWS_PROFILE === "selected"),
    ).toBe(true);
    expect(env.CDK_PARAM_COMMIT_ID).toBe(etag);
    expect(env.CDK_SOURCE_VERSION_ID).toBe("version-A");
    expect(env.CDK_SOURCE_NAME).toBe(key);
    expect(f.context.env.CDK_PARAM_COMMIT_ID).toBe("stale");
  });
  it.each([
    "",
    "CDK_PARAM_S3_BUCKET_NAME=owned\n",
    "CDK_PARAM_S3_BUCKET_NAME=owned\nCDK_PARAM_S3_BUCKET_NAME=other\nCDK_SOURCE_NAME=source.zip",
    "CDK_PARAM_S3_BUCKET_NAME=owned..bucket\nCDK_SOURCE_NAME=source.zip",
    "CDK_PARAM_S3_BUCKET_NAME=owned\nCDK_SOURCE_NAME=../source.zip",
  ])("rejects missing or unsafe resolution before upload: %s", async (resolution) => {
    const f = fixture({ resolution });
    await expect(prepareCloudSourceBundle(f.context, f.io)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it("does not verify or proceed after source preparation fails", async () => {
    const f = fixture({ prepareFails: true });
    await expect(prepareCloudSourceBundle(f.context, f.io)).rejects.toThrow("local build failed");
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    "",
    `${receipt}SOURCE_UPLOAD_VERSION_ID=version-B\n`,
    receipt.replace("version-A", "null"),
    receipt.replace("version-A", "None"),
    receipt.replace(key, "source.zip"),
    receipt.replace(etag, "bad-etag"),
    receipt.replace(key, "other/source.zip.executions/00000000-0000-4000-8000-000000000000.zip"),
  ])("rejects a missing, mutable or ambiguous upload receipt", async (value) => {
    const f = fixture({ receipt: value });
    await expect(prepareCloudSourceBundle(f.context, f.io)).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    {},
    { ETag: `"${etag}"`, VersionId: "version-B" },
    { ETag: "different", VersionId: "version-A" },
  ])("rejects an object that disagrees with the exact uploaded version", async (verified) => {
    const f = fixture({ verified });
    await expect(prepareCloudSourceBundle(f.context, f.io)).rejects.toThrow("does not match");
  });
});
