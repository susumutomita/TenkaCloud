import { Duration } from "aws-cdk-lib";
import {
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import type { Construct } from "constructs";

/**
 * Issue #855: 3 SPA (admin-console / application-admin-console / participant-portal) の
 * CloudFront Distribution に適用する security headers の正本 helper。
 *
 * 適用される headers:
 *   - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload (= HSTS、 downgrade 防御)
 *   - X-Frame-Options: DENY (= clickjacking 防御、 CSP frame-ancestors と二重防御)
 *   - X-Content-Type-Options: nosniff (= MIME sniffing XSS 防御)
 *   - Referrer-Policy: strict-origin-when-cross-origin (= cross-origin referrer leak 防御)
 *   - Content-Security-Policy: SPA ごとに connect-src を override する (= Cognito / API GW 経路)
 *
 * CSP 設計 (= 最小許容):
 *   - default-src 'self' (= 同 origin のみ)
 *   - script-src 'self' (= 'unsafe-inline' / 'unsafe-eval' なし、 Vite bundle が出すモジュール JS のみ)
 *   - style-src 'self' 'unsafe-inline' (= Cloudscape Design System が inline style を注入する制約、
 *     hash / nonce 化は Phase 2 で別 issue)
 *   - img-src 'self' data: (= Cloudscape の base64 inline icon)
 *   - font-src 'self' data: (= 同上)
 *   - connect-src は SPA ごとに override (= caller が apiOrigins / cognitoDomain を渡す)
 *   - frame-src は default `'self'`、 必要な SPA だけ外部 embed origin を追加
 *   - frame-ancestors 'none' (= clickjacking 防御、 X-Frame-Options より厳格)
 *   - form-action 'self' (= 同 origin の form submit のみ、 phishing 経路を狭める)
 *   - base-uri 'self' (= <base> tag 操作による URL hijack 防御)
 *
 * 既知制約:
 *   - Cloudscape の inline style を 'unsafe-inline' で許容している。 厳格化は別 issue
 *   - script-src nonce 化は Vite 4.x で SSR 経路が無いと困難、 別 issue
 */
export interface SecurityHeadersOptions {
  /**
   * CSP connect-src で許可する外部 origin (= SPA から fetch する API + auth)。 \`'self'\` は自動付与
   * されるので caller は同 origin を含めない。 例:
   *   - \`["https://*.amazoncognito.com", "https://*.execute-api.ap-northeast-1.amazonaws.com"]\`
   */
  readonly connectSrcAllowedOrigins?: readonly string[];
  /**
   * CSP form-action で許可する外部 origin (= Cognito Hosted UI の sign-in form 経路)。
   * 通常は Cognito domain を含める。
   */
  readonly formActionAllowedOrigins?: readonly string[];
  /**
   * dev mode で \`unsafe-eval\` を許可するか (= Vite HMR が dev で eval を使う場合)。
   * production では必ず false にする。 default false。
   */
  readonly allowUnsafeEval?: boolean;
  /**
   * Issue #899: SPA 内で外部 CDN 由来の script を読み込む場合の追加 allow-list。
   * 例: API reference (Scalar) を CDN から読み込むときの \`https://cdn.jsdelivr.net\`。
   * 同時に \`style-src\` にも追加 (Scalar が inline 風 CSS を出すため一部 CDN style も必要)。
   */
  readonly additionalScriptSrcs?: readonly string[];
  /**
   * CSP frame-src で許可する外部 origin。 未指定時は同 origin の iframe のみに閉じる。
   */
  readonly frameSrcAllowedOrigins?: readonly string[];
}

/**
 * 共通 ResponseHeadersPolicy を作る。 3 hosting stack から同 helper を呼ぶ。
 * scope / id は CDK convention に従い caller が決める (= per-stack で unique にする)。
 */
export function buildSecurityHeadersPolicy(
  scope: Construct,
  id: string,
  opts: SecurityHeadersOptions = {},
): ResponseHeadersPolicy {
  const csp = buildContentSecurityPolicy(opts);
  return new ResponseHeadersPolicy(scope, id, {
    securityHeadersBehavior: {
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(730),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: {
        frameOption: HeadersFrameOption.DENY,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
      contentSecurityPolicy: {
        contentSecurityPolicy: csp,
        override: true,
      },
    },
  });
}

/**
 * CSP 文字列を組み立てる pure helper。 test しやすい (= options で挙動が決まる)。
 */
export function buildContentSecurityPolicy(opts: SecurityHeadersOptions = {}): string {
  const additionalScripts = opts.additionalScriptSrcs ?? [];
  const connectSrc = ["'self'", ...(opts.connectSrcAllowedOrigins ?? []), ...additionalScripts];
  const formAction = ["'self'", ...(opts.formActionAllowedOrigins ?? [])];
  const scriptSrc = opts.allowUnsafeEval
    ? ["'self'", "'unsafe-eval'", ...additionalScripts]
    : ["'self'", ...additionalScripts];
  const styleSrc = ["'self'", "'unsafe-inline'", ...additionalScripts];
  const frameSrc = ["'self'", ...(opts.frameSrcAllowedOrigins ?? [])];
  const directives: readonly string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    `form-action ${formAction.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}
