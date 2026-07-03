import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { auditLogEnabledEnv } from "./audit-log-env.js";
import { controlDataBackendEnv } from "./control-data-backend-env.js";
import { SBT_ONBOARDING_DETAIL_TYPES } from "./handlers/system-audit-writer/sbt-detail-types.js";

export interface SystemAuditWriterLambdaProps {
  /** SBT ControlPlane が払い出す共通 EventBus。 */
  readonly eventBus: IEventBus;
  /** ADR-020 Phase D の admin audit log table (= `PK=SYSTEM#<env>` で行を書く)。 */
  readonly adminAuditLogTable: Table;
  /** `SYSTEM#<env>` の env suffix (= writeAuditEvent が `DEPLOY_ENVIRONMENT` を読む)。 */
  readonly environmentName: string;
  /**
   * Issue #2311: 監査ログ feature flag。false で `AUDIT_LOG_ENABLED="false"` を注入し no-op 化。
   */
  readonly auditLogEnabled?: boolean;
  /**
   * Issue #2290 (ADR-049 §5.1): control-plane data backend (dynamodb|turso|sql)。監査 Lambda 群と
   * lockstep で env を配線する。default (未指定 / `dynamodb`) は env を足さず byte 互換。
   */
  readonly controlDataBackend?: string;
  /**
   * Issue #2291 (ADR-049 §9): Lambda deploy 経路 (`deployViaLambda=true`) が有効なとき true。
   * true のときだけ `deployFailureRule` (= 共通 bus 上の `TenkaCloud Deploy Failed` を拾う Rule)
   * を追加する。CodeBuild path と違い Lambda deploy 失敗は AWS service event を出さないため、
   * `DeployCreate` state machine が emit する custom event を audit に橋渡しする。default
   * (未指定 / false) は Rule を足さず byte 互換。
   */
  readonly deployViaLambda?: boolean;
}

/**
 * Issue #1034: SBT Control Plane の tenant onboarding / offboarding イベントを listen し、
 * `AdminAuditLog` table の SYSTEM 区画 (= `PK=SYSTEM#<env>`) に行を書き戻す Lambda + Rule。
 *
 * 旧状態: SystemAdmin の tenant CRUD は SBT 経由なので App Plane Lambda は走らず、 audit-log
 * page の SystemAdmin scope は常に 0 件だった。 本 construct が SBT EventBridge bus を listen
 * し、 onboardingRequest / onboardingSuccess / onboardingFailure / offboarding* の 6 detailType
 * を SYSTEM scope audit に集約する (= 「誰がいつ tenant を作成 / 削除した」 が UI で読める)。
 *
 * fail-safe: Lambda が throw すると EventBridge は最大 24h 再 deliver を試みる。 audit 1 行
 * 欠落 < retry storm のコストなので handler は catch して swallow する (= writeAuditEvent も
 * 内部で fail-safe)。
 */
export class SystemAuditWriterLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;
  /**
   * Issue #1029: CodeBuild Build State Change event (= aws.codebuild source) を listen する
   * 別 rule。 default event bus にぶら下がるため `rule` (SBT bus) とは分離した EventBridge
   * Rule 構築になる。
   */
  public readonly codeBuildFailureRule: Rule;
  /**
   * Issue #2291 (ADR-049 §9): Lambda deploy 経路の失敗 event (= `DeployCreate` state machine が
   * SBT bus に PutEvents する `TenkaCloud Deploy Failed`) を listen する Rule。 `deployViaLambda`
   * が true のときだけ生成する (= CodeBuild path しか無い環境では byte 互換で undefined)。
   */
  public readonly deployFailureRule?: Rule;

  constructor(scope: Construct, id: string, props: SystemAuditWriterLambdaProps) {
    super(scope, id);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/system-audit-writer/index.ts"),
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        ADMIN_AUDIT_LOG_TABLE_NAME: props.adminAuditLogTable.tableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        // Issue #2311: 監査ログ feature flag (無効時のみ AUDIT_LOG_ENABLED="false" を注入)。
        ...auditLogEnabledEnv(props.auditLogEnabled),
        // Issue #2290: control-plane data backend (default dynamodb は env を足さず byte 互換)。
        ...controlDataBackendEnv(props.controlDataBackend ?? "dynamodb"),
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    props.adminAuditLogTable.grantWriteData(this.fn);

    // SBT `DetailType` enum (= event-manager.d.ts) のうち audit に意味があるものを listen。
    // user / api-key 系の SBT events は別 issue で扱う (本 issue は tenant CRUD に絞る)。
    this.rule = new Rule(this, "Rule", {
      eventBus: props.eventBus,
      description:
        "Route SBT tenant onboarding/offboarding events to SystemAuditWriter Lambda (Issue #1034)",
      eventPattern: {
        // Issue #2201: handler の対応表 (SBT_DETAIL_TYPE_TO_ACTION) とキー集合を共有し、
        // 「フィルタは通すが監査されない」/「フィルタで落ちる」の無音ドリフトを防ぐ。
        detailType: [...SBT_ONBOARDING_DETAIL_TYPES],
      },
      targets: [new LambdaFunction(this.fn)],
    });

    // Issue #1029: CodeBuild Build State Change event は AWS service event なので **default
    // event bus** に流れる (= SBT bus とは別 bus)。 SBT pipeline の Step Functions が CodeBuild
    // FAILED を SUCCEEDED と取り違える silent failure に対する observability fix として、 build-status
    // が SUCCEEDED 以外 (= FAILED / FAULT / STOPPED / TIMED_OUT 等) の event を audit に書く。
    // project-name filter は意図的に外して account 全域を catch (= SBT が自動採番する project
    // 名 prefix が version で変わるリスク回避、 不要 noise は handler 側 outcome=error で識別可)。
    this.codeBuildFailureRule = new Rule(this, "CodeBuildFailureRule", {
      description:
        "Route CodeBuild FAILED / FAULT / STOPPED / TIMED_OUT events to SystemAuditWriter Lambda (Issue #1029)",
      eventPattern: {
        source: ["aws.codebuild"],
        detailType: ["CodeBuild Build State Change"],
        detail: {
          "build-status": ["FAILED", "FAULT", "STOPPED", "TIMED_OUT"],
        },
      },
      targets: [new LambdaFunction(this.fn)],
    });

    // Issue #2291: Lambda deploy 経路が有効なときだけ、`DeployCreate` state machine が SBT bus に
    // 出す `TenkaCloud Deploy Failed` を拾う Rule を足す。CodeBuild path (`CodeBuild Build State
    // Change` FAILED) と対になる parity: Lambda deploy 失敗も SYSTEM scope audit に載る。flag OFF
    // (default) では Rule を作らないので追加リソースなし = byte 互換。
    if (props.deployViaLambda) {
      this.deployFailureRule = new Rule(this, "DeployFailureRule", {
        eventBus: props.eventBus,
        description:
          "Route TenkaCloud Deploy Failed (Lambda deploy path) events to SystemAuditWriter Lambda (Issue #2291)",
        eventPattern: {
          source: ["tenkacloud.problem-deploy"],
          detailType: ["TenkaCloud Deploy Failed"],
        },
        targets: [new LambdaFunction(this.fn)],
      });
    }
  }
}
