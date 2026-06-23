import { Certificate, type ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { SecurityPolicyProtocol } from "aws-cdk-lib/aws-cloudfront";
import type { Construct } from "constructs";

/**
 * Issue #1695 (元監査 13 / 14): CloudFront の viewer 最小 TLS を 1.2 に上げる opt-in 機構。
 *
 * **背景**: default の `*.cloudfront.net` 証明書のままでは CloudFront 側が TLS の floor を
 * 管理しており、 CDK から `minimumProtocolVersion` を上げられない (= TLS 1.0/1.1 が legacy SNI
 * 向けに許容される)。 確実に 1.0/1.1 を切るには **カスタムドメイン + ACM 証明書** が前提。
 *
 * 本ヘルパは 3 つの SPA hosting (admin-console / application-admin-console / participant-portal)
 * が共有する。 `config` が与えられたときだけ `domainNames` + `certificate` +
 * `minimumProtocolVersion = TLS_V1_2_2021` を返し、 未設定 (= ドメイン未用意) なら空 props を
 * 返して現状の default 証明書配信を維持する (= NO-OP、 既存デプロイの挙動不変)。
 */
export interface CustomDomainConfig {
  /** viewer ドメイン名 (例: `console.tenkacloud.cloud`)。 */
  readonly domainName: string;
  /**
   * ACM 証明書 ARN。 **CloudFront 仕様で us-east-1 の証明書でなければならない**。
   * cross-stack / 既存証明書の import を前提に ARN で受ける。
   */
  readonly certificateArn: string;
}

/**
 * 3 SPA の CloudFront カスタムドメイン + 2 プレーンの Cognito ログイン カスタムドメイン
 * (任意)。 未指定の hosting / login は default 証明書・cognito-prefix domain のまま。
 */
export interface CustomDomainsConfig {
  readonly adminConsole?: CustomDomainConfig;
  readonly applicationAdminConsole?: CustomDomainConfig;
  readonly participantPortal?: CustomDomainConfig;
  /** Issue #1993: Control Plane (System Admin) の Cognito ログイン カスタムドメイン。 */
  readonly controlPlaneLogin?: CustomDomainConfig;
  /** Issue #1993 / #1994: Application Plane (tenant、 pooled / silo) のログイン カスタムドメイン。 */
  readonly applicationLogin?: CustomDomainConfig;
}

export interface CustomDomainDistributionProps {
  readonly domainNames?: string[];
  readonly certificate?: ICertificate;
  readonly minimumProtocolVersion?: SecurityPolicyProtocol;
}

/**
 * `config` があれば custom domain + ACM 証明書 + TLS 1.2 強制の Distribution props を返す。
 * 未設定 / `domainName` 空文字 (= placeholder 展開で未設定) のときは `{}` (NO-OP) を返す。
 */
export function buildCustomDomainDistributionProps(
  scope: Construct,
  id: string,
  config: CustomDomainConfig | undefined,
): CustomDomainDistributionProps {
  if (!config || config.domainName.trim() === "" || config.certificateArn.trim() === "") {
    return {};
  }
  return {
    domainNames: [config.domainName],
    certificate: Certificate.fromCertificateArn(scope, id, config.certificateArn),
    minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
  };
}
