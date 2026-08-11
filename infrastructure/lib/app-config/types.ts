import type { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import type { ApiKeySSMParameterNames } from "../interfaces/api-key-ssm-parameter-names.js";
import type { ParticipantPortalRuntimeConfig } from "../problem-deploy/participant-portal-hosting.js";
import type { CustomDomainsConfig } from "../security/cloudfront-custom-domain.js";

export type { ApiKeySSMParameterNames };

/**
 * Issue #2290: control-plane data backend selector。app-config は construct 層
 * (`../problem-deploy/…`) に依存しない upstream レイヤなので、`control-data/types.ts` の
 * `ControlDataBackend` を import せずここに local 定義する (= 同一の literal union)。runtime factory
 * (`createEventsRepository` / `createTeamsRepository`) が cold-start で再検証するため二重管理でも安全。
 */
export type ControlDataBackend = "dynamodb" | "turso";

/**
 * [Problem Packs / Issue #2462] One active pack's on-disk materialization descriptor.
 *
 * Points at the ABSOLUTE `problemsRoot` of an installed + active pack's immutable snapshot
 * so Lite synth (`bin/tenkacloud-lite.ts` → `buildDeployPipeline`) can stage a per-pack
 * `BucketDeployment` that copies `<problemsRootAbs>/<category>/<id>/{template.yaml,metadata.json}`
 * into the source bucket under `pack-problems/<packId>/<version>/…` — the exact key space the
 * catalog directory keys (`buildPackProblemDirectory`) resolve to and the Lambda deploy path's
 * `buildS3ArtifactsResolver` reads. This is a materialization input (a filesystem path to copy
 * from), NOT a catalog projection, so it lives on {@link AppConfig} rather than inside
 * {@link ProblemsCatalogBundle}. Empty / undefined (the default, core-only path) materializes
 * nothing → CFn byte-identical.
 */
export interface PackAsset {
  /** Reverse-DNS pack id from the pack manifest (e.g. `com.example.cloud-pack`). */
  readonly packId: string;
  /** Immutable pack revision version from the manifest (e.g. `1.0.0`). */
  readonly version: string;
  /** Absolute path to the pack snapshot's problems root (the `BucketDeployment` source). */
  readonly problemsRootAbs: string;
}

/**
 * Issue #766: bin/infrastructure.ts に散在していた env / config 解決を 1 つの shape に
 * 集約する。pure function `resolveAppConfig` の戻り値で、 stack 配線層 (= `lib/app-wiring`)
 * からはこの object だけを参照する (= 副作用無し、 順序依存無し、 単体テスト可能)。
 */
export interface AppConfig {
  /** development / staging / production 等。`CDK_PARAM_ENVIRONMENT` から決定。 */
  readonly environment: string;
  /** 本 env が production / staging のいずれか (= deterministic default を禁じる対象)。 */
  readonly isProductionLike: boolean;
  /** `config.json` の `appName` を lowercase 化したもの。SSM parameter prefix 等で使う。 */
  readonly appNameLower: string;
  /** `${appNameLower}-${environment}` のプレフィックス (横軸 = 別 application、 縦軸 = 別 env の二重衝突回避)。 */
  readonly namePrefix: string;

  /** SBT が払い出す System Admin (Cognito) の email。 `CDK_PARAM_SYSTEM_ADMIN_EMAIL` から。 */
  readonly systemAdminEmail: string;
  /** Tenant 単位の deploy。 pooled 経路では `"pooled"`。 silo (PLATINUM) では ULID。 */
  readonly tenantId: string;
  /** Tenant の表示名 (= application-admin-console の Home 画面 fallback で使う)。 */
  readonly tenantName: string;
  /** `tenantId === "pooled"` の事前計算 alias。 */
  readonly isPooledDeploy: boolean;
  /** 共通 source artifact (SBT BashJobRunner の deploy 経路で使う zip 名)。 */
  readonly s3SourceBucket: string;
  readonly sourceZip: string;
  readonly commitId: string;

  /** API Gateway stage 名 (= `prod` 等)。`CDK_PARAM_STAGE_NAME` で override 可能。 */
  readonly stageName: string;
  /** Lambda の reserve concurrency (`CDK_PARAM_LAMBDA_RESERVE_CONCURRENCY`、 default 1)。 */
  readonly lambdaReserveConcurrency: number;
  /** Lambda canary deployment preference (`CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE`)。 */
  readonly lambdaCanaryDeploymentPreference: string;

  /** AWS account / region (= 全 stack に揃えて env-aware にする) */
  readonly awsAccountId: string;
  readonly awsRegion: string;
  /** awsAccountId / awsRegion が両方 set されているときだけ env-aware にする stackProps fragment。 */
  readonly stackEnv: { env?: { account: string; region: string } };

  /** DynamoDB billing mode + capacity。 PROVISIONED 1/1 を Free Tier に収める。 */
  readonly dynamoBillingMode: BillingMode;
  readonly isDynamoProvisioned: boolean;
  readonly dynamoReadCapacity: number;
  readonly dynamoWriteCapacity: number;

  /**
   * KMS Key の削除待機期間。`make destroy` 後 KMS Key が "Pending Deletion" 状態のまま
   * 課金される期間 ($1/key/月) を縮めるため、AWS KMS の許容範囲 [7, 30] 内で指定する。
   *
   *   - dev / training: 7 (= 最短、課金最小化)
   *   - production: 14〜30 (= 監査要件 / 誤削除時の rollback 余地)
   *
   * `CDK_PARAM_KMS_PENDING_WINDOW_DAYS` で override し、resolve 層で `Number()` 正規化する。
   */
  readonly kmsPendingWindowInDays: number;

  /** API Key VALUE (4 tier 分。 production / staging では env 必須、 dev は deterministic default)。 */
  readonly apiKeyPlatinumTierParameter: string;
  readonly apiKeyPremiumTierParameter: string;
  readonly apiKeyStandardTierParameter: string;
  readonly apiKeyBasicTierParameter: string;
  /** SSM Parameter 名 (= bootstrap / tenant stack 間で共有)。 */
  readonly apiKeySSMParameterNames: ApiKeySSMParameterNames;

  /** Participant Portal を立てる (= `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true`) か。 */
  readonly enableParticipantPortal: boolean;
  /** Participant Portal の runtime config (event title + region)。 portal 無効時は undefined。 */
  readonly participantPortal:
    | { runtimeConfig: ParticipantPortalRuntimeConfig | "default-dev-mock" }
    | undefined;

  /** `problems/<category>/<id>/metadata.json` から auto-discovery した catalog + 各種 sub-feature。 */
  readonly problems: ProblemsCatalogBundle;

  /**
   * [Problem Packs / Issue #2462] Installed + active pack revisions to materialize into the source
   * bucket at synth time (Lite only, resolved from `.tenkacloud/pack-store` in
   * `bin/tenkacloud-lite.ts`). Undefined / empty on the default core-only path and for SaaS
   * (pooled activation wiring is #2459), so no `BucketDeployment` is added = CFn byte-identical.
   */
  readonly packAssets?: readonly PackAsset[];

  /** Issue #642: private 問題 payload を格納する bucket 名 (未設定なら undefined)。 */
  readonly challengePayloadBucketName: string | undefined;

  /**
   * TenkaCloudChallenge の publish workflow 用に S3 bucket と GitHub OIDC IAM Role を
   * 立てる構成。未設定なら ChallengePayloadStack
   * は立てない (= 旧 `CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET` env override 経路のみ動く)。
   */
  readonly challengePayload:
    | {
        readonly bucketName: string;
        readonly githubRepository: string;
        readonly githubBranches: readonly string[];
        readonly existingOidcProviderArn: string | undefined;
        readonly noncurrentExpirationDays: number | undefined;
      }
    | undefined;

  /**
   * Issue #1695: 各 SPA hosting の opt-in カスタムドメイン + ACM 証明書設定 (config.json の
   * `customDomains` をそのまま透過)。 設定された hosting のみ CloudFront viewer 最小 TLS を
   * 1.2 に強制する。 未指定は NO-OP。
   */
  readonly customDomains: CustomDomainsConfig | undefined;

  /** Bulk Deploy の CodeBuild 並列度 (未設定なら AWS account-level quota に任せる)。 */
  readonly deployConcurrentBuildLimit: number | undefined;
  /**
   * Issue #2423: score-engine / operator-attacker egress CIDRs for battle app ingress.
   * `CDK_PARAM_DEPLOY_ALLOWED_CIDRS` is comma-separated; undefined keeps single-team/local
   * deploys compatible, with a runtime warning when a template declares `AllowedCidr`.
   */
  readonly deployAllowedCidrs: readonly string[] | undefined;

  /**
   * Issue #2232: Bulk Deploy を Step Functions Distributed Map 経由で発火するか
   * (`CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP`)。 未設定 (デフォルト) は既存の legacy
   * fan-out のまま。 true にすると `BulkDeployCreateStateMachine` の DistributedMap 分岐が
   * 到達可能になる。
   */
  readonly useBulkDistributedMap: boolean;

  /**
   * Issue #2291: DeployCreate を CodeBuild ではなく Lambda CreateStack +
   * DescribeStacks poll 経路にするか (`CDK_PARAM_DEPLOY_VIA_LAMBDA`)。**default true**
   * (未設定は Lambda + poll 経路)。在来の CodeBuild 経路へ戻す場合だけ明示的に `"false"` を
   * 指定する。
   */
  readonly deployViaLambda: boolean;

  /**
   * Issue #2959: control-data DynamoDB table を stack 削除後も残すか
   * (`CDK_PARAM_RETAIN_DATA_TABLES`)。**default false (= DESTROY)**。
   *
   * 他の boolean parameter と向きが逆で、明示 `"true"` のときだけ RETAIN になる。以前は
   * 8 table すべてが RETAIN 固定で、destroy 後に残った table が PROVISIONED 1 RCU / 1 WCU で
   * 課金され続けていた。environment による分岐は入れない (= 「本番だけ消えない」を作らない)。
   */
  readonly retainDataTables: boolean;

  /**
   * Issue #2311: 監査ログ出力を deploy 時に on/off する
   * (`CDK_PARAM_AUDIT_LOG_ENABLED`)。監査行 1 write = 1 WCU 固定 table への 1 write のため、
   * 書き込みコストとのトレードオフで organizer が停止できる。**default true** (未設定 /
   * `"true"` は従来どおり出力)。明示的に `"false"` のときだけ監査 Lambda 群へ
   * `AUDIT_LOG_ENABLED="false"` を注入し `writeAuditEvent` を no-op 化する。有効時は env を
   * 足さず既存テンプレートと byte 互換 (CFn 差分 0)。
   */
  readonly auditLogEnabled: boolean;

  /**
   * Issue #2290: Events / Teams repository seam の backend を deploy 時に選ぶ
   * (`CDK_PARAM_CONTROL_DATA_BACKEND`、`dynamodb` | `turso` の二択、#2677)。**default `"dynamodb"`**
   * (未設定は在来の DDB 経路で、Lambda env を足さず CFn テンプレ byte 互換)。turso のときだけ
   * EventApi 系 Lambda に `CONTROL_DATA_BACKEND` を注入し、runtime resolver が pure SQL を選ぶ。
   */
  readonly controlDataBackend: ControlDataBackend;
  /** Public libSQL/Turso database URL, injected only into the Event API Lambda. */
  readonly tursoDatabaseUrl: string | undefined;
  /** SSM SecureString parameter name containing the Turso auth token. */
  readonly tursoAuthTokenParameterName: string | undefined;

  /**
   * #1766: tier 別の同時デプロイ上限 (`CDK_PARAM_DEPLOY_QUOTA_BY_TIER`、JSON
   * `{"basic":N,"advanced":N,"platinum":N}`)。未設定ならクォータ無効 (= 在来挙動 / Lite mode)。
   */
  readonly deployQuotaByTier:
    | { readonly basic: number; readonly advanced: number; readonly platinum: number }
    | undefined;

  /**
   * Issue #2230: SPA feature flag の deploy 時 override
   * (`CDK_PARAM_FEATURES`、JSON `{"nonAwsRuntime":true}` 形式)。runtime-config.json の
   * `features` に焼かれ、各 SPA の `resolveFeatureFlags` が registry default に merge する。
   * 未設定なら `features` key 自体を書かない (= 旧 runtime-config と byte 互換)。
   */
  readonly features: Readonly<Record<string, boolean>> | undefined;

  // Issue #1031: 旧 `adminConsoleOriginForCors` (= `CDK_PARAM_ADMIN_CONSOLE_ORIGIN`) は廃止。
  // admin-console-hosting が先に立ち、 cross-stack ref で control-plane / admin-console-insight
  // に流れる (= Phase 3 env-var dance が不要になる)。
  // Issue #1053: 旧 `competitorBootstrapTemplateUrlEnv` も同じく cross-stack ref へ移行。

  // Issue #1066: SAML IdP 連携を一度撤廃 (= MFA #1035 で代替)。
  // Issue #1335 Phase 1: 商用 enterprise 向けに opt-in declarative SAML を復活。
  // 未設定なら従来通り Cognito local auth + MFA 強制のみ。

  /**
   * Issue #1335 Phase 1: System Admin (Control Plane) 側 SAML IdP 群。 env
   * `CONTROL_PLANE_SAML_IDPS` (JSON 配列) を parse 済み。 空配列なら SAML 無効。
   */
  readonly controlPlaneSamlIdps: ReadonlyArray<{
    readonly name: string;
    readonly metadataUrl: string;
    readonly emailDomains: readonly string[];
  }>;
  /**
   * Issue #1335 Phase 1: federated 管理者 allowlist (`provider/email`)。 env
   * `CONTROL_PLANE_SAML_ADMIN_ALLOWLIST` を parse 済み。 SAML 有効時のみ意味を持つ。
   * 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  readonly controlPlaneSamlAdminAllowlist: readonly string[];

  /**
   * Issue #1340 Phase 2: per-tenant Application Plane SAML IdP 群。 env
   * `TENANT_SAML_IDPS` (JSON 配列) を parse 済み。 空配列なら SAML 無効。 pooled tier には
   * attach されない (`TenantTemplateStack` が `isPooledDeploy` を見て ignore する)。
   * silo (PLATINUM) instance / Lite mode (= 1 UserPool) のみ attach 可能。
   */
  readonly tenantSamlIdps: ReadonlyArray<{
    readonly name: string;
    readonly metadataUrl: string;
    readonly emailDomains: readonly string[];
  }>;
  /**
   * Issue #1340 Phase 2: per-tenant federated TenantAdmin allowlist (`provider/email`)。 env
   * `TENANT_SAML_ADMIN_ALLOWLIST` を parse 済み。 `tenantSamlIdps` 設定時のみ意味を持つ。
   * 空配列 = federated sign-in 全拒否 (fail-safe)。
   */
  readonly tenantSamlAdminAllowlist: readonly string[];

  /**
   * Issue #952 epic / cost guardrails: AWS Budgets monthly limit (USD)。 未指定 / 0 なら
   * budget を立てない。 全環境で既定 OFF。 必要な環境だけ明示的に設定する。
   */
  readonly monthlyCostLimitUsd: number | undefined;
  /** Budget alarm の明示的な email 宛先。 systemAdminEmail は暗黙に同梱しない。 */
  readonly budgetAlarmEmails: readonly string[] | undefined;

  /**
   * Issue #2406: scoring/cost ops monitoring. Undefined unless
   * CDK_PARAM_OPS_ALERT_EMAIL is set; the ProblemDeployBackendStack creates no monitoring
   * resources when this is undefined.
   */
  readonly opsMonitoring:
    | {
        readonly alertEmail: string;
        readonly monthlyCostLimitUsd: number;
        readonly budgetThresholdPercent: number;
      }
    | undefined;
}

export interface ProblemsCatalogBundle {
  readonly catalog: unknown;
  readonly scoring: unknown;
  /** Issue #2191: `{problemId: {ja,en}}` post-solve explanations, backend-only. */
  readonly writeups?: unknown;
  readonly endpoints: unknown;
  readonly phases: unknown;
  readonly visibility: unknown;
  /** [#2054] 非 aws/cloudformation runtime を宣言した問題のみ (`{problemId: {provider,engine,entry}}`)。 */
  readonly runtimes: unknown;
  /** Issue #888: per-problem `disruptions[]` 宣言。 未宣言の問題はキー無し。 */
  readonly disruptions: unknown;
  /** #1420: per-problem `interTeamCoordination.plugin` (`{ [problemId]: { plugin } }`)。 未宣言はキー無し。 */
  readonly coordination: unknown;
  /** #1420: `{ [problemId]: bundledMjs }` (synth-bundle 済み coordination plugin)。 */
  readonly coordinationBundles: unknown;
  /**
   * [Problem Packs / Issue #2464] `problemId → EffectiveCatalogProvenance` for pack-sourced
   * problems only. Core problems are intentionally absent (`{}` on the core-only path).
   */
  readonly provenance?: unknown;
}
