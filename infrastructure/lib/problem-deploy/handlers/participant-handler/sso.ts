import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES, ULID_RE } from "../shared/constants.js";
import { getExternalId } from "../shared/external-id-store.js";
import { logDeployTrace } from "../shared/trace-log.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * Issue #705: 旧 `kind: "misconfigured"` が複数分岐 (= STS 失敗 /
 * federation endpoint 失敗 / token JSON malformed) を全部潰していたため、 operator が
 * CloudWatch logs を引かないと原因切り分けできなかった。 細分化して structured log と
 * frontend friendly-error mapping を可能にする。
 */
export type SsoOutcome =
  | { kind: "ok"; loginUrl: string }
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "assume_role_failed"; reason: string }
  | { kind: "federation_endpoint_failed"; status: number }
  | { kind: "federation_token_malformed" };

const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";
const FEDERATION_SESSION_DURATION_SEC = 3600;
const TENKACLOUD_ISSUER = "https://tenkacloud.example/portal";

/**
 * Issue #862: deployment 行の field を URL に埋める前に format を再 validate する。
 * deploy 時に validation 済だが、 DB を直接編集された場合や schema drift 時の防御層。
 *
 *   - AWS region: `[a-z]{2,3}-[a-z]+-\d+` (= aws-* / aws-cn-* / aws-us-gov-* も含めて緩めに pin)
 *   - namePrefix: ULID 由来の slugify 後 (`[a-z][a-z0-9-]*`) なので英数 + hyphen のみ
 *   - IAM Role ARN: `arn:aws:iam::<12 digit>:role/<name>` を厳密 match
 */
const AWS_REGION_RE = /^[a-z]{2,3}-[a-z]+-\d{1,2}$/;
const NAME_PREFIX_RE = /^[a-z][a-z0-9-]{0,127}$/;
const IAM_ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;

/**
 * Issue #946: AWS Console federation destination として SSM Parameter detail を埋めるとき、
 * Parameter 名は URL に直接挿入される (= `/systems-manager/parameters/<urlencoded>/description`)。
 * 攻撃者が namePrefix を改竄して `#`/`?`/`/` 等の特殊文字を入れることで Destination を曲げる
 * 経路を塞ぐため、 strict pattern を再 validate する (= 先頭 `/` 必須 + 英数 / `.` / `_` / `-` / `/` のみ)。
 */
const SSM_PARAM_NAME_RE = /^\/[A-Za-z0-9._\-/]{1,1023}$/;

/**
 * Issue #946: stack outputs から destination を決定する pure function (= testable に切り出し)。
 *
 * - `ssmParameterName` が strict regex に合致するなら SSM Parameter detail URL (= list view を
 *   経由しないため `ssm:DescribeParameters` 不要)
 * - そうでなければ CFn stacks 画面 (= multi-resource 問題で Resources tab から辿る前提)
 *
 * caller は `region` / `namePrefix` を事前 validate 済 (= URL injection 防御済) で渡す責務を負う。
 */
