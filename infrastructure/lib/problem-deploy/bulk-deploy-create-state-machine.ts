import { Duration, Stack } from "aws-cdk-lib";
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
 * Issue #910 (#895 Phase 2.C): bulk batch (= 1 event で N×M deployments) を **Distributed Map**
 * で並列処理する State Machine。
 *
 * 入力 shape (= \`BulkDeployCreateRequestedDetail\`):
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
 *      Map 全体を success で終わらせる、 ADR-001 §4 の継続+summary 方針)
 *
 * Phase 2.C.1 (= 本 PR、 foundation only):
 *   - State Machine construct + S3 ItemReader + EventBridge Rule を CDK で確立
 *   - API 側の bulk-deploy handler refactor (= S3 PutObject + BulkDeployCreateRequested
 *     publish) は **本 PR 範囲外**。 既存 fan-out も削除しない (= 旧 経路は残し、
 *     新 経路を coexist させる)
 *
 * Phase 2.C.2 (= 別 PR):
 *   - \`bulk-deploy.ts\` の fan-out を撤廃して S3 write + 1 event publish に書き換え
 *   - result aggregation (= failedItems[] を親が返す)
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
 * ADR-001 §3 で固定された並列度。 operator が UI で上げ下げしない (= cross-account API
 * rate limit / CFn quota との均衡)。 SLO 評価で見直すなら本 ADR を update する。
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
      // しない (= ADR-001 §4 "continue + summary" = 親は失敗を accumulate するだけ)。
      integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
    });

    // ADR-001 §4: 失敗を error 扱いにせず最後まで試す。 ToleratedFailure* は未設定で
    // "any failure tolerated" になり、 親 execution は success で終わる。
    //
    // CDK 2.252 の DistributedMap は inconsistent API:
    //   - 新 API: \`mapExecutionType\` (= DistributedMap props、 ASL 出力で使われる)
    //   - 旧 API: \`itemProcessor(processor, { executionType })\` (= ASL に影響しないが
    //     validation がここを check する。 無いと synth error \"You must specify an
    //     execution type for the distributed Map workflow\")
    // 両方指定すると CDK が \"ProcessorConfig.executionType is ignored\" warning を出すが、
    // 旧 API を消すと validation で fail するため両方指定する。 warning は informational
    // (= ASL 上の挙動は \`mapExecutionType\` が支配的、 実行に影響なし) で受け入れる。
    // CDK の \`Annotations.acknowledgeWarning\` は 2.252 で この warning タイプを suppress
    // しないため、 cosmetic な log noise として残る。 upstream で API 整合される将来 CDK
    // upgrade 時に旧 API を撤廃する。
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
