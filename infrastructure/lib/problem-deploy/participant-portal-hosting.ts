import * as path from "node:path";
import { Stack } from "aws-cdk-lib";
import type { Distribution } from "aws-cdk-lib/aws-cloudfront";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { buildSpaHosting, deployRuntimeConfigJson } from "../hosting/spa-hosting.js";
import type { CustomDomainConfig } from "../security/cloudfront-custom-domain.js";
import { buildSecurityHeadersPolicy } from "../security/cloudfront-headers.js";

export type ParticipantPortalMode = "dev-mock" | "backend";

export interface ParticipantPortalRuntimeConfig {
  /**
   * Portal backend (Lambda Function URL) の base URL。
   * mode="dev-mock" のときは frontend が呼ばないので空文字 OK。
   */
  readonly apiBaseUrl?: string;
  readonly eventTitle: string;
  readonly eventRegion: string;
  /**
   * "dev-mock": frontend 単体動作 (auth 偽装)。"backend": 実 backend を呼ぶ。
   */
  readonly mode: ParticipantPortalMode;
  /**
   * Issue #1420: 参加者間 coordination dispatcher の Function URL。 portal slot が
   * coordination-client で叩く。 未配線なら省略 (= coordination 無効)。
   */
  readonly coordinationApiUrl?: string;
}

const DEFAULT_DEV_MOCK_RUNTIME_CONFIG = (region: string): ParticipantPortalRuntimeConfig => ({
  eventTitle: "TenkaCloud Battle",
  eventRegion: region,
  mode: "dev-mock",
});

/**
 * 競技者向け Participant Portal を S3 + CloudFront で配信する Construct。
 *
 * 構造は ApplicationAdminConsoleHosting と同等 (S3 private + OAI + CloudFront +
 * SPA fallback)。共通スキャフォールドは `buildSpaHosting` (Issue #2207) に集約し、
 * 本 Construct は portal 固有の CSP と runtime-config exclude だけを持つ。
 * dist 供給は build pipeline (`bun run --cwd apps/participant-portal build` が
 * `apps/participant-portal/dist` に出力) が担当。
 */
export class ParticipantPortalHosting extends Construct {
  public readonly distributionDomainName: string;
  public readonly distributionUrl: string;
  private readonly bucket: Bucket;
  private readonly distribution: Distribution;

  constructor(scope: Construct, id: string, customDomain?: CustomDomainConfig) {
    super(scope, id);

    // Issue #855 + #896: CloudFront に security headers を強制。 participant-portal は teamLoginKey
    // 経路 (= bearer token 専用) で外部 Cognito は使わないが、 backend API (= Lambda Function URL
    // または API GW) への connect は許可する必要がある。 form-action は teamLoginKey login の form
    // 投稿で同 origin。
    //
    // CSP host-source の wildcard は **leftmost のみ** 仕様 (CSP3) で許可される。 旧 `*.lambda-url.*.on.aws`
    // / `*.execute-api.*.amazonaws.com` は中段 `*` を含み spec 違反、 ブラウザは silently ignore →
    // 全 fetch が \"Refused to connect by CSP\" で fail していた。 region は synth 時に inject する。
    const region = Stack.of(this).region;
    const securityHeaders = buildSecurityHeadersPolicy(this, "SecurityHeaders", {
      connectSrcAllowedOrigins: [
        `https://*.lambda-url.${region}.on.aws`,
        `https://*.execute-api.${region}.amazonaws.com`,
      ],
      frameSrcAllowedOrigins: ["https://www.youtube.com"],
    });

    const distDir = path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps",
      "participant-portal",
      "dist",
    );
    const hosting = buildSpaHosting(this, {
      distDir,
      securityHeaders,
      customDomain,
      // runtime-config.json は deployRuntimeConfig() が単独で所有する (= 実 backend Function URL を
      // 焼き、 no-cache で配る)。 dev で `apps/participant-portal/public/runtime-config.json` に置いた
      // mock が Vite build で dist に混入しても、 SPA 配信では絶対に出荷しない。 これを出荷すると
      // RuntimeConfigDeployment の実 URL を上書きし、 portal が localhost を叩いて participant 全員が
      // "Failed to fetch" になる (= 実際に起きた live 障害。 apiBaseUrl http://127.0.0.1:3199 の mock)。
      sourceExclude: ["runtime-config.json"],
      distributionPaths: ["/*"],
    });
    this.bucket = hosting.siteBucket;
    this.distribution = hosting.distribution;

    this.distributionDomainName = this.distribution.distributionDomainName;
    this.distributionUrl = `https://${this.distribution.distributionDomainName}`;
  }

  deployRuntimeConfig(config: ParticipantPortalRuntimeConfig): void {
    // Issue #867: runtime-config.json は CloudFront / browser キャッシュさせない。
    // event 切替 / mode 切替時に古い設定が残ると participant 全員の画面が壊れる。
    deployRuntimeConfigJson(
      this,
      { siteBucket: this.bucket, distribution: this.distribution },
      {
        apiBaseUrl: (config.apiBaseUrl ?? "").replace(/\/$/, ""),
        eventTitle: config.eventTitle,
        eventRegion: config.eventRegion,
        mode: config.mode,
        // #1420: coordination dispatcher URL (= 専用 Lambda)。 未配線なら key を出さない。
        ...(config.coordinationApiUrl
          ? { coordinationApiUrl: config.coordinationApiUrl.replace(/\/$/, "") }
          : {}),
      },
    );
  }
}

export { DEFAULT_DEV_MOCK_RUNTIME_CONFIG };
