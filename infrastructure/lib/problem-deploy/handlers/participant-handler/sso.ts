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
 *
 * Issue #1197: assume_role_failed に `stage` を追加 (= どちらの AssumeRole で落ちたか)。
 * UI が 「 CompetitorDeployRole の ExternalId が違うのか / ParticipantViewerRole の
 * Trust policy が違うのか」 を区別できるようにする。
 */
export type AssumeRoleStage = "competitor" | "participant_viewer";

export type SsoOutcome =
  | { kind: "ok"; loginUrl: string }
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "assume_role_failed"; stage: AssumeRoleStage; reason: string }
  | { kind: "federation_endpoint_failed"; status: number }
  | { kind: "federation_token_malformed" };

/**
 * Issue #1197: CLI / SDK 用一時資格情報。 Console federation と同じ 2 段 AssumeRole
 * (CompetitorDeployRole → ParticipantViewerRole) を実行するが、 federation endpoint を
 * 呼ばずに credentials を直接返す。 IAM scope は Console と同じ (= ParticipantViewerRole)。
 *
 * frontend は受け取った credentials を `aws configure` / `boto3` / `Terraform` で
 * そのまま使える形 (= AccessKeyId / SecretAccessKey / SessionToken + Expiration) で返す。
 */
export interface CliCredentialsView {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** ISO 8601 string。 STS Credentials.Expiration を直接 echo (= TTL ~ 1 hour)。 */
  readonly expiration: string;
  /** deploy region (= competitor account 側の deploy 先) */
  readonly region: string;
  /** 12 桁 AWS Account ID。 frontend が UI で表示する用。 */
  readonly awsAccountId: string;
}

export type CliCredentialsOutcome =
  | { kind: "ok"; credentials: CliCredentialsView }
  | { kind: "unauthorized" }
  | { kind: "not_ready" }
  | { kind: "invalid_jobid" }
  | { kind: "assume_role_failed"; stage: AssumeRoleStage; reason: string };

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
 * AWS Console の federation destination は home 画面に固定する。 SSM / CFn の deep link は
 * サービス固有の list view を経由して `Describe*` を要求するため、least-privilege な
 * JAM/GameDay baseline IAM と相性が悪い。home から競技者自身が必要なサービスへ遷移する方が
 * fail-safe (= 問題側の IAM スコープに依らない)。
 *
 * caller は `region` を事前 validate 済 (= URL injection 防御済) で渡す責務を負う。
 */
export function buildConsoleDestination(args: { readonly region: string }): string {
  const { region } = args;
  return `https://${region}.console.aws.amazon.com/console/home?region=${encodeURIComponent(region)}`;
}

const sts = new STSClient({});

/**
 * Issue #2077: how `getConsoleSigninUrl` / `getCliCredentials` obtain the
 * deployment row for a `(teamLoginKey, jobId)` pair. Defaults to the existing
 * team-scoped GSI2 query ({@link loadSsoDeployment}); the composite AWS access
 * bridge injects a loader that returns a server-resolved composite target row
 * (which is intentionally absent from GSI2, see {@link CompositeTargetDeploymentItem}).
 *
 * This is purely an additive seam: the default keeps the legacy AWS SSO / CLI
 * behavior byte-for-byte (the row is still resolved by the team's GSI2 list and
 * matched on `jobId`). No STS / federation / validation logic is changed.
 */
export type SsoDeploymentLoader = (
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
) => Promise<Partial<DeploymentItem> | undefined>;

/** The subset of STSClient this module actually calls (= `send`). */
export type StsClient = Pick<STSClient, "send">;

