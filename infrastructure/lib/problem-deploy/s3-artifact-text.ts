/**
 * [Issue #2291 / #2743] Shared "read one S3 object as UTF-8 text" primitive.
 *
 * Extracted so `handlers/cfn-deploy-handler/create-stack.ts` (the public-problem `template.yaml` /
 * `metadata.json` reader, #2291) and `handlers/deploy-handler/adapter-dependencies.ts` (the
 * public-problem Azure ARM template reader, #2743) share ONE implementation instead of two copies
 * drifting apart (`make dup-check`, #2743). Both call sites already import `@aws-sdk/client-s3`
 * directly, so this adds no new dependency and no new IAM surface — only the read primitive moves.
 */

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

/** Read `key` out of `bucket` and decode it as UTF-8 text. Fails loud on an empty/unreadable body. */
export async function getS3ObjectText(
  s3: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body;
  if (!body || typeof (body as { transformToString?: unknown }).transformToString !== "function") {
    throw new Error(`empty or unreadable S3 object: s3://${bucket}/${key}`);
  }
  return (body as { transformToString: () => Promise<string> }).transformToString();
}
