import { Duration } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  Choice,
  Condition,
  DefinitionBody,
  type IChainable,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Pass,
  Result,
  StateMachine,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CodeBuildStartBuild,
  DynamoAttributeValue,
  DynamoUpdateItem,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { DEPLOY_STATUS_POLL_INTERVAL_SECONDS } from "./deploy-cost-model.js";
import { deploymentKey, stateEnteredTime } from "./state-machine-helpers.js";

export interface DeployDeleteStateMachineProps {
  /**
   * 実体の delete を担う CodeBuild Project (= `scripts/delete-battles.sh` を実行)。
   * `DeployCreateStateMachine` と同じ Project を共用する想定 (`OPERATION` env で
   * create / delete を分岐)。
   */
  readonly codeBuildProject?: Project;
  /**
   * Deployment 行を持つ DDB Table。CodeBuild 完了時に `status` を `DELETING` →
   * `DELETED` / `FAILED` に更新するために必要。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合
   * {@link statusWriterFunction} が必須で、native `DynamoUpdateItem` の代わりに Lambda
   * status-writer 経由で書く (= `DeployCreateStateMachine` と同型)。
   */
  readonly deploymentsTable?: ITable;
  /**
   * Issue #2291: true のとき CodeBuild を使わず、DeleteStack を行う **deploy Lambda**
   * を invoke し、DescribeStacks を polling して DELETE_COMPLETE / 消滅まで待つ。default
   * (false / 未指定) は在来の CodeBuild `.sync` path で、CFn テンプレは byte 互換。
   */
  readonly deployViaLambda?: boolean;
  /**
   * Issue #2291: DeleteStack + DescribeStacks poll を行う deploy Lambda (= create path と同じ
   * `CfnDeployLambda`; index.ts が `action` で create / delete / describe-delete を分岐)。
   * `deployViaLambda === true` のときのみ必須。CodeBuild path では未使用。
   */
  readonly cfnDeployFunction?: IFunction;
  /**
   * [Issue #2441 Phase B PR-6] When present, MarkDeleted/MarkFailed use this Lambda
   * instead of native `DynamoUpdateItem` (same `DeployStatusWriterLambda` instance
   * `DeployCreateStateMachine` uses — shared, not a second Lambda). Only the pure SQL
   * backend passes it; the default (dynamodb) backend keeps DDB direct writes
   * for byte-compatible ASL/IAM.
   */
  readonly statusWriterFunction?: IFunction;
}

type DeployDeleteStatusWriteTask = DynamoUpdateItem | LambdaInvoke;

/**
 * 問題 stack の削除を司る Step Functions State Machine。`DeployCreateStateMachine`
 * と対称な構造で、結果を DDB row に書き戻す (status: `DELETING` → `DELETED` / `FAILED`)。
 *
 * 入力 shape (event detail):
 *   {
 *     "jobId": "01HX...",
 *     "tenantId": "tenant-acme",
 *     "stackName": "tc-hello-world-demo-team",   // または StackId (ARN)
 *     "region": "ap-northeast-1",
 *     "awsAccountId": "123456789012"
 *   }
 *
 * verified deployment は `competitorRoleArn` / `externalIdParameterName` を使い、ExternalId 付き
 * AssumeRole 後に target account の stack を消す。旧 event detail は same-account fallback に倒す。
 *
 * Issue #2291: 在来 CodeBuild 経路と Lambda DeleteStack 経路の 2 branch。
 * default (deployViaLambda=false/未指定) は CodeBuild 定義を **そのまま** 生成するので、既存
 * CFn テンプレと byte 互換 (追加リソースなし)。true のときだけ Lambda + poll 定義。
 */
