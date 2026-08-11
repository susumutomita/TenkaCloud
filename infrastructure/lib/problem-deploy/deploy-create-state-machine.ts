import { Duration } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import type { IEventBus } from "aws-cdk-lib/aws-events";
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
  EventBridgePutEvents,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import {
  DEPLOY_STATE_MACHINE_TIMEOUT_MINUTES,
  DEPLOY_STATUS_POLL_INTERVAL_SECONDS,
} from "./deploy-cost-model.js";
import { deploymentKey, stateEnteredTime } from "./state-machine-helpers.js";

export interface DeployCreateStateMachineProps {
  /** 実体の deploy を担う CodeBuild Project (= `scripts/deploy-battles.sh` を実行)。 */
  readonly codeBuildProject?: Project;
  /**
   * CodeBuild 完了後に competitor account 側の CloudFormation stack を読む Lambda。
   * verified deployment は ExternalId 付き AssumeRole が必要なため、Step Functions の
   * platform-account CallAwsService ではなく Lambda に閉じ込める。
   */
  readonly describeStackFunction: IFunction;
  /**
   * Deployment 行を持つ DDB Table。CodeBuild 完了時に `status` を `PENDING` →
   * `COMPLETE` / `FAILED` に更新するために必要。
   *
   * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のとき
   * `ProblemDeployBackendStack` は本 table を synth しない (= `undefined`)。その場合
   * {@link statusWriterFunction} が必須で、本 table は一切参照されない。
   */
  readonly deploymentsTable?: ITable;
  /**
   * Issue #2291: true のとき CodeBuild を使わず、CreateStack を行う **deploy Lambda**
   * を invoke し、`describeStackFunction` で DescribeStacks を polling して terminal まで待つ。
   * default (false / 未指定) は在来の CodeBuild `.sync` path で、CFn テンプレは byte 互換。
   */
  readonly deployViaLambda?: boolean;
  /**
   * Issue #2291: CreateStack を行う deploy Lambda (= {@link CfnDeployLambda})。
   * `deployViaLambda === true` のときのみ必須。CodeBuild path では未使用。
   */
  readonly cfnDeployFunction?: IFunction;
  /**
   * Issue #2291: SBT 共通 EventBus。Lambda path 失敗時に `TenkaCloud Deploy Failed` を PutEvents し、`SystemAuditWriterLambda` が `deploy_failed` 行に集約する。ON のときのみ必須。
   */
  readonly eventBus?: IEventBus;
  /**
   * [Issue #2441 Phase B PR-5] When present, the four DeployCreate status write
   * states use this Lambda instead of native DynamoUpdateItem. Only the pure SQL
   * backend passes it; the default (dynamodb) backend keeps DDB direct
   * writes for byte-compatible ASL/IAM.
   */
  readonly statusWriterFunction?: IFunction;
}

type DeployStatusWriteTask = DynamoUpdateItem | LambdaInvoke;

/**
 * 問題 deploy 起動を司る Step Functions State Machine。
 *
 * SBT `ScriptJob` 同型: `CodeBuildStartBuild` task (`RUN_JOB` integration = `.sync`)
 * で deploy script の完了を待ち、結果を DDB row に書き戻す。
 *
 * 入力 shape (event detail):
 *   {
 *     "jobId": "01HX...",
 *     "tenantId": "tenant-acme",
 *     "problemDir": "problems/challenges/hello-world",
 *     "teamSlug": "demo-team",
 *     "namePrefix": "tc-hello-world-demo-team",
 *     "region": "ap-northeast-1",
 *     "awsAccountId": "123456789012"
 *   }
 *
 * single-shot deploy のみ。Distributed Map による bulk 化と、
 * `cloudformation:describeStacks` による stackOutputs / stackId の取り込みは Phase 2。
 *
 * Issue #909 (#895): \"Create / Update / Delete の 3 state machine\"
 * を提示したが、 実装では **Create と Update を 1 state machine に collapse** している。
 * 理由: \`deploy-battles.sh\` が \`aws cloudformation deploy\` を使っており、 これが
 * CREATE / UPDATE を **idempotent** に扱う (= stack が無ければ Create、 あれば Update、
 * 差分無しは no-op で 0 終了)。 別 Update state machine を立てても操作上の差は無く、
 * 維持対象が増えるだけ。
 *
 * 残る semantics:
 *   - Delete: \`DeployDeleteStateMachine\` (= 別ファイル) で分離。 CFn API が異なるため
 *   - Create-or-Update: 本 state machine が両方を担当
 *
 * Update 専用 API (\`POST /deployments/update\`) も同様に不要。 同 deployment row への
 * 再 POST が事実上 update として動く (= deploy.ts handler 側で jobId 既存なら新 stack 名
 * 衝突を避ける仕組みが必要なら handler 側に追加するが、 state machine 設計とは独立)。
 */
