import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * ADR-008 Phase 3 (Issue #642): private 問題用の短命 (15 分 TTL) S3 presigned URL を発行する。
 *
 * Object key 規約 (= TenkaCloudChallenges/.github/workflows/publish.yml に対応):
 *   `<problemId>/latest.zip`  (= 最新版を引く、 競技中の版数固定が要るなら git SHA に差し替え)
 *
 * TTL は 15 分。 CodeBuild が deploy 開始から zip download 完了までに 15 分以上かかるなら
 * TTL を延ばすが、 deploy-battles.sh の curl は 60 秒 timeout なので余裕がある。
 *
 * S3 client は cold start 1 回のみ build される想定 (= module scope で hoist)。
 * テストでは DI で client を差し替える。
 */
export interface PresignedUrlOptions {
  readonly s3: S3Client;
  readonly bucketName: string;
  readonly problemId: string;
  /** TTL 秒。 default 900 (= 15 分)。 短すぎると CodeBuild start delay で expire する。 */
  readonly expiresInSeconds?: number;
  /** Object key override (= 競技中の版数固定用に git SHA を渡す等)。 default は `latest.zip`。 */
  readonly objectKey?: string;
}

const DEFAULT_TTL_SECONDS = 900;

export async function generateChallengePayloadUrl(opts: PresignedUrlOptions): Promise<string> {
  const key = opts.objectKey ?? `${opts.problemId}/latest.zip`;
  const command = new GetObjectCommand({
    Bucket: opts.bucketName,
    Key: key,
  });
  return getSignedUrl(opts.s3, command, {
    expiresIn: opts.expiresInSeconds ?? DEFAULT_TTL_SECONDS,
  });
}
