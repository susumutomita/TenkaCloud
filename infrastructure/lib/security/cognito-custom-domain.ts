import { aws_cognito } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CustomDomainConfig } from "./cloudfront-custom-domain.js";

/**
 * Issue #1993 / #1994: Cognito ログイン (managed login) 用のカスタムドメインを param-gated で
 * 足す。 `config` 未設定 / `domainName` or `certificateArn` 空 (= placeholder 展開で未設定) の
 * ときは `undefined` (NO-OP) を返す ── default deploy は従来の cognito-prefix domain のまま。
 *
 * 作成する `CfnUserPoolDomain` は `managedLoginVersion=2` (= #1991 / #1992 と同じ managed login)。
 * Cognito の user pool は cognito-prefix domain と custom domain を併存できる (= 別 UserPoolDomain
 * リソース)。 cert は **CloudFront 同様 us-east-1 必須** ([[CustomDomainConfig]] の制約)。
 *
 * 注 (operator 検証): Cognito の custom domain は作成時に **親ドメインの DNS A レコード**を要求し、
 * 作成後に **Cognito CloudFront への DNS alias** が必要。 cert / DNS は operator が用意する前提で、
 * 本関数は ARN + ドメイン名を受けるだけ (= CI synth は config 未設定で NO-OP、 実 deploy で活性化)。
 */
export function attachCognitoCustomLoginDomain(
  scope: Construct,
  id: string,
  opts: { readonly userPoolId: string; readonly config?: CustomDomainConfig },
): aws_cognito.CfnUserPoolDomain | undefined {
  const config = opts.config;
  if (!config || config.domainName.trim() === "" || config.certificateArn.trim() === "") {
    return undefined;
  }
  return new aws_cognito.CfnUserPoolDomain(scope, id, {
    userPoolId: opts.userPoolId,
    domain: config.domainName,
    customDomainConfig: { certificateArn: config.certificateArn },
    managedLoginVersion: 2,
  });
}