export interface SsoDeploymentDeps {
  /** Override how the deployment row is resolved. Defaults to the GSI2 team query. */
  readonly loadDeployment?: SsoDeploymentLoader;
  /**
   * Issue #2214: stage 1 AssumeRole client (tenant ExternalId → CompetitorDeployRole).
   * Defaults to a real, module-level `STSClient`.
   */
  readonly sts?: StsClient;
  /**
   * Issue #2214: stage 2 AssumeRole client factory (jobId ExternalId → ParticipantViewerRole).
   * A factory (not a fixed client) because stage 2's client must be scoped to the stage 1
   * credentials, which differ per call. Defaults to `new STSClient({ credentials })`.
   */
  readonly buildParticipantClient?: (credentials: SdkCredentials) => StsClient;
  /** HTTP client for the federation `getSigninToken` exchange. Defaults to global `fetch`. */
  readonly fetchClient?: typeof fetch;
}

type StsCredentialShape = {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: Date;
};

interface SdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** Issue #1197: CLI credentials 用に Expiration を保持。 federation には不要だが副作用なし。 */
  readonly expiration?: Date;
}

function toSdkCredentials(creds: StsCredentialShape | undefined): SdkCredentials | undefined {
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) return undefined;
  // expiration が undefined のときは property ごと省略する (= AWS SDK STSClient コンストラクタへ
  // 渡したとき、 既存テストの `toContainEqual` が 3-field の credentials object と等価判定できる)。
  const base: SdkCredentials = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
  return creds.Expiration ? { ...base, expiration: creds.Expiration } : base;
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
  deps: SsoDeploymentDeps = {},
): Promise<SsoOutcome> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const loadDeployment = deps.loadDeployment ?? loadSsoDeployment;
  const deployment = await loadDeployment(shared, teamLoginKey, jobId);
  if (!deployment) return { kind: "unauthorized" };
  const ready = validateSsoDeployment(jobId, deployment);
  if ("kind" in ready) return ready;
  const chain = await assumeParticipantCredentials(shared, ready, jobId, deps);
  if (chain.kind !== "ok") return chain;
  const signinToken = await fetchSigninToken(jobId, chain.credentials, deps.fetchClient ?? fetch);
  if (typeof signinToken !== "string") return signinToken;

  const destination = buildConsoleDestination({ region: ready.region });
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

/**
 * Issue #1197: 2 段 AssumeRole 結果。 ok か stage 付き失敗。 console / CLI 両方が共用する
 * (= IAM scope は完全に同じで、 用途が違うのは fetchSigninToken の有無だけ)。
 */
type AssumeChainOutcome =
  | { kind: "ok"; credentials: SdkCredentials }
  | { kind: "assume_role_failed"; stage: AssumeRoleStage; reason: string };

async function assumeParticipantCredentials(
  shared: ParticipantSharedResources,
  ready: ReadySsoDeployment,
  jobId: string,
  deps: SsoDeploymentDeps,
): Promise<AssumeChainOutcome> {
  const externalIdResult = await loadTenantExternalId(shared, ready.tenantId, jobId);
  if (externalIdResult.kind !== "ok") return externalIdResult;
  const externalId = externalIdResult.externalId;

  // Stage 1: tenant CompetitorDeployRole を tenant ExternalId で AssumeRole。
  let competitorCredentials: SdkCredentials | undefined;
  try {
    const competitor = await (deps.sts ?? sts).send(
      new AssumeRoleCommand({
        RoleArn: ready.competitorRoleArn,
        RoleSessionName: `participant-sso-${jobId}`,
        ExternalId: externalId,
        DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
      }),
    );
    competitorCredentials = toSdkCredentials(competitor.Credentials);
  } catch (err) {
    return assumeRoleFailure("competitor", jobId, err);
  }
  if (!competitorCredentials) return missingSsoCredentials("competitor", jobId);

  // Stage 2: per-problem ParticipantViewerRole を jobId ExternalId で AssumeRole。
  let participantCredentials: SdkCredentials | undefined;
  try {
    const session = await assumeParticipantRole(competitorCredentials, ready, jobId, deps);
    participantCredentials = toSdkCredentials(session.Credentials);
  } catch (err) {
    return assumeRoleFailure("participant_viewer", jobId, err);
  }
  if (!participantCredentials) return missingSsoCredentials("participant_viewer", jobId);

  return { kind: "ok", credentials: participantCredentials };
}

