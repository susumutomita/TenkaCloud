/**
 * [Issue #1411] GCP Workload Identity Federation の **AWS provider** subject token builder.
 *
 * 決定: GCP WIF は AWS を first-class の credential source として受け付ける。 subject token は
 * **署名済 `sts:GetCallerIdentity` リクエスト**で、 deploy Lambda の AWS 実行ロール identity をそのまま
 * federate 元にする (= 署名鍵を platform 側に持たない)。 GCP STS は subject token として
 * `{url, method, headers}` を URL-encoded JSON にした形を期待し、 検証時に署名された
 * `x-goog-cloud-target-resource` ヘッダで WIF audience を確認する (google-auth-library AwsClient 互換形式)。
 *
 * 設計: 実 SigV4 署名は注入境界 (`GcpAwsSubjectTokenSigner`) に閉じ込め、 orchestration / 整形は純関数で
 * 単体テストする。 default 実装は `@smithy/signature-v4` を使い、 credentials は Lambda 実行ロール
 * (`@aws-sdk/credential-provider-node`) から解決する。 SigV4 署名の実 AWS STS / GCP WIF に対する正当性は
 * 実 account との integration / live-account verification で照合する。
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentityProvider } from "@smithy/types";

/** GCP WIF が期待する subject token の素 (URL-encode 前の構造)。 */
export interface AwsSignedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

/**
 * 署名注入境界。 region + WIF audience を受けて、 署名済 GetCallerIdentity を GCP 形式で返す。
 * default 実装は SigV4、 test では fake を渡す (= orchestration を実 AWS 呼び出し無しで pin できる)。
 */
export interface GcpAwsSubjectTokenSigner {
  sign(input: { region: string; wifAudience: string }): Promise<AwsSignedRequest>;
}

/** 署名済リクエストを GCP STS の subject token (URL-encoded JSON) に整形する純関数。 */
export function formatGcpSubjectToken(signed: AwsSignedRequest): string {
  return encodeURIComponent(JSON.stringify(signed));
}

export interface SigV4SubjectTokenSignerOptions {
  /** AWS credential provider (= Lambda 実行ロール)。 省略時 defaultProvider()。 test で fake 注入。 */
  readonly credentials?: AwsCredentialIdentityProvider;
}

/**
 * default の SigV4 署名実装。 `sts:GetCallerIdentity` を POST で署名し、 GCP が要求する
 * `x-goog-cloud-target-resource` (= WIF audience) を署名対象ヘッダに束ねる。
 */
export function createSigV4SubjectTokenSigner(
  options: SigV4SubjectTokenSignerOptions = {},
): GcpAwsSubjectTokenSigner {
  const credentials = options.credentials ?? defaultProvider();
  return {
    async sign({ region, wifAudience }) {
      const host = `sts.${region}.amazonaws.com`;
      const signer = new SignatureV4({ service: "sts", region, credentials, sha256: Sha256 });
      const request = new HttpRequest({
        method: "POST",
        protocol: "https:",
        hostname: host,
        path: "/",
        query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
        headers: {
          host,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          // GCP は WIF audience を署名済ヘッダで照合する。
          "x-goog-cloud-target-resource": wifAudience,
        },
        body: "",
      });
      const signed = await signer.sign(request);
      const headers = Object.entries(signed.headers).map(([key, value]) => ({
        key,
        value: String(value),
      }));
      return {
        url: `https://${host}/?Action=GetCallerIdentity&Version=2011-06-15`,
        method: "POST",
        headers,
      };
    },
  };
}
