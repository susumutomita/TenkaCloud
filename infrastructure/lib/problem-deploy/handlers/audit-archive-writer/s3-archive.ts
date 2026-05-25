import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Issue #1341 (#1335 Phase 3): audit-archive-writer の S3 SDK adapter (= service / repository
 * 層を index.ts (= handler routing) から分離するための薄い wrapper)。 handler-no-direct-sdk-import
 * 整流のため、 `index.ts` は本 module 経由でしか S3 を触らない。
 */

export interface S3ArchiveClient {
  putObject(args: {
    bucket: string;
    key: string;
    body: string;
    contentType: string;
  }): Promise<void>;
}

const defaultS3 = new S3Client({});

export function buildDefaultS3ArchiveClient(): S3ArchiveClient {
  return {
    async putObject(args) {
      await defaultS3.send(
        new PutObjectCommand({
          Bucket: args.bucket,
          Key: args.key,
          Body: args.body,
          ContentType: args.contentType,
        }),
      );
    },
  };
}
