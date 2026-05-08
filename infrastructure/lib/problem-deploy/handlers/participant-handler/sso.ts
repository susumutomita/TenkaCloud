import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { DeploymentItem, DeploymentStatus } from "../deploy-handler/types.js";
import { DELETED_LIKE_STATUSES, ULID_RE } from "../shared/constants.js";
import { type ParticipantSharedResources, queryTeamItems } from "./shared.js";

export type SsoOutcome =
  | { kind: "ok"; loginUrl: string }
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "misconfigured" };

const FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation";
const FEDERATION_SESSION_DURATION_SEC = 3600;
const TENKACLOUD_ISSUER = "https://tenkacloud.example/portal";

/**
 * AssumeRole 時の inline session policy。`ConsoleViewerRole` の `ReadOnlyAccess` を
 * 「stack の状態が見れる + 競技対象 service の Describe」だけに**さらに絞る**ための gate。
 *
 * 必要: 競技者は自分の deployment の CFn / EC2 / Logs だけ見えればよい。
 * 危険: ReadOnlyAccess 単体だと operator account の DDB Deployments テーブル
 * (= 全チームの teamLoginKey が入っている) を Scan されて bearer token が漏れる。
 * → `dynamodb:*` / `secretsmanager:*` / `ssm:Get*` / `kms:Decrypt` / `iam:*` を Deny で殺す。
 *
 * セッションポリシーは Role の policy との **AND** で評価される (= Allow の和集合では
 * なく交差) なので、ここで Allow したものは元 Role に無ければ通らない。
 */
const SESSION_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "ec2:Describe*",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
        "lambda:GetFunction",
        "lambda:ListFunctions",
        "apigateway:GET",
        "s3:GetBucketLocation",
        "s3:ListBucket",
      ],
      Resource: "*",
    },
    {
      Effect: "Deny",
      Action: [
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
 * 行不在 / DELETING / DELETED → unauthorized。stack 未起動 (namePrefix 無し) → not_ready。
 * `CONSOLE_VIEWER_ROLE_ARN` env 未設定 → misconfigured (= CDK 未 deploy)。
 */
export async function getConsoleSigninUrl(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
): Promise<SsoOutcome> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const roleArn = process.env.CONSOLE_VIEWER_ROLE_ARN;
  if (!roleArn) return { kind: "misconfigured" };

  const items = await queryTeamItems(shared, teamLoginKey);
  if (items.length === 0) return { kind: "unauthorized" };

  const deployment = items.find((i) => i.jobId === jobId) as Partial<DeploymentItem> | undefined;
  if (!deployment) return { kind: "unauthorized" };

  const status = (deployment.status ?? "PENDING") as DeploymentStatus;
  if (DELETED_LIKE_STATUSES.has(status)) return { kind: "unauthorized" };
  if (typeof deployment.namePrefix !== "string") return { kind: "not_ready" };
  const region = typeof deployment.region === "string" ? deployment.region : undefined;
  if (!region) return { kind: "not_ready" };

  // STS AssumeRole + inline session policy で `ReadOnlyAccess` をさらに絞る。
  // ExternalId は同 account 内なので省略 (cross-account は別 Role でカバー)。
  const session = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `participant-${jobId}`,
      DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
      Policy: SESSION_POLICY,
    }),
  );
  const creds = session.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    return { kind: "misconfigured" };
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

  const tokenUrl = `${FEDERATION_ENDPOINT}?Action=getSigninToken&SessionDuration=${FEDERATION_SESSION_DURATION_SEC}&Session=${encodeURIComponent(sessionJson)}`;
  const tokenRes = await fetch(tokenUrl, { method: "GET" });
  if (!tokenRes.ok) return { kind: "misconfigured" };
  const tokenJson = (await tokenRes.json()) as { SigninToken?: unknown };
  if (typeof tokenJson.SigninToken !== "string") return { kind: "misconfigured" };

  // CloudFormation スタック画面に直接遷移するための destination URL。
  // 自分の deployment の namePrefix で stacks フィルタ済の view にする。
  const destination = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks?filteringText=${encodeURIComponent(deployment.namePrefix)}`;
  const loginUrl = `${FEDERATION_ENDPOINT}?Action=login&Issuer=${encodeURIComponent(TENKACLOUD_ISSUER)}&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(tokenJson.SigninToken)}`;

  return { kind: "ok", loginUrl };
}