export function buildConsoleDestination(args: {
  readonly region: string;
  readonly namePrefix: string;
  readonly ssmParameterName: string | undefined;
}): string {
  const { region, namePrefix, ssmParameterName } = args;
  if (ssmParameterName && SSM_PARAM_NAME_RE.test(ssmParameterName)) {
    return `https://${region}.console.aws.amazon.com/systems-manager/parameters/${encodeURIComponent(ssmParameterName)}/description?region=${encodeURIComponent(region)}`;
  }
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks?filteringText=${encodeURIComponent(namePrefix)}`;
}

const sts = new STSClient({});

type StsCredentialShape = {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
};

function toSdkCredentials(creds: StsCredentialShape | undefined):
  | {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
    }
  | undefined {
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) return undefined;
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
}

/**
 * AWS Console ワンクリック login URL を発行する。
 *
 * 流れ:
 *   1. teamLoginKey で team の deployment を引き、jobId 一致行を抽出
 *   2. deployment.stackOutputs から per-problem ParticipantViewerRoleArn を読む
 *   3. tenant ExternalId で CompetitorDeployRole を AssumeRole
 *   4. jobId ExternalId で ParticipantViewerRole を AssumeRole
 *   5. `signin.aws.amazon.com/federation?Action=getSigninToken` で SigninToken 交換
 *   6. `Action=login` URL を組み立てて返す (= 競技者が click すると AWS Console 開く)
 *
 * 競技者は自前 AWS アカウント不要。1-hour TTL で自動 expire。
 *
 * 行不在 / DELETING / DELETED → unauthorized。PENDING / IN_PROGRESS や stack 未起動
 * (namePrefix 無し)、ParticipantViewerRoleArn 未出力 → not_ready。
 */
export async function getConsoleSigninUrl(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<SsoOutcome> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const deployment = await loadSsoDeployment(shared, teamLoginKey, jobId);
  if (!deployment) return { kind: "unauthorized" };
  const ready = validateSsoDeployment(jobId, deployment);
  if ("kind" in ready) return ready;
  const credentials = await assumeParticipantCredentials(shared, ready, jobId);
  if ("kind" in credentials) return credentials;
  const signinToken = await fetchSigninToken(jobId, credentials);
  if (typeof signinToken !== "string") return signinToken;

  // Issue #946: stack outputs に `ParameterName` があれば SSM Parameter detail page に直接遷移
  // させる (= AWS Console SSM Parameter Store の list view を経由しないため
  // ssm:DescribeParameters 不要、 JAM/GameDay baseline IAM (PR-933 / ADR-021) と整合)。
  // それ以外は従来通り CFn stacks 画面 (= multi-resource 問題で Resources tab 経由)。
  const ssmParameterNameRaw = ready.parsedOutputs.ParameterName;
  const destination = buildConsoleDestination({
    region: ready.region,
    namePrefix: ready.namePrefix,
    ssmParameterName: typeof ssmParameterNameRaw === "string" ? ssmParameterNameRaw : undefined,
  });
  const loginUrl = `${FEDERATION_ENDPOINT}?Action=login&Issuer=${encodeURIComponent(TENKACLOUD_ISSUER)}&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(signinToken)}`;

  // Issue #1003: AWS Console "400 Bad Request" を発見した時の診断補助。 loginUrl は
  // typical 1800-2400 文字。 一部 proxy / ブラウザは長い URL を勝手に truncate するので、
  // 上限を 4096 で警告 + 構成要素長を log に残す (= 「token が破損していたのか URL が長すぎたのか」 を
  // CloudWatch Logs Insights で切り分け可能にする)。
  const componentLengths = {
    issuer: TENKACLOUD_ISSUER.length,
    destination: destination.length,
    signinTokenRaw: signinToken.length,
    encodedSigninToken: encodeURIComponent(signinToken).length,
    total: loginUrl.length,
  };
  if (loginUrl.length > 4096) {
    console.warn("[sso] loginUrl exceeds 4096 chars (may be truncated by proxies)", {
      jobId,
      ...componentLengths,
    });
  }
  logDeployTrace("portal.sso.ok", { jobId, problemId: ready.problemId, ...componentLengths });

  return { kind: "ok", loginUrl };
}

interface ReadySsoDeployment {
  readonly deployment: Partial<DeploymentItem>;
  readonly status: DeploymentStatus;
  readonly problemId: string | undefined;
  readonly tenantId: string;
  readonly region: string;
  readonly namePrefix: string;
  readonly competitorRoleArn: string;
  readonly participantRoleArn: string;
  readonly parsedOutputs: Record<string, string>;
}

async function loadSsoDeployment(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<Partial<DeploymentItem> | undefined> {
  const items = await queryTeamItems(shared, teamLoginKey);
  return items.find((item) => item.jobId === jobId) as Partial<DeploymentItem> | undefined;
}

function validateSsoDeployment(
  jobId: string,
  deployment: Partial<DeploymentItem>,
): ReadySsoDeployment | SsoOutcome {
  const status = (deployment.status ?? "PENDING") as DeploymentStatus;
  const problemId = typeof deployment.problemId === "string" ? deployment.problemId : undefined;
  if (DELETED_LIKE_STATUSES.has(status)) return { kind: "unauthorized" };
  if (status === "IN_PROGRESS" || status === "PENDING") {
    return logSsoNotReady("portal.sso.not_ready.in_progress", { jobId, problemId, status });
  }
  const identifiers = validateSsoIdentifiers(jobId, deployment, problemId, status);
  if ("kind" in identifiers) return identifiers;
  return validateParticipantRole(jobId, deployment, problemId, status, identifiers);
}

function validateSsoIdentifiers(
  jobId: string,
  deployment: Partial<DeploymentItem>,
  problemId: string | undefined,
  status: DeploymentStatus,
):
  | Pick<ReadySsoDeployment, "tenantId" | "region" | "namePrefix" | "competitorRoleArn">
  | SsoOutcome {
  if (typeof deployment.namePrefix !== "string" || !NAME_PREFIX_RE.test(deployment.namePrefix)) {
    return logSsoNotReady("portal.sso.not_ready.namePrefix_missing", { jobId, problemId, status });
  }
  if (typeof deployment.region !== "string" || !AWS_REGION_RE.test(deployment.region)) {
    return logSsoNotReady("portal.sso.not_ready.region_missing", { jobId, problemId, status });
  }
  if (typeof deployment.tenantId !== "string") {
    return logSsoNotReady("portal.sso.not_ready.tenantId_missing", { jobId, problemId, status });
  }
  if (
    typeof deployment.competitorRoleArn !== "string" ||
    !IAM_ROLE_ARN_RE.test(deployment.competitorRoleArn)
  ) {
    return logSsoNotReady("portal.sso.not_ready.competitorRoleArn_missing", {
      jobId,
      problemId,
      tenantId: deployment.tenantId,
    });
  }
  return {
    tenantId: deployment.tenantId,
    region: deployment.region,
    namePrefix: deployment.namePrefix,
    competitorRoleArn: deployment.competitorRoleArn,
  };
}

function validateParticipantRole(
  jobId: string,
  deployment: Partial<DeploymentItem>,
  problemId: string | undefined,
  status: DeploymentStatus,
  identifiers: Pick<ReadySsoDeployment, "tenantId" | "region" | "namePrefix" | "competitorRoleArn">,
): ReadySsoDeployment | SsoOutcome {
  const parsedOutputs = parseStackOutputs(deployment.stackOutputs);
  const participantRoleArn = parsedOutputs.ParticipantViewerRoleArn;
  if (typeof participantRoleArn !== "string" || !IAM_ROLE_ARN_RE.test(participantRoleArn)) {
    return logSsoNotReady("portal.sso.not_ready.participantViewerRole_missing", {
      jobId,
      problemId,
      tenantId: identifiers.tenantId,
      outputKeys: Object.keys(parsedOutputs),
    });
  }
  return { deployment, problemId, status, parsedOutputs, participantRoleArn, ...identifiers };
}

function logSsoNotReady(event: string, detail: Record<string, unknown>): SsoOutcome {
  logDeployTrace(event, detail);
  return { kind: "not_ready" };
}

async function assumeParticipantCredentials(
  shared: ParticipantSharedResources,
  ready: ReadySsoDeployment,
  jobId: string,
): Promise<NonNullable<ReturnType<typeof toSdkCredentials>> | SsoOutcome> {
  const externalId = await loadTenantExternalId(shared, ready.tenantId, jobId);
  if (typeof externalId !== "string") return externalId;
  try {
    const competitor = await sts.send(
      new AssumeRoleCommand({
        RoleArn: ready.competitorRoleArn,
        RoleSessionName: `participant-sso-${jobId}`,
        ExternalId: externalId,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
      }),
    );
    const competitorCredentials = toSdkCredentials(competitor.Credentials);
    if (!competitorCredentials) return missingSsoCredentials("CompetitorDeployRole", jobId);
    const session = await assumeParticipantRole(competitorCredentials, ready, jobId);
    const credentials = toSdkCredentials(session.Credentials);
    return credentials ?? missingSsoCredentials("ParticipantViewerRole", jobId);
  } catch (err) {
    const errorName = err instanceof Error ? err.name : "Unknown";
    console.error("[sso] AssumeRole failed", { jobId, errorName });
    return { kind: "assume_role_failed", reason: errorName };
  }
}

async function loadTenantExternalId(
  shared: ParticipantSharedResources,
  tenantId: string,
  jobId: string,
): Promise<string | SsoOutcome> {
  if (!shared.ssm || !shared.env) {
    console.error("[sso] ExternalId store is not configured", { jobId });
    return { kind: "assume_role_failed", reason: "ExternalId store is not configured" };
  }
  const externalId = await getExternalId({ ssm: shared.ssm, env: shared.env }, tenantId);
  if (externalId) return externalId;
  console.error("[sso] tenant ExternalId missing", { jobId });
  return { kind: "assume_role_failed", reason: "Tenant ExternalId missing" };
}

function assumeParticipantRole(
  credentials: NonNullable<ReturnType<typeof toSdkCredentials>>,
  ready: ReadySsoDeployment,
  jobId: string,
) {
  return new STSClient({ credentials }).send(
    new AssumeRoleCommand({
      RoleArn: ready.participantRoleArn,
      RoleSessionName: `${ready.problemId}-${jobId}`,
      ExternalId: jobId,
      DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
    }),
  );
}

function missingSsoCredentials(role: string, jobId: string): SsoOutcome {
  console.error(`[sso] ${role} AssumeRole returned empty Credentials`, { jobId });
  return { kind: "assume_role_failed", reason: "Credentials field empty" };
}

async function fetchSigninToken(
  jobId: string,
  credentials: NonNullable<ReturnType<typeof toSdkCredentials>>,
): Promise<string | SsoOutcome> {
  const sessionJson = JSON.stringify({
    sessionId: credentials.accessKeyId,
    sessionKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });
  const tokenUrl = `${FEDERATION_ENDPOINT}?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const tokenRes = await fetch(tokenUrl, { method: "GET" });
  if (!tokenRes.ok) {
    console.error("[sso] federation endpoint non-200", {
      jobId,
      status: tokenRes.status,
      statusText: tokenRes.statusText,
    });
    return { kind: "federation_endpoint_failed", status: tokenRes.status };
  }
  const tokenJson = (await tokenRes.json()) as { SigninToken?: unknown };
  if (typeof tokenJson.SigninToken === "string") return tokenJson.SigninToken;
  console.error("[sso] federation token malformed", { jobId });
  return { kind: "federation_token_malformed" };
}
