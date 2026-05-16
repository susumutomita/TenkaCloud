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
  const problemId = typeof deployment.problemId === "string" ? deployment.problemId : undefined;
  if (DELETED_LIKE_STATUSES.has(status)) return { kind: "unauthorized" };

  // Issue #759: 各 not_ready 経路で structured log を 1 件 emit する。
  // CloudWatch Logs Insights:
  //   `filter event like /^portal\.sso\.not_ready\./ | sort @timestamp desc`
  // で どの gate で死んだか 1 引きで切り分け可能にする。 旧実装は全 6 経路がサイレントで、
  // operator が deployment item を引いて目視確認するしかなかった (= #756 調査で実体験)。
  if (status === "IN_PROGRESS" || status === "PENDING") {
    logDeployTrace("portal.sso.not_ready.in_progress", { jobId, problemId, status });
    return { kind: "not_ready" };
  }
  if (typeof deployment.namePrefix !== "string") {
    logDeployTrace("portal.sso.not_ready.namePrefix_missing", { jobId, problemId, status });
    return { kind: "not_ready" };
  }
  const region = typeof deployment.region === "string" ? deployment.region : undefined;
  if (!region) {
    logDeployTrace("portal.sso.not_ready.region_missing", { jobId, problemId, status });
    return { kind: "not_ready" };
  }
  const tenantId = typeof deployment.tenantId === "string" ? deployment.tenantId : undefined;
  if (!tenantId) {
    logDeployTrace("portal.sso.not_ready.tenantId_missing", { jobId, problemId, status });
    return { kind: "not_ready" };
  }
  const competitorRoleArn =
    typeof deployment.competitorRoleArn === "string" ? deployment.competitorRoleArn : undefined;
  if (!competitorRoleArn) {
    logDeployTrace("portal.sso.not_ready.competitorRoleArn_missing", {
      jobId,
      problemId,
      tenantId,
    });
    return { kind: "not_ready" };
  }
  const parsedOutputs = parseStackOutputs(deployment.stackOutputs);
  const participantRoleArn = parsedOutputs.ParticipantViewerRoleArn;
  if (!participantRoleArn) {
    // 世代不一致 (= problem template が ParticipantViewerRole を持つ世代より古い) の
    // 切り分けを 1 引きで可能にするため、 stack outputs の他 key 一覧を log に残す。
    logDeployTrace("portal.sso.not_ready.participantViewerRole_missing", {
      jobId,
      problemId,
      tenantId,
      outputKeys: Object.keys(parsedOutputs),
    });
    return { kind: "not_ready" };
  }
  if (!shared.ssm || !shared.env) {
    // Issue #864: tenantId / ARN は CloudWatch Logs に残さない (= 情報漏洩面の縮小)。
    console.error("[sso] ExternalId store is not configured", { jobId });
    return { kind: "assume_role_failed", reason: "ExternalId store is not configured" };
  }

  const tenantExternalId = await getExternalId({ ssm: shared.ssm, env: shared.env }, tenantId);
  if (!tenantExternalId) {
    console.error("[sso] tenant ExternalId missing", { jobId });
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
      // Issue #864: ARN を log に出さない。 jobId のみで CloudWatch Logs Insights から
      // deployment item に join できる (= ARN は item 側から後追い参照可能、 log 側に重複させない)。
      console.error("[sso] CompetitorDeployRole AssumeRole returned empty Credentials", { jobId });
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
    // Issue #864: ARN / message を log に残さず、 error 種別 (= class name) のみで切り分け可能にする。
    // operator は jobId で deployment item を引いて ARN を確認できる (= 別経路で参照可能)。
    const errorName = err instanceof Error ? err.name : "Unknown";
    console.error("[sso] AssumeRole failed", { jobId, errorName });
    return { kind: "assume_role_failed", reason: errorName };
  }
  const creds = session.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    console.error("[sso] ParticipantViewerRole AssumeRole returned empty Credentials", { jobId });
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
