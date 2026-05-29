import { ApiKey } from "aws-cdk-lib/aws-apigateway";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

interface TenantApiKeyProps {
  ssmParameterApiKeyIdName: string;
  ssmParameterApiValueName: string;
}

/**
 * #1384: 旧実装は API キーの値を synth 時の plaintext 文字列で受け取り、
 *   - `new ApiKey({ value })` → `AWS::ApiGateway::ApiKey.Value` に焼き込み、
 *   - `new StringParameter({ stringValue })` → `AWS::SSM::Parameter` (Type:String) に焼き込んで
 * いた。 どちらも synthesized template に **平文で出力** され、 `GetTemplate` / `cdk.out` /
 * source bundle から鍵が回収できた (CFn は `AWS::ApiGateway::ApiKey.Value` に
 * `{{resolve:ssm-secure}}` を許さず dynamic ref でも隠せない)。
 *
 * 実際にはこの API キーの **値はどこからも使われていない**: tenant API は Cognito JWT 認証で、
 * `api-gateway.ts` は tier キー prop を宣言するだけで参照せず、 Lite mode は値に placeholder を
 * 渡している。 よって API Gateway に値を **auto-generate** させ (= template に平文が出ない)、 値の
 * SSM パラメータには平文鍵の代わりに非機密 placeholder を入れる。 keyId は従来どおり保存する。
 */
const API_KEY_VALUE_NOT_EXPOSED = "auto-generated-by-api-gateway-not-exposed";

export class TenantApiKey extends Construct {
  constructor(scope: Construct, id: string, props: TenantApiKeyProps) {
    super(scope, id);

    // value を省略すると API Gateway が鍵値を生成する (= template に平文が出ない)。
    const apiKey = new ApiKey(this, "apiKey", {});
    new StringParameter(this, "apiKeyId", {
      parameterName: props.ssmParameterApiKeyIdName,
      stringValue: apiKey.keyId,
    });

    // 値パラメータは vestigial な downstream 配線 (api-gateway は未参照) のため残すが、
    // 平文鍵ではなく非機密 placeholder を入れる (= 鍵値は API Gateway 管理、 template 非露出)。
    new StringParameter(this, "apiKeyValue", {
      parameterName: props.ssmParameterApiValueName,
      stringValue: API_KEY_VALUE_NOT_EXPOSED,
    });
  }
}