type TenantExternalIdResult =
  | { kind: "ok"; externalId: string }
  | { kind: "assume_role_failed"; stage: AssumeRoleStage; reason: string };

async function loadTenantExternalId(
  shared: ParticipantSharedResources,
  tenantId: string,
  jobId: string,
): Promise<TenantExternalIdResult> {
  if (!shared.ssm || !shared.env) {
    console.error("[sso] ExternalId store is not configured", { jobId });
    return {
      kind: "assume_role_failed",
      stage: "competitor",
      reason: "ExternalId store is not configured",
    };
  }
  const externalId = await getExternalId({ ssm: shared.ssm, env: shared.env }, tenantId);
  if (externalId) return { kind: "ok", externalId };
  console.error("[sso] tenant ExternalId missing", { jobId });
  return { kind: "assume_role_failed", stage: "competitor", reason: "Tenant ExternalId missing" };
}

/** Default stage-2 client factory: a fresh STSClient scoped to the stage-1 credentials. */
function defaultParticipantClient(credentials: SdkCredentials): StsClient {
  // SDK が credentials の expiration field を見ない (= 認証には不要) ので、 stage 2 の
  // STSClient には accessKeyId / secretAccessKey / sessionToken だけ渡す。 expiration を
  // 含めると 既存テスト `toContainEqual` が 3-field の credentials object と等価判定できない。
  return new STSClient({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });
}

function assumeParticipantRole(
  credentials: SdkCredentials,
  ready: ReadySsoDeployment,
  jobId: string,
  deps: SsoDeploymentDeps,
) {
  const client = (deps.buildParticipantClient ?? defaultParticipantClient)(credentials);
  return client.send(
    new AssumeRoleCommand({
      RoleArn: ready.participantRoleArn,
      RoleSessionName: `${ready.problemId}-${jobId}`,
      ExternalId: jobId,
      DurationSeconds: FEDERATION_SESSION_DURATION_SEC,
    }),
  );
}

function assumeRoleFailure(
  stage: AssumeRoleStage,
  jobId: string,
  err: unknown,
): AssumeChainOutcome {
  const reason = err instanceof Error ? err.name : "Unknown";
  console.error("[sso] AssumeRole failed", { jobId, stage, reason });
  return { kind: "assume_role_failed", stage, reason };
}

function missingSsoCredentials(stage: AssumeRoleStage, jobId: string): AssumeChainOutcome {
  console.error("[sso] AssumeRole returned empty Credentials", { jobId, stage });
  return { kind: "assume_role_failed", stage, reason: "Credentials field empty" };
}

