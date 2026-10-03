import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * private 問題の短命 presigned URL を発行する。
 * default object key は `<problemId>/latest.zip`、 default TTL は 15 分。
 */
export interface PresignedUrlOptions {
  readonly s3: S3Client;
  readonly bucketName: string;
  readonly problemId: string;
  readonly expiresInSeconds?: number;
  readonly objectKey?: string;
}

const DEFAULT_TTL_SECONDS = 900;

export async function generateChallengePayloadUrl(opts: PresignedUrlOptions): Promise<string> {
  const key = opts.objectKey ?? `${opts.problemId}/latest.zip`;
  const command = new GetObjectCommand({ Bucket: opts.bucketName, Key: key });
  return getSignedUrl(opts.s3, command, {
    expiresIn: opts.expiresInSeconds ?? DEFAULT_TTL_SECONDS,
  });
}
