import { Duration } from "aws-cdk-lib";
import type { Project } from "aws-cdk-lib/aws-codebuild";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import { CodeBuildStartBuild } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface DeployCreateStateMachineProps {
  /** 実体の deploy を担う CodeBuild Project (= `scripts/deploy-battles.sh` を実行)。 */
  readonly codeBuildProject: Project;
}

/**
 * 問題 deploy 起動を司る Step Functions State Machine (MVP-1)。
 *
 * SBT `ScriptJob` 同型: EventBridge Rule から `DeployCreateRequested` event を受けて起動し、
 * `CodeBuildStartBuild` task (`RUN_JOB` integration pattern = `.sync`) で deploy script
 * の完了を待つ。
 *
 * 入力 shape (event detail):
 *   {
 *     "problemDir": "problems/sample/hello-world",
 *     "teamSlug": "demo-team",
 *     "tenantId": "tenant-acme",
 *     "jobId": "01HX..."
 *   }
 *
 * MVP-1 では deploy 1 件 (single-shot) を扱う。Phase 2 で Distributed Map にして
 * 複数 (problem × account) を bulk 処理に拡張する。
 */
export class DeployCreateStateMachine extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: DeployCreateStateMachineProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      retention: RetentionDays.ONE_WEEK,
    });

    // CodeBuild を `.sync` で起動。完了まで待ち、失敗したら state machine 全体が fail する。
    // 環境変数を Step Functions input から CodeBuild に渡す:
    //   $.detail.problemDir  → BATTLE_PROBLEM_DIR
    //   $.detail.teamSlug    → TEAM_SLUG
    const startCodeBuild = new CodeBuildStartBuild(this, "StartDeployCodeBuild", {
      project: props.codeBuildProject,
      integrationPattern: IntegrationPattern.RUN_JOB,
      environmentVariablesOverride: {
        BATTLE_PROBLEM_DIR: {
          value: JsonPath.stringAt("$.detail.problemDir"),
        },
        TEAM_SLUG: {
          value: JsonPath.stringAt("$.detail.teamSlug"),
        },
      },
    });

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(startCodeBuild),
      timeout: Duration.minutes(60),
      logs: { destination: logGroup, level: LogLevel.ALL },
      tracingEnabled: true,
    });
  }
}