async function fetchSigninToken(
  jobId: string,
  credentials: SdkCredentials,
  httpFetch: typeof fetch,
): Promise<string | SsoOutcome> {
  const sessionJson = JSON.stringify({
    sessionId: credentials.accessKeyId,
    sessionKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });
  const tokenUrl = `${FEDERATION_ENDPOINT}?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const tokenRes = await httpFetch(tokenUrl, { method: "GET" });
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

/**
 * Issue #1197: CLI / SDK 用一時資格情報を発行する。
 *
 * Console federation (= getConsoleSigninUrl) と同じ 2 段 AssumeRole
 * (CompetitorDeployRole → ParticipantViewerRole) を実行するが、 federation endpoint を
 * 呼ばずに STS credentials を直接返す。 競技者は `aws configure` / `boto3` /
 * `Terraform` に貼り付けて使える。
 *
 * IAM scope は Console と同じ (= ParticipantViewerRole)。 「Console で見えるものは CLI でも
 * 見える」 が原則。 TTL は 1 時間 (= FEDERATION_SESSION_DURATION_SEC、 console と同じ)。
 *
 * 失敗時:
 *   - 行不在 / DELETING / DELETED → unauthorized
 *   - PENDING / IN_PROGRESS / namePrefix 未設定 / ParticipantViewerRoleArn 未出力 → not_ready
 *   - 1 段目 AssumeRole 失敗 → assume_role_failed (stage=competitor)
 *   - 2 段目 AssumeRole 失敗 → assume_role_failed (stage=participant_viewer)
 *   - STS Credentials が empty → assume_role_failed (= operator 設定 / IAM 異常)
 *
 * 監査: ok / 各 outcome を `logDeployTrace` で構造化 log に残す。 CloudWatch Logs Insights
 * から 「jobId / problemId / stage で grep」 して切り分け可能にする。
 */
export async function getCliCredentials(
  shared: ParticipantSharedResources,
  teamLoginKey: string,
  jobId: string,
  deps: SsoDeploymentDeps = {},
): Promise<CliCredentialsOutcome> {
  if (!ULID_RE.test(jobId)) return { kind: "invalid_jobid" };
  const loadDeployment = deps.loadDeployment ?? loadSsoDeployment;
  const deployment = await loadDeployment(shared, teamLoginKey, jobId);
  if (!deployment) return { kind: "unauthorized" };
  const ready = validateSsoDeployment(jobId, deployment);
  if ("kind" in ready) {
    // unauthorized / not_ready / assume_role_failed (= IAM 不備) を CliCredentialsOutcome
    // に narrow する。 ready が SsoOutcome の federation_* を返すことはこの分岐に到達しない
    // (= validateSsoDeployment は status 系のみ返す)。
    return mapSsoOutcomeToCliOutcome(ready);
  }
  const chain = await assumeParticipantCredentials(shared, ready, jobId, deps);
  if (chain.kind !== "ok") {
    logDeployTrace("portal.cli.assume_role_failed", {
      jobId,
      problemId: ready.problemId,
      stage: chain.stage,
      reason: chain.reason,
    });
    return chain;
  }
  const expiration =
    chain.credentials.expiration instanceof Date
      ? chain.credentials.expiration.toISOString()
      : new Date(Date.now() + FEDERATION_SESSION_DURATION_SEC * 1000).toISOString();

  const credentials: CliCredentialsView = {
    accessKeyId: chain.credentials.accessKeyId,
    secretAccessKey: chain.credentials.secretAccessKey,
    sessionToken: chain.credentials.sessionToken,
    expiration,
    region: ready.region,
    awsAccountId: extractAwsAccountIdFromArn(ready.competitorRoleArn) ?? "",
  };
  logDeployTrace("portal.cli.ok", {
    jobId,
    problemId: ready.problemId,
    region: ready.region,
    accessKeyId: credentials.accessKeyId,
    expiration,
  });
  return { kind: "ok", credentials };
}

/**
 * SsoOutcome の status 系 (unauthorized / not_ready / assume_role_failed) を
 * CliCredentialsOutcome に narrow する。 federation_* / ok は到達しないので throw。
 */
function mapSsoOutcomeToCliOutcome(outcome: SsoOutcome): CliCredentialsOutcome {
  if (
    outcome.kind === "unauthorized" ||
    outcome.kind === "not_ready" ||
    outcome.kind === "invalid_jobid"
  ) {
    return outcome;
  }
  if (outcome.kind === "assume_role_failed") {
    return { kind: "assume_role_failed", stage: outcome.stage, reason: outcome.reason };
  }
  // 残りは ok / federation_* — validateSsoDeployment からは出ない設計。 防御的に not_ready。
  return { kind: "not_ready" };
}

/** `arn:aws:iam::123456789012:role/Foo` → `"123456789012"` を抜く。 */
function extractAwsAccountIdFromArn(roleArn: string): string | undefined {
  const m = roleArn.match(/^arn:aws:iam::(\d{12}):role\//);
  return m?.[1];
}
