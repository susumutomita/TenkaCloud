import { Annotations, Duration, Stack } from "aws-cdk-lib";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  DefinitionBody,
  DistributedMap,
  IntegrationPattern,
  type IStateMachine,
  JsonPath,
  LogLevel,
  ProcessorMode,
  ProcessorType,
  S3JsonItemReader,
  StateMachine,
  StateMachineType,
  TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import { StepFunctionsStartExecution } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

/**
 * Issue #910: bulk batch (= 1 event で N×M deployments) を **Distributed Map**
 * で並列処理する State Machine。
 *
 * 入力 shape (= \`BulkDeployCreateRequested\` event の \`detail\`。 batchId は 1 bulk 実行を
 * 識別する ULID で各 deployment の CFn stack に Tag として記録され、 tenantId は child
 * execution へ伝搬する):
 *   {
 *     batchId: "01HX...",
 *     tenantId: "tenant-acme",
 *     s3Bucket: "tenkacloud-bulk-payload-...",
 *     s3Key: "batches/01HX.../deployments.json",
 *     itemCount: 750
 *   }
 *
 * 挙動:
 *   1. \`S3JsonItemReader\` で s3Bucket/s3Key を読む (= JSON array of DeployCreateRequestedDetail)
 *   2. Distributed Map で各 item を **MaxConcurrency=50** で並列実行
 *   3. 各 child execution は \`childStateMachine\` (= 既存 \`DeployCreateStateMachine\`) を
 *      \`StartExecution\` で起動 (= 既存 single-shot logic をそのまま再利用)
 *   4. \`ToleratedFailure* 未設定\` で全 item を最後まで試す (= 失敗してもエラー扱いにせず
 * Map 全体を success で終わらせる、 継続+summary 方針)
 *
 * API が S3 に書いた batch を `BulkDeployCreateRequested` event から受け取り、既存の
 * single-deploy state machine を再利用する。
 */
export interface BulkDeployCreateStateMachineProps {
  /**
   * 子 deploy を実行する単発 State Machine。 \`DeployCreateStateMachine\` を渡す想定。
   * Distributed Map child execution が \`StartExecution\` でこれを起動する。
   */
  readonly childStateMachine: IStateMachine;
  /**
   * Bulk batch payload を保存する S3 Bucket。 \`S3JsonItemReader\` がここから読む。
   * API Lambda が batchId ごとに object を put する想定。
   */
  readonly payloadBucket: IBucket;
}

/**
 * 固定された並列度。 operator が UI で上げ下げしない (cross-account API
 * rate limit / CFn quota との均衡)。見直す場合は SLO と quota の実測を PR に添える。
 */
const MAX_CONCURRENCY = 50;

export class BulkDeployCreateStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: BulkDeployCreateStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    // Distributed Map の child execution は子 State Machine を `StartExecution` で起動する。
    // 各 item は `DeployCreateRequestedDetail` shape の JSON object。 既存 single-shot
    // State Machine は `$.detail` で受けるため、 input を `{detail: <item>}` で wrap する。
    const childInvoke = new StepFunctionsStartExecution(this, "InvokeChildDeploy", {
      stateMachine: props.childStateMachine,
      input: TaskInput.fromObject({
        detail: JsonPath.objectAt("$$.Map.Item.Value"),
      }),
      // wait なし (= async fan-out)、 各 child の終了は child 自身が DDB に書き戻すので
      // 親は item を Start するだけで次へ進む。 child execution の失敗は本 Map で catch
      // しない ("continue + summary" = 親は失敗を accumulate するだけ)。
      integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
    });

    // 失敗を error 扱いにせず最後まで試す。 ToleratedFailure* は未設定で
    // "any failure tolerated" になり、 親 execution は success で終わる。
    //
    // CDK 2.252 の DistributedMap には API duplication がある:
    //   - 新 API: \`mapExecutionType\` (= DistributedMap props、 ASL 出力で実際に使われる)
    //   - 旧 API: \`itemProcessor(processor, { executionType })\` (= MapBase.validateState で
    //     "You must specify an execution type for the distributed Map workflow" 検査される。
    //     ASL には反映されない (= DistributedMap.toStateJson が上書きで overwrite する))
    // 両方を残さないと validation で fail する一方、 両方残すと CDK が synth 時に warning
    // \`@aws-cdk/aws-stepfunctions:propertyIgnored\` を出す。 これは CDK の bug-shaped な
    // 整合不全だが、 既知の suppress 方法がある:
    // \`Annotations.of(map).acknowledgeWarning(id)\` を constructor で呼び、 後段の
    // \`addWarningV2\` に「この警告は ack 済」 と覚えさせる (= core/annotations.js の
    // \`Acknowledgements.has\` 経由で skip される)。
    const map = new DistributedMap(this, "DeployItemsMap", {
      maxConcurrency: MAX_CONCURRENCY,
      mapExecutionType: StateMachineType.STANDARD,
      itemReader: new S3JsonItemReader({
        bucket: props.payloadBucket,
        // S3 Object Key は event detail の `$.detail.s3Key` から JSONPath で解決。
        key: JsonPath.stringAt("$.detail.s3Key"),
      }),
    });

    map.itemProcessor(childInvoke, {
      mode: ProcessorMode.DISTRIBUTED,
      executionType: ProcessorType.STANDARD,
    });

    // 上記コメント参照: validation のために itemProcessor.executionType を残しつつ、
    // CDK が出す \`propertyIgnored\` warning を ack で suppress する。 register 先は **親 scope** (= \`this\`)
    // である必要がある。 CDK の \`Acknowledgements.searchPaths\` (core/annotations.js) は node path の
    // 先頭からの prefix を末尾まで含めずに reverse して返す (= 自 path は含まれず、 ancestor だけ
    // が match 対象になる) ため、 ack を child (= DistributedMap) に register しても child 自身の
    // \`addWarningV2\` では検出されない。 親に register することで child へ伝播し suppress される。
    Annotations.of(this).acknowledgeWarning("@aws-cdk/aws-stepfunctions:propertyIgnored");

    this.stateMachine = new StateMachine(this, "StateMachine", {
      stateMachineType: StateMachineType.STANDARD,
      definitionBody: DefinitionBody.fromChainable(map),
      logs: { destination: logGroup, level: LogLevel.ALL },
      timeout: Duration.hours(3),
      // Stack scope に commit して logical ID を pin (= 後続 PR で API 経路を wire するとき
      // も同 stack の同 path で参照できる)。
      stateMachineName: `${Stack.of(scope).stackName}-bulk-deploy-create`.slice(0, 79),
    });

    // S3 read 権限 (= ItemReader が GetObject + ListObjectsV2 する)。 IBucket.grantRead で
    // GetObject + ListBucket が両方付く。
    props.payloadBucket.grantRead(this.stateMachine);
    // child State Machine の StartExecution 権限 (= Distributed Map item processor が呼ぶ)。
    props.childStateMachine.grantStartExecution(this.stateMachine);
  }
}
