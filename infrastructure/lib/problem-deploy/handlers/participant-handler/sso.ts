import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES, ULID_RE } from "../shared/constants.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

/**
 * Issue #705: 旧 `kind: "misconfigured"` が 4 分岐 (= env 未設定 / STS 失敗 /
 * federation endpoint 失敗 / token JSON malformed) を全部潰していたため、 operator が
 * CloudWatch logs を引かないと原因切り分けできなかった。 細分化して structured log と
 * frontend friendly-error mapping を可能にする。
 */
export type SsoOutcome =
  | { kind: "ok"; loginUrl: string }
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "role_arn_missing" }
  | { kind: "assume_role_failed"; reason: string }
  | { kind: "federation_endpoint_failed"; status: number }
  | { kind: "federation_token_malformed" };

const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";
const FEDERATION_SESSION_DURATION_SEC = 3600;
const TENKACLOUD_ISSUER = "https://tenkacloud.example/portal";

function buildSessionPolicy(_namePrefix: string): string {
  // #737: 旧実装は per-namePrefix ARN scope を Allow 7 statements に詰めていたが、 STS の
  // packed session policy size limit (= 2048 bytes) を 118% 超過して AssumeRole 自体が
  // failing していた (CloudWatch logs で確定)。 session policy は **Deny only** に simplify
  // し、 Allow は Role の inline TcReadOnly policy (= tc-* 接頭辞 scoped) に委譲する。
  //
  // Trade-off: competitor は同 account の他 team の tc-* stack を一覧可能になるが、 sensitive
  // data (operator の teamLoginKey 入り DDB / Secrets / KMS / IAM) は引き続き Deny で守られる。
  // 詳細: #737 / PR-710 の reverse mitigation。 namePrefix 引数は今後の per-tag scoping
  // (= 別 Phase で session tag 経由) のために interface を残すが、 本実装では使わない。
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Action: [
          "codepipeline:*",
          "codebuild:*",
          "cognito-idp:*",
          "cognito-identity:*",
          "dynamodb:*",
          "secretsmanager:*",
          "ssm:Get*",
          "ssm:Describe*",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "iam:*",
          "sts:AssumeRole",
        ],
        Resource: "*",
      },
    ],
  });
}

const sts = new STSClient({});

/**
 * AWS Console ワンクリック login URL を発行する。
 *
 * 流れ:
 *   1. teamLoginKey で team の deployment を引き、jobId 一致行を抽出
 *   2. STS AssumeRole で `ConsoleViewerRole` (ReadOnlyAccess) の temp credentials 取得
 *   3. `signin.aws.amazon.com/federation?Action=getSigninToken` で SigninToken 交換
 *   4. `Action=login` URL を組み立てて返す (= 競技者が click すると AWS Console 開く)
 *
 * 競技者は自前 AWS アカウント不要。1-hour TTL で自動 expire。
 *
 * 行不在 / DELETING / DELETED → unauthorized。PENDING / IN_PROGRESS や stack 未起動
 * (namePrefix 無し) → not_ready。
 * `CONSOLE_VIEWER_ROLE_ARN` env 未設定 → misconfigured (= CDK 未 deploy)。
 */
export async function getConsoleSigninUrl(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<SsoOutcome> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const roleArn = process.env.CONSOLE_VIEWER_ROLE_ARN;
  if (!roleArn) return { kind: "role_arn_missing" };

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

  // STS AssumeRole + inline session policy で operator 機密への access を Deny する。
  // ReadOnly の Allow は ConsoleViewerRole の inline TcReadOnly policy に委譲する。
  // ExternalId は同 account 内なので省略 (cross-account は別 Role でカバー)。
  let session: {
    Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
  };
  try {
    session = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `participant-${jobId}`,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
        Policy: buildSessionPolicy(deployment.namePrefix),
      }),
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[sso] AssumeRole failed", { roleArn, jobId, reason });
    return { kind: "assume_role_failed", reason };
  }
  const creds = session.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    console.error("[sso] AssumeRole returned empty Credentials", { roleArn, jobId });
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
