import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { FunctionUrl } from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import { EvalApiLambda } from "./eval-api-lambda.js";
import { EvalRunsTable } from "./eval-runs-table.js";

export interface EndpointEvalStackProps extends StackProps {
  /**
   * クリアコード署名鍵を置く SSM SecureString パラメータ名。 ExternalId と同じく operator が
   * 事前に 1 度だけ作る (`aws ssm put-parameter --type SecureString`)。 stack 内で値は持たない
   * (= no Secrets Manager / 秘密を CFn に埋めない)。
   */
  readonly signingSecretParamName: string;
}

/**
 * Issue #1973: endpoint-eval バックエンドの単独スタック (DDB + Function URL Lambda)。
 *
 * 既存スタックのリソースには一切触れない additive な構成。 ローカルバックエンドと同じ
 * `@tenkacloud/endpoint-eval` の Hono app を Lambda に載せ、 RunRepository を DDB 実装に差す。
 */
export class EndpointEvalStack extends Stack {
  public readonly evalApiUrl: FunctionUrl;

  constructor(scope: Construct, id: string, props: EndpointEvalStackProps) {
    super(scope, id, props);

    const runsTable = new EvalRunsTable(this, "EvalRuns");
    const evalApi = new EvalApiLambda(this, "EvalApi", {
      runsTable: runsTable.table,
      signingSecretParamName: props.signingSecretParamName,
    });
    this.evalApiUrl = evalApi.url;

    new CfnOutput(this, "EvalApiUrl", {
      value: evalApi.url.url,
      description: "endpoint-eval Function URL (POST /runs, POST /runs/{id}/evaluations)",
    });
  }
}
