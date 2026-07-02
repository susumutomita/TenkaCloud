import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import type { Distribution } from "aws-cdk-lib/aws-cloudfront";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { buildSpaHosting } from "./hosting/spa-hosting.js";
import type { CustomDomainConfig } from "./security/cloudfront-custom-domain.js";
import { buildSecurityHeadersPolicy } from "./security/cloudfront-headers.js";

/**
 * Issue #1031: admin-console-hosting は **CloudFront 配信側だけ** を担い、 runtime-config.json
 * の生成は `AdminConsoleRuntimeConfigStack` に分離した。 これにより依存方向を 1 方向
 * (= 本 stack → control-plane / admin-console-insight → runtime-config) に揃え、
 * `bun cdk deploy --all` 1 発で install.sh が完結する。
 *
 * CSP は backend URL を **wildcard pattern** で許可する。 これによりバックエンド URL の
 * cross-stack ref を本 stack から外して循環依存を解消する。 trade-off:
 *   - 旧: `<specific-execute-api-id>.execute-api.<region>.amazonaws.com` を厳密 allow
 *   - 新: `https://*.execute-api.<region>.amazonaws.com` で region 内全 API GW を allow
 * 同 region 別 API GW を悪用するには (a) admin-console XSS 注入 (b) 同 account に攻撃 API 所持 の
 * 両条件が要り、 hosting 単独 deploy 可能性を取って良い trade。
 *
 * 旧 admin-console-hosting にあった `competitor-bootstrap.yaml` の S3 host は Issue #1053 で
 * ProblemDeployBackendStack 配下に移管済。
 */
export interface AdminConsoleHostingStackProps extends cdk.StackProps {
  /**
   * Issue #1695: opt-in のカスタムドメイン + ACM 証明書。 設定時のみ TLS 1.2 を強制する
   * (= `minimumProtocolVersion = TLS_V1_2_2021`)。 未設定なら default 証明書配信のまま (NO-OP)。
   */
  readonly customDomain?: CustomDomainConfig;
}

export class AdminConsoleHostingStack extends cdk.Stack {
  public readonly distributionDomainName: string;
  /**
   * Issue #1031: `AdminConsoleRuntimeConfigStack` が runtime-config.json をこの bucket に
   * BucketDeployment する。 cross-stack ref で受け渡す。
   */
  public readonly siteBucket: Bucket;
  /**
   * Issue #1031: runtime-config.json 更新時の CloudFront 無効化 (= `distributionPaths`) 用。
   */
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: AdminConsoleHostingStackProps) {
    super(scope, id, props);

    // Issue #1031: CSP は region wildcard。 詳細は file header 参照。
    const region = cdk.Stack.of(this).region;
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        `https://*.execute-api.${region}.amazonaws.com`,
        "https://*.amazoncognito.com",
        `https://cognito-idp.${region}.amazonaws.com`,
      ],
      formActionAllowedOrigins: ["https://*.amazoncognito.com"],
    });

    // dist/ をアップロード (URL 非依存の静的ファイル)。共通スキャフォールドは
    // buildSpaHosting (Issue #2207) に集約。 runtime-config.json は別 stack が書く。
    const distDir = path.join(import.meta.dirname, "..", "..", "apps", "admin-console", "dist");
    const hosting = buildSpaHosting(this, {
      distDir,
      securityHeaders,
      customDomain: props.customDomain,
    });
    this.siteBucket = hosting.siteBucket;
    this.distribution = hosting.distribution;

    this.distributionDomainName = this.distribution.distributionDomainName;

    new cdk.CfnOutput(this, "AdminConsoleUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
      description:
        "admin-console の CloudFront URL。 control-plane / admin-console-insight に cross-stack ref で渡る (= callback / CORS 経路で消費)",
    });
  }
}