export class DeployDeleteStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployDeleteStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    const definitionHead = props.deployViaLambda
      ? this.buildLambdaDefinition(props)
      : this.buildCodeBuildDefinition(props);

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(definitionHead),
      timeout: Duration.minutes(60),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });

    // [Issue #2441 Phase B PR-6] Pure SQL status-writer 経路では State Machine 自身は DDB に
    // 触らない (= Lambda invoke だけ、DeployCreateStateMachine と同型)。
    if (!props.statusWriterFunction) {
      if (!props.deploymentsTable) {
        throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
      }
      props.deploymentsTable.grantWriteData(this.stateMachine);
    }
  }

  /**
   * 在来 (default) の CodeBuild `.sync` 定義。`deployViaLambda` が false / 未指定のとき使う。
   * 生成する construct ID / chain は #2291 前と完全一致させ、flag OFF の synth を byte 互換に
   * 保つ (= additive リソースは一切増やさない)。
   */
  private buildCodeBuildDefinition(props: DeployDeleteStateMachineProps): IChainable {
    const codeBuildProject = props.codeBuildProject;
    if (!codeBuildProject) {
      throw new Error("codeBuildProject is required when deployViaLambda is false");
    }
    const startCodeBuildSameAccount = new CodeBuildStartBuild(this, "StartDeleteCodeBuild", {
      project: codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        OPERATION: { value: "delete" },
        DELETE_STACK_NAME: { value: JsonPath.stringAt("$.detail.stackName") },
        DELETE_REGION: { value: JsonPath.stringAt("$.detail.region") },
        // #1797: stack が実在する account を script に渡し、credentials の account と
        // 突き合わせる。mismatch のまま delete-stack すると no-op 成功で stack が残存する。
        DELETE_EXPECTED_AWS_ACCOUNT_ID: { value: JsonPath.stringAt("$.detail.awsAccountId") },
        PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
        TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
      },
      resultPath: "$.codebuild",
    });

    const startCodeBuildCrossAccount = new CodeBuildStartBuild(
      this,
      "StartDeleteCodeBuildCrossAccount",
      {
        project: codeBuildProject,
        integrationPattern: IntegrationPattern.RUN_JOB,
        environmentVariablesOverride: {
          OPERATION: { value: "delete" },
          DELETE_STACK_NAME: { value: JsonPath.stringAt("$.detail.stackName") },
          DELETE_REGION: { value: JsonPath.stringAt("$.detail.region") },
          // #1797: AssumeRole 先が stack の account と一致するかを script 側で検証する。
          DELETE_EXPECTED_AWS_ACCOUNT_ID: { value: JsonPath.stringAt("$.detail.awsAccountId") },
          PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          COMPETITOR_ROLE_ARN: {
            value: JsonPath.stringAt("$.detail.competitorRoleArn"),
          },
          EXTERNAL_ID_SSM_PARAMETER: {
            value: JsonPath.stringAt("$.detail.externalIdParameterName"),
          },
        },
        resultPath: "$.codebuild",
      },
    );

    const invalidAssumeRoleMetadata = new Pass(this, "InvalidAssumeRoleMetadata", {
      result: Result.fromObject({
        Cause:
          "detail must include awsAccountId, and competitorRoleArn / externalIdParameterName must be provided together",
      }),
      resultPath: "$.error",
    });

    // #1797: 両 CodeBuild state が $.detail.awsAccountId を JsonPath 参照するため、
    // 欠損 event をそのまま流すと States.Runtime (= addCatch で捕捉不能) で execution が
    // 死に、行が DELETING のまま stuck する。isPresent ガードで markFailed 経路 (捕捉可能な
    // loud fail) に倒す。Lambda producer は常に詰めるので、ここに来るのは replay / 手動
    // put-events 等の壊れた event のみ。
    const routeDeleteInput = new Choice(this, "RouteDeleteInput")
      .when(
        Condition.and(
          Condition.isPresent("$.detail.awsAccountId"),
          Condition.isPresent("$.detail.competitorRoleArn"),
          Condition.isPresent("$.detail.externalIdParameterName"),
        ),
        startCodeBuildCrossAccount,
      )
      .when(
        Condition.and(
          Condition.isPresent("$.detail.awsAccountId"),
          Condition.not(Condition.isPresent("$.detail.competitorRoleArn")),
          Condition.not(Condition.isPresent("$.detail.externalIdParameterName")),
        ),
        startCodeBuildSameAccount,
      )
      .otherwise(invalidAssumeRoleMetadata);

    const markDeleted = this.buildMarkDeleted(props.deploymentsTable, props.statusWriterFunction);
    const markFailed = this.buildMarkFailed(props.deploymentsTable, props.statusWriterFunction);

    startCodeBuildSameAccount.addCatch(markFailed, { resultPath: "$.error" });
    startCodeBuildCrossAccount.addCatch(markFailed, { resultPath: "$.error" });
    startCodeBuildSameAccount.next(markDeleted);
    startCodeBuildCrossAccount.next(markDeleted);
    invalidAssumeRoleMetadata.next(markFailed);

    return routeDeleteInput;
  }

  /**
   * Issue #2291: Lambda DeleteStack + DescribeStacks poll 定義。
   * `deployViaLambda === true` のときだけ生成する (additive; default synth には現れない)。
   *
   * flow: InvokeCfnDelete (DeleteStack を投げて即 return) → Wait → DescribeDeleteStatus (poll) →
   *   RoutePollStatus:
   *     - DELETE_COMPLETE (消滅は handler が DELETE_COMPLETE に正規化) → MarkDeleted
   *     - DELETE_FAILED                                              → MarkFailed (StackStatusReason)
   *     - それ以外 (DELETE_IN_PROGRESS 等)                            → Wait へ戻り polling を継続
   *
   * `DeployCreateStateMachine` の Lambda branch と対称。create branch が routeCreateInput Choice を
   * handler に collapse したのと同様、same-account / cross-account の分岐は Lambda 内 (=
   * assumeCompetitorRole) が担う。`$.detail.awsAccountId` は handler の #1797 account 検証で
   * load-bearing のまま残し、欠損 event は DeployDeleteRequestedDetailSchema の Zod parse が
   * loud fail → addCatch → MarkFailed に倒す (= CodeBuild path の isPresent ガードと同等安全)。
   *
   * DDB の status 遷移 (DELETING→DELETED/FAILED) は CodeBuild path と同一契約。buildId は
   * CodeBuild 固有なので Lambda path では書かない (MarkDeleted / MarkFailed は元から buildId 非依存)。
   */
  private buildLambdaDefinition(props: DeployDeleteStateMachineProps): IChainable {
    const cfnDeployFunction = props.cfnDeployFunction;
    if (!cfnDeployFunction) {
      throw new Error("cfnDeployFunction is required when deployViaLambda is true");
    }

    // DeleteStack を投げて即 return する deploy Lambda。detail (元 EventBridge event の detail) と
    // action=delete を渡す。payloadResponseOnly で $.delete は Lambda response ({ deleted }) になる。
    const invokeCfnDelete = new LambdaInvoke(this, "InvokeCfnDelete", {
      lambdaFunction: cfnDeployFunction,
      payload: TaskInput.fromObject({ action: "delete", detail: JsonPath.objectAt("$.detail") }),
      payloadResponseOnly: true,
      resultPath: "$.delete",
    });

    // DeleteStack は async。反映まで少し待ってから DescribeStacks を叩く。間隔は
    // deploy-cost-model.ts の共有定数 (30s) で create path の poll loop と同値。
    const waitBeforePoll = new Wait(this, "WaitBeforePoll", {
      time: WaitTime.duration(Duration.seconds(DEPLOY_STATUS_POLL_INTERVAL_SECONDS)),
    });

    // 同 Lambda を action=describe-delete で invoke。消滅は handler が DELETE_COMPLETE に正規化する。
    // $.cfn は DescribeStacks 相当 output (= create path の DescribeStack と同じ shape)。
    const describeDeleteStatus = new LambdaInvoke(this, "DescribeDeleteStatus", {
      lambdaFunction: cfnDeployFunction,
      payload: TaskInput.fromObject({
        action: "describe-delete",
        detail: JsonPath.objectAt("$.detail"),
      }),
      payloadResponseOnly: true,
      resultPath: "$.cfn",
    });

    const markDeleted = this.buildMarkDeleted(props.deploymentsTable, props.statusWriterFunction);
    const markFailed = this.buildMarkFailed(props.deploymentsTable, props.statusWriterFunction);
    const useStackStatusReasonAsFailureCause = new Pass(
      this,
      "UseStackStatusReasonAsFailureCause",
      {
        parameters: { "Cause.$": "$.cfn.Stacks[0].StackStatusReason" },
        resultPath: "$.error",
      },
    );
    useStackStatusReasonAsFailureCause.next(markFailed);

    const routePollStatus = new Choice(this, "RoutePollStatus")
      .when(Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "DELETE_COMPLETE"), markDeleted)
      .when(
        Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "DELETE_FAILED"),
        useStackStatusReasonAsFailureCause,
      )
      // それ以外 (DELETE_IN_PROGRESS 等の中間状態) は poll を継続。
      .otherwise(waitBeforePoll);

    // InvokeCfnDelete / DescribeDeleteStatus のいずれの失敗も FAILED に倒す。$.error.Cause に
    // States.TaskFailed の Cause (= Zod parse fail / account mismatch / DeleteStack error) が入る。
    invokeCfnDelete.addCatch(markFailed, { resultPath: "$.error" });
    describeDeleteStatus.addCatch(markFailed, { resultPath: "$.error" });

    invokeCfnDelete.next(waitBeforePoll);
    waitBeforePoll.next(describeDeleteStatus);
    describeDeleteStatus.next(routePollStatus);

    return invokeCfnDelete;
  }

  /**
   * [Issue #2441 Phase B PR-6] Shared status-writer invoke builder, mirroring
   * `DeployCreateStateMachine.buildStatusWriterInvoke`. `retryOnServiceExceptions:
   * false` matches the explicit-retry-free `DynamoUpdateItem` tasks it replaces.
   */
  private buildStatusWriterInvoke(
    id: string,
    payload: Record<string, unknown>,
    statusWriterFunction: IFunction,
  ): LambdaInvoke {
    return new LambdaInvoke(this, id, {
      lambdaFunction: statusWriterFunction,
      payload: TaskInput.fromObject(payload),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
    });
  }

  private buildMarkDeleted(
    table: ITable | undefined,
    statusWriterFunction?: IFunction,
  ): DeployDeleteStatusWriteTask {
    if (statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        "MarkDeleted",
        {
          transition: "markDeleted",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
        },
        statusWriterFunction,
      );
    }
    if (!table) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, "MarkDeleted", {
      table,
      key: deploymentKey(),
      // GSI2PK / GSI2SK を REMOVE して participant portal の lookup index から sparse 除外する。
      // expiresAt は TTL 用に十分小さい値で残し、DDB 側でも自動掃除させる。
      updateExpression: "SET #status = :status, updatedAt = :updatedAt REMOVE GSI2PK, GSI2SK",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("DELETED"),
        ":updatedAt": stateEnteredTime(),
      },
    });
  }

  private buildMarkFailed(
    table: ITable | undefined,
    statusWriterFunction?: IFunction,
  ): DeployDeleteStatusWriteTask {
    if (statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        "MarkFailed",
        {
          transition: "markFailed",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
          failureReason: JsonPath.stringAt("$.error.Cause"),
        },
        statusWriterFunction,
      );
    }
    if (!table) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, "MarkFailed", {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason",
      expressionAttributeNames: {
        "#status": "status",
        "#failureReason": "failureReason",
      },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("FAILED"),
        ":updatedAt": stateEnteredTime(),
        ":failureReason": DynamoAttributeValue.fromString(JsonPath.stringAt("$.error.Cause")),
      },
    });
  }
}