export class DeployCreateStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployCreateStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    // PENDING (deploy.ts が初期 row を書く時の値) を IN_PROGRESS に倒す。CodeBuild の
    // RUN_JOB は同期で 5〜15 分待つので、この中間遷移が無いと operator UI は polling
    // しても PENDING のまま固定で「動いていない」ように見える (実際は deploy 進行中)。
    const markInProgress = this.buildMarkInProgress(props);

    // Issue #2291: 在来 CodeBuild 経路と Lambda CreateStack 経路の 2 branch。
    // default (deployViaLambda=false/未指定) は CodeBuild 定義を **そのまま** 生成するので、
    // 既存 CFn テンプレと byte 互換 (追加リソースなし)。true のときだけ Lambda + poll 定義。
    const definitionHead = props.deployViaLambda
      ? this.buildLambdaDefinition(props, markInProgress)
      : this.buildCodeBuildDefinition(props, markInProgress);

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(definitionHead),
      timeout: Duration.minutes(DEPLOY_STATE_MACHINE_TIMEOUT_MINUTES),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });

    // DynamoUpdateItem task は CDK 側で grant しないので明示。Pure SQL status-writer 経路では
    // State Machine 自身は DDB に触らない (= Lambda invoke だけ)。
    if (!props.statusWriterFunction) {
      if (!props.deploymentsTable) {
        throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
      }
      props.deploymentsTable.grantWriteData(this.stateMachine);
    }
  }

  private buildMarkInProgress(props: DeployCreateStateMachineProps): DeployStatusWriteTask {
    if (props.statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        "MarkInProgress",
        {
          transition: "markInProgress",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
        },
        JsonPath.DISCARD,
        props.statusWriterFunction,
      );
    }
    if (!props.deploymentsTable) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, "MarkInProgress", {
      table: props.deploymentsTable,
      key: deploymentKey(),
      updateExpression: "SET #status = :status, updatedAt = :updatedAt",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("IN_PROGRESS"),
        ":updatedAt": stateEnteredTime(),
      },
      resultPath: JsonPath.DISCARD,
    });
  }

  /**
   * 在来 (default) の CodeBuild `.sync` 定義。`deployViaLambda` が false / 未指定のとき使う。
   * 生成する construct ID / chain / StateMachine props は #2291 前と完全一致させ、
   * flag OFF の synth を byte 互換に保つ (= additive リソースは一切増やさない)。
   */
  private buildCodeBuildDefinition(
    props: DeployCreateStateMachineProps,
    markInProgress: DeployStatusWriteTask,
  ): IChainable {
    const codeBuildProject = props.codeBuildProject;
    if (!codeBuildProject) {
      throw new Error("codeBuildProject is required when deployViaLambda is false");
    }
    // Phase 2.2 (Issue #459): AssumeRole metadata は 2 fields が両方あるときだけ
    // CodeBuild env に渡す。Step Functions の optional path 直接参照は field 欠落時に
    // States.Runtime で即死するため、Choice で cross-account / same-account を明示分岐する。
    //
    // Issue #895: stack tagging に必要な tenantId / jobId /
    // batchId を CodeBuild env に渡す。 deploy-battles.sh が `cloudformation deploy --tags`
    // に展開し、 operator が `cloudformation:ListStacks` + tag filter で batch を逆引き
    // できるようにする。 batchId は bulk 発火 (= 同一 event で N×M 個の deploy を撒く
    // ケース) で 1 batch を識別する。 単発 / authoring iteration では未指定 = jobId と
    // 同値 fallback で扱う (= deploy-battles.sh 側で fallback)。
    const startCodeBuildSameAccount = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
        TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
        DEPLOY_REGION: { value: JsonPath.stringAt("$.detail.region") },
        PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
        TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
        TENKACLOUD_TENANT_ID: { value: JsonPath.stringAt("$.detail.tenantId") },
        TENKACLOUD_JOB_ID: { value: JsonPath.stringAt("$.detail.jobId") },
      },
      resultPath: "$.codebuild",
    });

    const startCodeBuildCrossAccount = new CodeBuildStartBuild(
      this,
      "StartDeployCodeBuildCrossAccount",
      {
        project: codeBuildProject,
        integrationPattern: IntegrationPattern.RUN_JOB,
        environmentVariablesOverride: {
          BATTLE_PROBLEM_DIR: { value: JsonPath.stringAt("$.detail.problemDir") },
          TEAM_SLUG: { value: JsonPath.stringAt("$.detail.teamSlug") },
          DEPLOY_REGION: { value: JsonPath.stringAt("$.detail.region") },
          PROBLEM_EXTERNAL_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          TENKACLOUD_CORRELATION_ID: { value: JsonPath.stringAt("$.detail.jobId") },
          TENKACLOUD_TENANT_ID: { value: JsonPath.stringAt("$.detail.tenantId") },
          TENKACLOUD_JOB_ID: { value: JsonPath.stringAt("$.detail.jobId") },
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
          "competitorRoleArn and externalIdParameterName must be provided together for cross-account deploy",
      }),
      resultPath: "$.error",
    });

    const routeCreateInput = new Choice(this, "RouteCreateInput")
      .when(
        Condition.and(
          Condition.isPresent("$.detail.competitorRoleArn"),
          Condition.isPresent("$.detail.externalIdParameterName"),
        ),
        startCodeBuildCrossAccount,
      )
      .when(
        Condition.and(
          Condition.not(Condition.isPresent("$.detail.competitorRoleArn")),
          Condition.not(Condition.isPresent("$.detail.externalIdParameterName")),
        ),
        startCodeBuildSameAccount,
      )
      .otherwise(invalidAssumeRoleMetadata);

    // CodeBuild 完了後に CFn から Outputs と StackId を取得。verified deployment は
    // competitor account への AssumeRole が必要なので DescribeStackLambda に detail (= 元
    // EventBridge event の detail field) を渡す。
    // payloadResponseOnly=true により $.cfn は Lambda response (= DescribeStacks output)
    // そのものになり、既存 MarkSucceeded の JSONPath 契約を維持する。
    //
    // Issue #809: 旧コードは `payload: TaskInput.fromJsonPathAt("$")` を使っていたが、
    // CDK が optimized Lambda integration + `payloadResponseOnly: true` で
    // `Parameters: "$"` (= literal string) を生成し、 Lambda は literal `"$"` を event
    // として受け取って `event.detail.jobId` が undefined で fail していた。
    // `TaskInput.fromObject({...})` で明示的に object payload を組むと CDK は
    // `Parameters: { "detail.$": "$.detail" }` を生成し、 JSONPath が解決される。
    const describeStacks = new LambdaInvoke(this, "DescribeStack", {
      lambdaFunction: props.describeStackFunction,
      payload: TaskInput.fromObject({ detail: JsonPath.objectAt("$.detail") }),
      payloadResponseOnly: true,
      resultPath: "$.cfn",
    });

    const markSucceeded = this.buildMarkSucceeded(
      props.deploymentsTable,
      props.statusWriterFunction,
    );
    const markFailed = this.buildMarkFailed(
      props.deploymentsTable,
      "MarkFailed",
      true,
      undefined,
      props.statusWriterFunction,
    );
    const markFailedWithoutBuildId = this.buildMarkFailed(
      props.deploymentsTable,
      "MarkFailedWithoutBuildId",
      false,
      undefined,
      props.statusWriterFunction,
    );
    const useStackStatusReasonAsFailureCause = new Pass(
      this,
      "UseStackStatusReasonAsFailureCause",
      {
        parameters: {
          "Cause.$": "$.cfn.Stacks[0].StackStatusReason",
        },
        resultPath: "$.error",
      },
    );
    useStackStatusReasonAsFailureCause.next(markFailed);
    const routeDescribedStackStatus = new Choice(this, "RouteDescribedStackStatus")
      .when(
        Condition.or(
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "ROLLBACK_COMPLETE"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "CREATE_FAILED"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "UPDATE_ROLLBACK_COMPLETE"),
        ),
        useStackStatusReasonAsFailureCause,
      )
      .otherwise(markSucceeded);
    const routeFailedDeployment = new Choice(this, "RouteFailedDeployment")
      .when(Condition.isPresent("$.codebuild.Build.Id"), markFailed)
      .otherwise(markFailedWithoutBuildId);

    // MarkInProgress / CodeBuild / DescribeStacks のいずれの失敗も MarkFailed (= status=FAILED)
    // に倒す。MarkInProgress は DDB throttle くらいでしか落ちないが落とし穴を残さないため
    // catch を付ける。DescribeStacks も稀な throttle / 競技者 account 側 Role の問題で
    // 落ちうる。その場合 stackOutputs 不在のまま FAILED にして operator が再試行する。
    // buildId は StartDeployCodeBuild が正常 output を返した後だけ存在するため、pre-CodeBuild
    // 失敗では従来通り buildId 無しで FAILED を書く。
    markInProgress.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    startCodeBuildSameAccount.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    startCodeBuildCrossAccount.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    describeStacks.addCatch(routeFailedDeployment, { resultPath: "$.error" });
    describeStacks.next(routeDescribedStackStatus);
    startCodeBuildSameAccount.next(describeStacks);
    startCodeBuildCrossAccount.next(describeStacks);
    invalidAssumeRoleMetadata.next(markFailedWithoutBuildId);

    return markInProgress.next(routeCreateInput);
  }

  /**
   * Issue #2291: Lambda CreateStack + DescribeStacks poll 定義。
   * `deployViaLambda === true` のときだけ生成する (additive; default synth には現れない)。
   *
   * flow: MarkInProgress → InvokeCfnDeploy (CreateStack を投げて即 return) → Wait →
   *   DescribeStack (poll) → RoutePollStatus:
   *     - CREATE_COMPLETE / UPDATE_COMPLETE          → MarkSucceeded (stackId + stackOutputs)
   *     - ROLLBACK_COMPLETE / CREATE_FAILED / …      → MarkFailed (StackStatusReason を failureReason に)
   *     - それ以外 (in-progress)                      → Wait へ戻り polling を継続
   *
   * DDB の status 遷移 (IN_PROGRESS→COMPLETE/FAILED) と stackId / stackOutputs / failureReason
   * field は CodeBuild path と同一契約。buildId は CodeBuild 固有なので Lambda path では書かない。
   */
  private buildLambdaDefinition(
    props: DeployCreateStateMachineProps,
    markInProgress: DeployStatusWriteTask,
  ): IChainable {
    const cfnDeployFunction = props.cfnDeployFunction;
    if (!cfnDeployFunction) {
      throw new Error("cfnDeployFunction is required when deployViaLambda is true");
    }
    // Issue #2291: 失敗 event の PutEvents 先。Lambda path は AWS service event を出さないので bus が
    // 無いと失敗が audit に載らない (= 本 issue の gap)。fail loud (cfnDeployFunction と同方針)。
    const eventBus = props.eventBus;
    if (!eventBus) {
      throw new Error("eventBus is required when deployViaLambda is true");
    }

    // CreateStack を投げて即 return する deploy Lambda。detail (元 EventBridge event の detail)
    // を渡す。payloadResponseOnly で $.deploy は Lambda response ({ stackId }) になる。
    const invokeCfnDeploy = new LambdaInvoke(this, "InvokeCfnDeploy", {
      lambdaFunction: cfnDeployFunction,
      payload: TaskInput.fromObject({ detail: JsonPath.objectAt("$.detail") }),
      payloadResponseOnly: true,
      resultPath: "$.deploy",
    });

    // CFn stack 反映まで少し待ってから DescribeStacks を叩く (直後は stack がまだ見えない)。
    // 間隔は deploy-cost-model.ts の共有定数 (30s)。SFN 遷移コスト (750 波 ≈$0.7) を左右するので
    // create / delete の poll loop で同値に保つ。
    const waitBeforePoll = new Wait(this, "WaitBeforePoll", {
      time: WaitTime.duration(Duration.seconds(DEPLOY_STATUS_POLL_INTERVAL_SECONDS)),
    });

    // DescribeStackLambda を再利用。$.cfn は DescribeStacks output (= CodeBuild path と同契約)。
    const describeStacks = new LambdaInvoke(this, "DescribeStack", {
      lambdaFunction: props.describeStackFunction,
      payload: TaskInput.fromObject({ detail: JsonPath.objectAt("$.detail") }),
      payloadResponseOnly: true,
      resultPath: "$.cfn",
    });

    // Lambda path は buildId を持たない (= CodeBuild 固有)。MarkSucceeded / MarkFailed は
    // buildId を書かない variant を使う。
    // Issue #2291: MarkFailed の後段に EmitDeployFailedEvent を繋ぐため resultPath を DISCARD にし、
    // `$.detail` / `$.error` を温存する。CodeBuild path は default のまま (byte 互換)。
    const markSucceeded = this.buildMarkSucceededWithoutBuildId(
      props.deploymentsTable,
      props.statusWriterFunction,
    );
    const markFailed = this.buildMarkFailed(
      props.deploymentsTable,
      "MarkFailed",
      false,
      JsonPath.DISCARD,
      props.statusWriterFunction,
    );

    // Issue #2291: DDB を FAILED にした後、`SystemAuditWriterLambda` が拾う失敗 event を 1 件 PutEvents する。
    // detail は非機密値 (jobId/tenantId/problemId/region) + `$.error.Cause`。EventBridgePutEvents が SM role
    // に対象 bus scope の `events:PutEvents` を自動付与する (least-privilege)。
    const emitDeployFailedEvent = new EventBridgePutEvents(this, "EmitDeployFailedEvent", {
      entries: [
        {
          eventBus,
          source: "tenkacloud.problem-deploy",
          detailType: "TenkaCloud Deploy Failed",
          detail: TaskInput.fromObject({
            jobId: JsonPath.stringAt("$.detail.jobId"),
            tenantId: JsonPath.stringAt("$.detail.tenantId"),
            problemId: JsonPath.stringAt("$.detail.problemId"),
            region: JsonPath.stringAt("$.detail.region"),
            failureReason: JsonPath.stringAt("$.error.Cause"),
          }),
        },
      ],
    });
    markFailed.next(emitDeployFailedEvent);
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
      .when(
        Condition.or(
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "CREATE_COMPLETE"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "UPDATE_COMPLETE"),
        ),
        markSucceeded,
      )
      .when(
        Condition.or(
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "ROLLBACK_COMPLETE"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "ROLLBACK_FAILED"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "CREATE_FAILED"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "UPDATE_ROLLBACK_COMPLETE"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "UPDATE_ROLLBACK_FAILED"),
          Condition.stringEquals("$.cfn.Stacks[0].StackStatus", "DELETE_FAILED"),
        ),
        useStackStatusReasonAsFailureCause,
      )
      // それ以外 (CREATE_IN_PROGRESS 等の中間状態) は poll を継続。
      .otherwise(waitBeforePoll);

    // MarkInProgress / InvokeCfnDeploy / DescribeStacks のいずれの失敗も FAILED に倒す
    // (buildId 無し variant を共用)。$.error.Cause に States.TaskFailed の Cause が入る。
    markInProgress.addCatch(markFailed, { resultPath: "$.error" });
    invokeCfnDeploy.addCatch(markFailed, { resultPath: "$.error" });
    describeStacks.addCatch(markFailed, { resultPath: "$.error" });

    invokeCfnDeploy.next(waitBeforePoll);
    waitBeforePoll.next(describeStacks);
    describeStacks.next(routePollStatus);

    return markInProgress.next(invokeCfnDeploy);
  }

  private buildStatusWriterInvoke(
    id: string,
    payload: Record<string, unknown>,
    resultPath: string | undefined,
    statusWriterFunction: IFunction,
  ): LambdaInvoke {
    const task = new LambdaInvoke(this, id, {
      lambdaFunction: statusWriterFunction,
      payload: TaskInput.fromObject(payload),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      ...(resultPath ? { resultPath } : {}),
    });
    // Issue #2651: pure-SQL status writes cross a Lambda + Turso boundary. Retry the whole task
    // before following its Catch path; this absorbs transient Lambda, SSM, network, throttling,
    // and libSQL failures. Deterministic failures still terminate after four attempts and are
    // converged independently by the scheduled stuck-create reconciler.
    task.addRetry({
      errors: ["States.TaskFailed"],
      interval: Duration.seconds(2),
      maxAttempts: 4,
      backoffRate: 2,
    });
    return task;
  }

  private buildMarkSucceeded(
    table: ITable | undefined,
    statusWriterFunction?: IFunction,
  ): DeployStatusWriteTask {
    if (statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        "MarkSucceeded",
        {
          transition: "markSucceeded",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
          stackId: JsonPath.stringAt("$.cfn.Stacks[0].StackId"),
          stackOutputs: JsonPath.jsonToString(JsonPath.objectAt("$.cfn.Stacks[0].Outputs")),
          buildId: JsonPath.stringAt("$.codebuild.Build.Id"),
        },
        undefined,
        statusWriterFunction,
      );
    }
    if (!table) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, "MarkSucceeded", {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs, buildId = :buildId",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("COMPLETE"),
        ":updatedAt": stateEnteredTime(),
        ":stackId": DynamoAttributeValue.fromString(JsonPath.stringAt("$.cfn.Stacks[0].StackId")),
        // CFn `Outputs: [{OutputKey, OutputValue, ...}]` の配列を JSON 文字列で格納。
        // 読み出し側 (cfn-status.ts:parseStackOutputs) は array / object どちらも解釈する。
        ":stackOutputs": DynamoAttributeValue.fromString(
          JsonPath.jsonToString(JsonPath.objectAt("$.cfn.Stacks[0].Outputs")),
        ),
        ":buildId": DynamoAttributeValue.fromString(JsonPath.stringAt("$.codebuild.Build.Id")),
      },
    });
  }

  /**
   * Issue #2291: Lambda path 用の MarkSucceeded。CodeBuild 固有の `buildId` を書かない以外は
   * {@link buildMarkSucceeded} と同一 (status=COMPLETE, stackId, stackOutputs)。
   */
  private buildMarkSucceededWithoutBuildId(
    table: ITable | undefined,
    statusWriterFunction?: IFunction,
  ): DeployStatusWriteTask {
    if (statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        "MarkSucceeded",
        {
          transition: "markSucceeded",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
          stackId: JsonPath.stringAt("$.cfn.Stacks[0].StackId"),
          stackOutputs: JsonPath.jsonToString(JsonPath.objectAt("$.cfn.Stacks[0].Outputs")),
        },
        undefined,
        statusWriterFunction,
      );
    }
    if (!table) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, "MarkSucceeded", {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, stackId = :stackId, stackOutputs = :stackOutputs",
      expressionAttributeNames: { "#status": "status" },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("COMPLETE"),
        ":updatedAt": stateEnteredTime(),
        ":stackId": DynamoAttributeValue.fromString(JsonPath.stringAt("$.cfn.Stacks[0].StackId")),
        ":stackOutputs": DynamoAttributeValue.fromString(
          JsonPath.jsonToString(JsonPath.objectAt("$.cfn.Stacks[0].Outputs")),
        ),
      },
    });
  }

  // `resultPath` default は task 出力が `$` を上書きする。Issue #2291 の Lambda path は `JsonPath.DISCARD` を渡して `$.detail` / `$.error` を温存し、後段 PutEvents を可能にする。
  private buildMarkFailed(
    table: ITable | undefined,
    id: string,
    persistBuildId: boolean,
    resultPath?: string,
    statusWriterFunction?: IFunction,
  ): DeployStatusWriteTask {
    if (statusWriterFunction) {
      return this.buildStatusWriterInvoke(
        id,
        {
          transition: "markFailed",
          jobId: JsonPath.stringAt("$.detail.jobId"),
          updatedAt: JsonPath.stringAt("$$.State.EnteredTime"),
          failureReason: JsonPath.stringAt("$.error.Cause"),
          ...(persistBuildId ? { buildId: JsonPath.stringAt("$.codebuild.Build.Id") } : {}),
        },
        resultPath,
        statusWriterFunction,
      );
    }
    if (!table) {
      throw new Error("deploymentsTable is required when statusWriterFunction is not provided");
    }
    return new DynamoUpdateItem(this, id, {
      table,
      key: deploymentKey(),
      updateExpression:
        "SET #status = :status, updatedAt = :updatedAt, #failureReason = :failureReason" +
        (persistBuildId ? ", buildId = :buildId" : ""),
      expressionAttributeNames: {
        "#status": "status",
        "#failureReason": "failureReason",
      },
      expressionAttributeValues: {
        ":status": DynamoAttributeValue.fromString("FAILED"),
        ":updatedAt": stateEnteredTime(),
        // `$.error.Cause` は CodeBuild RUN_JOB の `States.TaskFailed` Cause (= build
        // 失敗 detail の JSON 文字列)。100 文字を超えるので JSON のまま格納する。
        ":failureReason": DynamoAttributeValue.fromString(JsonPath.stringAt("$.error.Cause")),
        ...(persistBuildId
          ? {
              ":buildId": DynamoAttributeValue.fromString(
                JsonPath.stringAt("$.codebuild.Build.Id"),
              ),
            }
          : {}),
      },
      ...(resultPath ? { resultPath } : {}),
    });
  }
}
