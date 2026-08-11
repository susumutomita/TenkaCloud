import * as cdk from "aws-cdk-lib";
import type { Distribution } from "aws-cdk-lib/aws-cloudfront";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { deployRuntimeConfigJson } from "./hosting/spa-hosting.js";

/**
 * Issue #1031: admin-console の `runtime-config.json` を SiteBucket に配置する専用 stack。
 *
 * 旧 AdminConsoleHostingStack 内 BucketDeployment を本 stack に切り出し、 「Distribution を
 * 立てる stack」 と 「backend URL を runtime-config に焼く stack」 を分離した。 これにより:
 *   - admin-console-hosting は backend stack の cross-stack ref を持たない (= 最初に立つ)
 *   - control-plane / admin-console-insight が admin-console-hosting の distributionDomainName を
 *     prop で受ける (= 1 方向の cross-stack ref で循環依存なし)
 *   - 本 stack が backend URL + siteBucket を最後に集める (= 1 方向グラフ末端)
 *
 * Issue #867: runtime-config.json は **絶対にキャッシュさせない**。 deploy 毎に CloudFront
 * invalidation も実行する (`distributionPaths`)。
 */
export interface AdminConsoleRuntimeConfigStackProps extends cdk.StackProps {
  /** admin-console-hosting の SiteBucket (= cross-stack ref)。 */
  readonly siteBucket: Bucket;
  /** admin-console-hosting の Distribution (= invalidation 対象)。 */
  readonly distribution: Distribution;
  /** Control Plane API Gateway URL (末尾スラッシュ無し)。 */
  readonly apiUrl: string;
  /** Cognito UserPool domain (例: `https://xxx.auth.<region>.amazoncognito.com`)。 */
  readonly cognitoDomain: string;
  /** SBT 内蔵 UserPoolUserClient の client ID。 */
  readonly userClientId: string;
  /** Pooled tenant が共有する application-admin-console の CloudFront URL。 */
  readonly pooledApplicationAdminConsoleUrl: string;
  /** Provisioning ジョブを動かす CodeBuild project 名 (= SBT BashJobRunner)。 */
  readonly provisioningCodeBuildProject: string;
  /** AWS region。 */
  readonly awsRegion: string;
  /** AWS account ID。 */
  readonly awsAccountId: string;
  /** Admin Insight API のエンドポイント (Issue #590)。 */
  readonly adminInsightApiUrl: string;
  /** Issue #1053: 競技者向け bootstrap template の public S3 URL。 */
  readonly competitorBootstrapTemplateUrl: string;
  /**
   * Issue #1080: ObservabilityStack の CloudWatch Dashboard 名。 SPA 側で
   * `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#dashboards:name=<name>`
   * 形式の URL を組み立てる。
   */
  readonly cloudWatchDashboardName: string;
  /**
   * Issue #1335 Phase 1: SAML HRD directory (domain → providerName[])。 admin-console Login が
   * 未認証で読む public な metadata なので runtime-config.json に焼く。 SAML 未設定なら `{}`。
   */
  readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;
  /**
   * Issue #2230: admin-console の SPA feature flag override (例: `samlSso`)。
   * 未設定なら `features` key 自体を書かない (= 旧 runtime-config と byte 互換)。
   */
  readonly features?: Readonly<Record<string, boolean>>;
}

export class AdminConsoleRuntimeConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AdminConsoleRuntimeConfigStackProps) {
    super(scope, id, props);

    const runtimeConfig = {
      apiUrl: props.apiUrl.replace(/\/$/, ""),
      cognitoDomain: props.cognitoDomain,
      userClientId: props.userClientId,
      pooledApplicationAdminConsoleUrl: props.pooledApplicationAdminConsoleUrl,
      provisioningCodeBuildProject: props.provisioningCodeBuildProject,
      awsRegion: props.awsRegion,
      awsAccountId: props.awsAccountId,
      adminInsightApiUrl: props.adminInsightApiUrl.replace(/\/$/, ""),
      competitorBootstrapTemplateUrl: props.competitorBootstrapTemplateUrl,
      cloudWatchDashboardName: props.cloudWatchDashboardName,
      // Issue #1335 Phase 1: SAML HRD directory (= 未認証で読まれる、 admin-console Login で
      // email から候補 IdP を解決する)。 設定なし時は `{}` で焼かれる (= Login は local fallback)。
      samlIdpDirectory: props.samlIdpDirectory,
      // Issue #2230: deploy 時 feature flag override の正規経路 (手編集を置換)。
      ...(props.features ? { features: props.features } : {}),
    };

    deployRuntimeConfigJson(
      this,
      { siteBucket: props.siteBucket, distribution: props.distribution },
      runtimeConfig,
    );
  }
}
