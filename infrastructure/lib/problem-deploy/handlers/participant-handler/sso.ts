import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { parseStackOutputs } from "../shared/cfn-status.js";
import { DELETED_LIKE_STATUSES, ULID_RE } from "../shared/constants.js";
import { getExternalId } from "../shared/external-id-store.js";
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

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const deployment = items.find((i) => i.jobId === jobId) as Partial<DeploymentItem> | undefined;
  if (!deployment) return { kind: "unauthorized" };

  const status = (deployment.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return { kind: "unauthorized" };
  if (status === "IN_PROGRESS" || status === "PENDING") return { kind: "not_ready" };
  if (typeof deployment.namePrefix !== "string") return { kind: "not_ready" };
  const region = typeof deployment.region === "string" ? deployment.region : undefined;
  if (!region) return { kind: "not_ready" };
  const tenantId = typeof deployment.tenantId === "string" ? deployment.tenantId : undefined;
  if (!tenantId) return { kind: "not_ready" };
  const competitorRoleArn =
    typeof deployment.competitorRoleArn === "string" ? deployment.competitorRoleArn : undefined;
  if (!competitorRoleArn) return { kind: "not_ready" };
  const participantRoleArn = parseStackOutputs(deployment.stackOutputs).ParticipantViewerRoleArn;
  if (!participantRoleArn) return { kind: "not_ready" };
  if (!shared.ssm || !shared.env) {
    console.error("[sso] ExternalId store is not configured", { jobId, tenantId });
    return { kind: "assume_role_failed", reason: "ExternalId store is not configured" };
  }

  const tenantExternalId = await getExternalId({ ssm: shared.ssm, env: shared.env }, tenantId);
  if (!tenantExternalId) {
    console.error("[sso] tenant ExternalId missing", { jobId, tenantId });
    return { kind: "assume_role_failed", reason: "Tenant ExternalId missing" };
  }

  let session: {
    Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
  };
  try {
    const competitorSession = await sts.send(
      new AssumeRoleCommand({
        RoleArn: competitorRoleArn,
        RoleSessionName: `participant-sso-${jobId}`,
        ExternalId: tenantExternalId,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
      }),
    );
    const competitorCredentials = toSdkCredentials(competitorSession.Credentials);
    if (!competitorCredentials) {
      console.error("[sso] CompetitorDeployRole AssumeRole returned empty Credentials", {
        competitorRoleArn,
        jobId,
      });
      return { kind: "assume_role_failed", reason: "Credentials field empty" };
    }
    const innerSts = new STSClient({ credentials: competitorCredentials });
    session = await innerSts.send(
      new AssumeRoleCommand({
        RoleArn: participantRoleArn,
        RoleSessionName: `participant-viewer-${jobId}`,
        ExternalId: jobId,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
      }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[sso] AssumeRole failed", {
      competitorRoleArn,
      participantRoleArn,
      jobId,
      reason,
    });
    return { kind: "assume_role_failed", reason };
  }
  const creds = session.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    console.error("[sso] ParticipantViewerRole AssumeRole returned empty Credentials", {
      participantRoleArn,
      jobId,
    });
    return { kind: "assume_role_failed", reason: "Credentials field empty" };
  }

  // signin.aws.amazon.com/federation 仕様の Session JSON。
  //   sessionId = AccessKeyId
  //   sessionKey = SecretAccessKey
  //   sessionToken = SessionToken
  const sessionJson = JSON.stringify({
    sessionId: creds.AccessKeyId,
    sessionKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  });

  // #747: AssumeRole 由来の temporary credentials で federation する場合、 SessionDuration
  // パラメータは **省略必須** (AWS 仕様)。 渡すと endpoint が 400 で reject する。
  // session 寿命は AssumeRole 時の DurationSeconds (= 3600s) を継承する。
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
  if (typeof tokenJson.SigninToken !== "string") {
    console.error("[sso] federation token malformed", { jobId });
    return { kind: "federation_token_malformed" };
  }

  // CloudFormation スタック画面に直接遷移するための destination URL。
  // 自分の deployment の namePrefix で stacks フィルタ済の view にする。
  const destination = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks?filteringText=${encodeURIComponent(deployment.namePrefix)}`;
  const loginUrl = `${FEDERATION_ENDPOINT}?Action=login&Issuer=${encodeURIComponent(TENKACLOUD_ISSUER)}&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(tokenJson.SigninToken)}`;

  return { kind: "ok", loginUrl };
}
