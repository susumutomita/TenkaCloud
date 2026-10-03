/**
 * Cross-account AssumeRole into the competitor's `CompetitorDeployRole`, shared across handlers.
 *
 * 以前は describe-stack-handler が自前で持ち、 verify.ts / participant SSO も類似ロジックを別個に
 * 抱えていた (= rotation-race retry / ExternalId mismatch fallback の error name 集合がコメントで
 * 「同じものを共有」 と書かれつつ実体は重複していた)。 ここに 1 本化して **単一の監査点** にする
 * (= 資格情報経路の重複は security リスク。 #856 / #1245 で hardening した retry を 1 箇所に集約)。
 *
 * caller 固有の cosmetic だけを param 化する (= 振る舞いは不変):
 *   - `sessionNamePrefix`: RoleSessionName の prefix (例: describe-stack / disruption-executor)
 *   - `graceFallbackTraceEvent`: grace-fallback 成功時に発火する trace event 名 (operator alarm が key にする)
 *
 * Issue #1245 + #856 の方針はそのまま:
 *   - ExternalId は SSM SecureString から都度 decrypt (= コードに埋め込まない)
 *   - AssumeRole 失敗のうち AccessDenied 系 (= ExternalId mismatch) だけ 1 generation 前で 1 度 retry
 *   - Network / Throttling / 5xx は retry せず即 rethrow (= blanket fallback band-aid を避ける)
 *   - grace-fallback 成功は errorDeployTrace で発火し operator alarm に拾わせる
 *   - retry でも ExternalId は必ず渡す (= 「ExternalId 無し AssumeRole」 は禁止)
 */

import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { AssumeRoleCommand, type Credentials, type STSClient } from "@aws-sdk/client-sts";
import { errorDeployTrace } from "./trace-log.js";

export interface AssumeCompetitorRoleDeps {
  readonly ssm: Pick<SSMClient, "send">;
  readonly sts: Pick<STSClient, "send">;
}

export interface AssumeCompetitorRoleParams {
  readonly region: string;
  readonly jobId: string;
  readonly competitorRoleArn?: string;
  readonly externalIdParameterName?: string;
  /** RoleSessionName prefix (caller 識別)。 例: "tenkacloud-describe-stack-" / "tc-disruption-"。 */
  readonly sessionNamePrefix: string;
  /** grace-fallback 成功時の trace event 名 (= operator alarm の key)。 */
  readonly graceFallbackTraceEvent: string;
}

const ASSUME_ROLE_FALLBACK_ERROR_NAMES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "Forbidden",
]);

/** AccessDenied 系 (= ExternalId mismatch) のみ 1 generation 前での retry 対象。 */
export function shouldRetryWithPreviousExternalIdVersion(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return ASSUME_ROLE_FALLBACK_ERROR_NAMES.has(name);
}

function assertCompleteCredentials(credentials: Credentials | undefined): Credentials {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("AssumeRole returned incomplete credentials");
  }
  return credentials;
}

async function assumeRoleWithExternalId(
  deps: AssumeCompetitorRoleDeps,
  args: {
    readonly roleArn: string;
    readonly jobId: string;
    readonly externalId: string;
    readonly sessionNamePrefix: string;
  },
): Promise<Credentials> {
  const assumeOut = await deps.sts.send(
    new AssumeRoleCommand({
      RoleArn: args.roleArn,
      RoleSessionName: `${args.sessionNamePrefix}${args.jobId.slice(0, 24)}`,
      ExternalId: args.externalId,
      DurationSeconds: 900,
    }),
  );
  return assertCompleteCredentials(assumeOut.Credentials);
}

async function retryWithPreviousExternalId(
  deps: AssumeCompetitorRoleDeps,
  args: {
    readonly region: string;
    readonly jobId: string;
    readonly competitorRoleArn: string;
    readonly externalIdParameterName: string;
    readonly currentVersion: number;
    readonly currentErr: unknown;
    readonly sessionNamePrefix: string;
    readonly graceFallbackTraceEvent: string;
  },
): Promise<Credentials> {
  const { currentErr } = args;
  if (!shouldRetryWithPreviousExternalIdVersion(currentErr)) throw currentErr;
  const previousVersion = args.currentVersion - 1;
  if (previousVersion <= 0) throw currentErr;
  const previousExternalIdOut = await deps.ssm.send(
    new GetParameterCommand({
      Name: `${args.externalIdParameterName}:${previousVersion}`,
      WithDecryption: true,
    }),
  );
  const previousExternalId = previousExternalIdOut.Parameter?.Value;
  if (!previousExternalId) throw currentErr;
  const credentials = await assumeRoleWithExternalId(deps, {
    roleArn: args.competitorRoleArn,
    jobId: args.jobId,
    externalId: previousExternalId,
    sessionNamePrefix: args.sessionNamePrefix,
  });
  errorDeployTrace(args.graceFallbackTraceEvent, {
    jobId: args.jobId,
    correlationId: args.jobId,
    region: args.region,
    externalIdVersion: previousVersion,
    reason: currentErr instanceof Error ? currentErr.name : "Unknown",
  });
  return credentials;
}

/**
 * competitor account の `CompetitorDeployRole` を ExternalId 付きで AssumeRole する。
 * competitorRoleArn / externalIdParameterName の双方が無ければ undefined (= same-account 経路)、
 * 片方だけは config error。 ExternalId mismatch (rotation race) は 1 generation 前で 1 度 retry。
 */
export async function assumeCompetitorRole(
  deps: AssumeCompetitorRoleDeps,
  params: AssumeCompetitorRoleParams,
): Promise<Credentials | undefined> {
  const hasRole =
    typeof params.competitorRoleArn === "string" && params.competitorRoleArn.length > 0;
  const hasExternalId =
    typeof params.externalIdParameterName === "string" && params.externalIdParameterName.length > 0;
  if (!hasRole && !hasExternalId) return undefined;
  if (!hasRole || !hasExternalId) {
    throw new Error("competitorRoleArn and externalIdParameterName must be provided together");
  }
  // 上の 2 guard で competitorRoleArn / externalIdParameterName が string であることは確定。
  const competitorRoleArn = params.competitorRoleArn as string;
  const externalIdParameterName = params.externalIdParameterName as string;

  const externalIdOut = await deps.ssm.send(
    new GetParameterCommand({ Name: externalIdParameterName, WithDecryption: true }),
  );
  const externalId = externalIdOut.Parameter?.Value;
  if (!externalId) {
    throw new Error(`ExternalId not found in SSM SecureString: ${externalIdParameterName}`);
  }

  try {
    return await assumeRoleWithExternalId(deps, {
      roleArn: competitorRoleArn,
      jobId: params.jobId,
      externalId,
      sessionNamePrefix: params.sessionNamePrefix,
    });
  } catch (currentErr) {
    return await retryWithPreviousExternalId(deps, {
      region: params.region,
      jobId: params.jobId,
      competitorRoleArn,
      externalIdParameterName,
      currentVersion: Number(externalIdOut.Parameter?.Version ?? 0),
      currentErr,
      sessionNamePrefix: params.sessionNamePrefix,
      graceFallbackTraceEvent: params.graceFallbackTraceEvent,
    });
  }
}
