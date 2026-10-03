import type { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: private 問題 presigned URL 発行 (deploy-handler/presigned-url.ts) は
 * 0% branch だった。 default key / TTL と明示指定の両 branch を pin する。 S3 presigner は
 * mock して network を踏ませない。
 */
const mocks = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));

const { generateChallengePayloadUrl } = await import(
  "../../lib/problem-deploy/handlers/deploy-handler/presigned-url"
);

const s3 = {} as S3Client;
afterEach(() => vi.clearAllMocks());

describe("generateChallengePayloadUrl", () => {
  it("should sign the default <problemId>/latest.zip key with the 900s default TTL", async () => {
    mocks.getSignedUrl.mockResolvedValueOnce("https://signed-default");
    const url = await generateChallengePayloadUrl({ s3, bucketName: "payloads", problemId: "p1" });
    expect(url).toBe("https://signed-default");
    const [, command, options] = mocks.getSignedUrl.mock.calls[0];
    expect(command.input).toEqual({ Bucket: "payloads", Key: "p1/latest.zip" });
    expect(options).toEqual({ expiresIn: 900 });
  });

  it("should honor an explicit objectKey and expiresInSeconds", async () => {
    mocks.getSignedUrl.mockResolvedValueOnce("https://signed-custom");
    await generateChallengePayloadUrl({
      s3,
      bucketName: "payloads",
      problemId: "p1",
      objectKey: "p1/v2.zip",
      expiresInSeconds: 60,
    });
    const [, command, options] = mocks.getSignedUrl.mock.calls[0];
    expect(command.input.Key).toBe("p1/v2.zip");
    expect(options).toEqual({ expiresIn: 60 });
  });
});
