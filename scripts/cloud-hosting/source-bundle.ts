import type { CloudCliIo, ProcessResult } from "./process";

function assertSuccess(result: ProcessResult, phase: string): void {
  if (result.code !== 0)
    throw new Error(`${phase} failed (exit ${result.code}). ${result.stderr.trim()}`);
}
function resolvedValue(text: string, key: string): string {
  const values = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
  if (values.length !== 1 || !values[0])
    throw new Error(`Source preparation did not resolve exactly one ${key}.`);
  return values[0];
}
/** Use the same shell resolver for source upload and the CDK CodeBuild source. */
export async function prepareCloudSourceBundle(
  context: { readonly root: string; readonly env: NodeJS.ProcessEnv },
  io: Pick<CloudCliIo, "run">,
): Promise<NodeJS.ProcessEnv> {
  const request = {
    command: "bash",
    args: ["scripts/prepare-source-bundle.sh"],
    cwd: context.root,
  };
  const resolution = await io.run({
    ...request,
    env: { ...context.env, PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY: "1" },
  });
  assertSuccess(resolution, "Resolve source bundle");
  const bucket = resolvedValue(resolution.stdout, "CDK_PARAM_S3_BUCKET_NAME");
  const key = resolvedValue(resolution.stdout, "CDK_SOURCE_NAME");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
    bucket.includes("..") ||
    key.length > 972 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u.test(key) ||
    key.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error(
      "Source bucket or source archive name is invalid; no source preparation was started.",
    );
  const env: NodeJS.ProcessEnv = {
    ...context.env,
    CDK_PARAM_S3_BUCKET_NAME: bucket,
    CDK_SOURCE_NAME: key,
    SOURCE_BUNDLE_PIN_EXECUTION: "1",
  };
  delete env.PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY;
  const prepared = await io.run({ ...request, env, inherit: true, captureOutput: true });
  assertSuccess(prepared, "Prepare source bundle");
  const uploadedKey = resolvedValue(prepared.stdout, "SOURCE_UPLOAD_KEY");
  const uploadedEtag = resolvedValue(prepared.stdout, "SOURCE_UPLOAD_ETAG").replaceAll('"', "");
  const versionId = resolvedValue(prepared.stdout, "SOURCE_UPLOAD_VERSION_ID");
  if (
    !uploadedKey.startsWith(`${key}.executions/`) ||
    !/^[a-f0-9-]{36}\.zip$/u.test(uploadedKey.slice(`${key}.executions/`.length)) ||
    !/^[a-fA-F0-9]{32}(?:-\d+)?$/u.test(uploadedEtag) ||
    versionId === "null" ||
    versionId === "None" ||
    versionId.length > 1024 ||
    Array.from(versionId).some(
      (character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126,
    )
  )
    throw new Error("Source preparation returned an invalid immutable upload receipt.");
  const object = await io.run({
    command: "aws",
    args: [
      "s3api",
      "head-object",
      "--bucket",
      bucket,
      "--key",
      uploadedKey,
      "--version-id",
      versionId,
      "--expected-bucket-owner",
      env.ACCOUNT_ID ?? "",
      "--region",
      env.REGION ?? "",
      "--query",
      "{ETag:ETag,VersionId:VersionId}",
      "--output",
      "json",
    ],
    cwd: context.root,
    env,
  });
  assertSuccess(object, "Verify uploaded source bundle");
  const receipt: unknown = JSON.parse(object.stdout);
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("ETag" in receipt) ||
    typeof receipt.ETag !== "string" ||
    receipt.ETag.replaceAll('"', "") !== uploadedEtag ||
    !("VersionId" in receipt) ||
    receipt.VersionId !== versionId
  )
    throw new Error(
      "Uploaded source version does not match its upload receipt; deployment stopped.",
    );
  return {
    ...env,
    CDK_SOURCE_NAME: uploadedKey,
    CDK_SOURCE_VERSION_ID: versionId,
    CDK_PARAM_COMMIT_ID: uploadedEtag,
  };
}
