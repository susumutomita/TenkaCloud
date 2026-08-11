import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { Construct } from "constructs";

const DASHBOARD_PERIOD = cdk.Duration.minutes(5);

interface NamedMetricTarget {
  readonly label: string;
  readonly name: string;
}

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly environment?: string;
  readonly stateMachines: {
    readonly deployCreateArn: string;
    readonly deployDeleteArn: string;
  };
  readonly codeBuildProjectNames: {
    readonly problemDeploy?: string;
    readonly provisioning?: string;
  };
  readonly dynamoDbTableNames: {
    /**
     * [Issue #2441 / Phase B PR-6] `controlDataBackend` が純 SQL (`turso`) のときは
     * Deployments table が synth されないため `undefined`。 dashboard は該当 widget を省く
     * (= default-safe、既存 dynamodb backend の dashboard body は byte 互換)。
     */
    readonly deployments?: string;
    /**
     * [Issue #2440] `controlDataBackend` が純 SQL (`turso`) の
     * ときは Events/Teams table が synth されないため `undefined`。 dashboard は該当 widget を
     * 省く (= default-safe、既存 dynamodb backend の dashboard body は byte 互換)。
     */
    readonly events?: string;
    readonly teams?: string;
    /**
     * [Issue #2442 / Phase C2] `controlDataBackend` が純 SQL (`turso`) のときは
     * CompetitorAccounts table が synth されないため `undefined`。 dashboard は該当 widget を
     * 省く (= default-safe、既存 dynamodb backend の dashboard body は byte 互換、
     * {@link deployments} と同じ条件)。
     */
    readonly competitorAccounts?: string;
    /**
     * [Issue #2442 / Phase C1] `controlDataBackend` が純 SQL (`turso`) のときは
     * ProblemEndpoints table が synth されないため `undefined`。 dashboard は該当 widget を省く
     * (= default-safe、既存 dynamodb backend の dashboard body は byte 互換、
     * {@link deployments} と同じ条件)。
     */
    readonly problemEndpoints?: string;
    readonly tenantMappingTable: string;
  };
  readonly lambdaFunctionNames: {
    readonly deployApi: string;
    readonly eventApi: string;
    readonly participantPortal?: string;
    readonly adminInsight: string;
    readonly competitorAccounts: string;
    readonly externalIdAudit: string;
    readonly genericScoring: string;
    /**
     * Issue #2291: Lambda deploy path の `CfnDeployLambda` 関数名。
     * `deployViaLambda` ON のときだけ `buildDeployPipeline` が Lambda を生成するため、その名前を
     * cross-stack ref で受け取る。undefined (= flag OFF / CodeBuild 経路) のときは Lambda-path 用
     * widget を dashboard に足さない (= default-safe、 dashboard body byte 互換)。
     */
    readonly cfnDeploy?: string;
  };
  readonly apiGateways: {
    readonly controlPlane: ApiGatewayMetricTarget;
    readonly tenant: ApiGatewayMetricTarget;
    readonly problemDeploy?: ApiGatewayMetricTarget;
    readonly adminInsight: ApiGatewayMetricTarget;
  };
}

export type ApiGatewayMetricTarget =
  | {
      readonly kind: "http";
      readonly label: string;
      readonly apiId: string;
      readonly stage?: string;
    }
  | {
      readonly kind: "rest";
      readonly label: string;
      readonly apiName: string;
      readonly stage?: string;
    };

/**
 * TenkaCloud platform observability dashboard.
 *
 * Uses AWS managed CloudWatch metrics only. It intentionally does not add alarms,
 * custom metrics, or IAM resources in this phase.
 */
export class ObservabilityStack extends cdk.Stack {
  /**
   * Issue #1080: admin-console UI が runtime-config 経由で参照する CloudWatch Dashboard 名。
   * AWS Console URL は `https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#dashboards:name=<dashboardName>`
   * で組み立てる (= URL builder は SPA 側、 stack は name + region のみ expose)。
   */
  public readonly dashboardName: string;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const dashboardName = this.buildDashboardName(props.environment);
    this.dashboardName = dashboardName;
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName,
      defaultInterval: cdk.Duration.hours(6),
    });

    dashboard.addWidgets(this.deployStateMachinesWidget(props), this.deployCodeBuildWidget(props));
    dashboard.addWidgets(this.ddbCapacityWidget(props), this.ddbThrottleWidget(props));
    dashboard.addWidgets(this.lambdaCriticalWidget(props), this.lambdaHelperWidget(props));
    dashboard.addWidgets(this.apiGatewayTrafficWidget(props), this.apiGatewayLatencyWidget(props));

    // Issue #2291: Lambda deploy path (`CfnDeployLambda`) の可視化。CodeBuild widget と
    // parity になる Invocations / Errors / Duration / Throttles を出す。`deployViaLambda` ON のときだけ
    // 関数名が渡ってくるので、それを条件に widget を append する。flag OFF では addWidgets を呼ばず、
    // dashboard body は従来と byte 互換 (= default-safe)。
    const cfnDeployFunctionName = props.lambdaFunctionNames.cfnDeploy;
    if (cfnDeployFunctionName) {
      dashboard.addWidgets(this.deployLambdaWidget(cfnDeployFunctionName));
    }

    new cdk.CfnOutput(this, "DashboardNameOutput", {
      value: dashboardName,
      description: "CloudWatch Dashboard name (admin-console から AWS Console URL 組み立てに使う)",
    });

    // Issue #952 cost guardrails: Free Tier breach 検知 CloudWatch Alarms は wire.ts 側で
    // CostBudget の SNS topic を共有しつつ FreeTierAlarms construct を 直接 attach する。
    // ObservabilityStack 内で完結させない理由: CostBudget も同じ topic に publish する必要が
    // あり、 topic を 1 つだけ作る owner として CostBudget が適切 (= wire.ts で CostBudget →
    // FreeTierAlarms の順に作って参照させる)。
  }

  private buildDashboardName(environment?: string): string {
    if (!environment) return "tenkacloud-observability";
    const safeEnvironment = environment.replace(/[^A-Za-z0-9_-]/g, "-");
    return `tenkacloud-observability-${safeEnvironment}`;
  }

  private deployStateMachinesWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const stateMachines = [
      { label: "DeployCreate", arn: props.stateMachines.deployCreateArn },
      { label: "DeployDelete", arn: props.stateMachines.deployDeleteArn },
    ];

    return new cloudwatch.GraphWidget({
      title: "Deploy chain - Step Functions (DeployCreate / DeployDelete)",
      width: 12,
      height: 6,
      left: stateMachines.flatMap((stateMachine) => [
        this.stateMachineMetric(
          "ExecutionsStarted",
          stateMachine.arn,
          `${stateMachine.label} started`,
        ),
        this.stateMachineMetric(
          "ExecutionsSucceeded",
          stateMachine.arn,
          `${stateMachine.label} succeeded`,
        ),
        this.stateMachineMetric(
          "ExecutionsFailed",
          stateMachine.arn,
          `${stateMachine.label} failed`,
        ),
      ]),
      right: stateMachines.flatMap((stateMachine) => [
        this.stateMachineMetric(
          "ExecutionTime",
          stateMachine.arn,
          `${stateMachine.label} ExecutionTime p50`,
          "p50",
        ),
        this.stateMachineMetric(
          "ExecutionTime",
          stateMachine.arn,
          `${stateMachine.label} ExecutionTime p99`,
          "p99",
        ),
      ]),
      leftYAxis: { label: "executions", min: 0 },
      rightYAxis: { label: "milliseconds", min: 0 },
    });
  }

  private deployCodeBuildWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const projects = [
      ...(props.codeBuildProjectNames.problemDeploy
        ? [{ label: "problem-deploy", name: props.codeBuildProjectNames.problemDeploy }]
        : []),
      ...(props.codeBuildProjectNames.provisioning
        ? [
            {
              label: "tenkacloud-saas-provisioning",
              name: props.codeBuildProjectNames.provisioning,
            },
          ]
        : []),
    ];

    return new cloudwatch.GraphWidget({
      title: "Deploy chain - CodeBuild (tenkacloud-saas-provisioning / problem-deploy)",
      width: 12,
      height: 6,
      left: projects.flatMap((project) => [
        this.codeBuildMetric("Builds", project.name, `${project.label} builds`),
        this.codeBuildMetric("SucceededBuilds", project.name, `${project.label} succeeded`),
        this.codeBuildMetric("FailedBuilds", project.name, `${project.label} failed`),
      ]),
      right: projects.map((project) =>
        this.codeBuildMetric("Duration", project.name, `${project.label} duration avg`, "Average"),
      ),
      leftYAxis: { label: "builds", min: 0 },
      rightYAxis: { label: "seconds", min: 0 },
    });
  }

  /**
   * Issue #2291: Lambda deploy path (`CfnDeployLambda`) の metrics widget。
   * CodeBuild widget と parity になるよう、deploy を実行する Lambda の Invocations / Errors /
   * Throttles (count 軸) と Duration p99 (ms 軸) を出す。呼び出し元が `cfnDeploy` 名の有無を
   * 判定してから呼ぶため、ここでは名前が存在する前提 (= flag OFF では呼ばれない)。
   */
  private deployLambdaWidget(functionName: string): cloudwatch.GraphWidget {
    return new cloudwatch.GraphWidget({
      title: "Deploy chain - Lambda (CfnDeploy)",
      width: 12,
      height: 6,
      left: [
        this.lambdaMetric("Invocations", functionName, "CfnDeploy invocations"),
        this.lambdaMetric("Errors", functionName, "CfnDeploy errors"),
        this.lambdaMetric("Throttles", functionName, "CfnDeploy throttles"),
      ],
      right: [this.lambdaMetric("Duration", functionName, "CfnDeploy p99", "p99")],
      leftYAxis: { label: "count", min: 0 },
      rightYAxis: { label: "milliseconds", min: 0 },
    });
  }

  private ddbCapacityWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const tables = this.ddbTargets(props);

    return new cloudwatch.GraphWidget({
      title: "DDB tables - consumed capacity",
      width: 12,
      height: 6,
      left: tables.map((table) =>
        this.ddbMetric("ConsumedReadCapacityUnits", table.name, `${table.label} read`),
      ),
      right: tables.map((table) =>
        this.ddbMetric("ConsumedWriteCapacityUnits", table.name, `${table.label} write`),
      ),
      leftYAxis: { label: "RCU", min: 0 },
      rightYAxis: { label: "WCU", min: 0 },
    });
  }

  private ddbThrottleWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const tables = this.ddbTargets(props);

    return new cloudwatch.GraphWidget({
      title: "DDB tables - throttles",
      width: 12,
      height: 6,
      left: tables.map((table) =>
        this.ddbMetric("ReadThrottleEvents", table.name, `${table.label} read throttles`),
      ),
      right: tables.map((table) =>
        this.ddbMetric("WriteThrottleEvents", table.name, `${table.label} write throttles`),
      ),
      leftYAxis: { label: "read throttles", min: 0 },
      rightYAxis: { label: "write throttles", min: 0 },
    });
  }

  private lambdaCriticalWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const functions = this.criticalLambdaTargets(props);

    return new cloudwatch.GraphWidget({
      title: "Lambda - critical APIs",
      width: 12,
      height: 6,
      left: functions.flatMap((fn) => [
        this.lambdaMetric("Invocations", fn.name, `${fn.label} invocations`),
        this.lambdaMetric("Errors", fn.name, `${fn.label} errors`),
      ]),
      right: functions.map((fn) =>
        this.lambdaMetric("Duration", fn.name, `${fn.label} p99`, "p99"),
      ),
      leftYAxis: { label: "count", min: 0 },
      rightYAxis: { label: "milliseconds", min: 0 },
    });
  }

  private lambdaHelperWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const functions = [
      { label: "external-id-audit", name: props.lambdaFunctionNames.externalIdAudit },
      { label: "generic-scoring", name: props.lambdaFunctionNames.genericScoring },
    ];

    return new cloudwatch.GraphWidget({
      title: "Lambda - helper functions",
      width: 12,
      height: 6,
      left: functions.flatMap((fn) => [
        this.lambdaMetric("Invocations", fn.name, `${fn.label} invocations`),
        this.lambdaMetric("Errors", fn.name, `${fn.label} errors`),
      ]),
      right: functions.map((fn) =>
        this.lambdaMetric("Duration", fn.name, `${fn.label} p99`, "p99"),
      ),
      leftYAxis: { label: "count", min: 0 },
      rightYAxis: { label: "milliseconds", min: 0 },
    });
  }

  private apiGatewayTrafficWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const apis = this.apiGatewayTargets(props);

    return new cloudwatch.GraphWidget({
      title: "ApiGateway - Count / 4XX / 5XX",
      width: 12,
      height: 6,
      left: apis.flatMap((api) => [
        this.apiGatewayMetric("Count", api, `${api.label} count`, "Sum"),
        this.apiGatewayMetric(this.clientErrorMetricName(api), api, `${api.label} 4xx`, "Sum"),
        this.apiGatewayMetric(this.serverErrorMetricName(api), api, `${api.label} 5xx`, "Sum"),
      ]),
      leftYAxis: { label: "requests", min: 0 },
    });
  }

  private apiGatewayLatencyWidget(props: ObservabilityStackProps): cloudwatch.GraphWidget {
    const apis = this.apiGatewayTargets(props);

    return new cloudwatch.GraphWidget({
      title: "ApiGateway - Latency P99",
      width: 12,
      height: 6,
      left: apis.map((api) =>
        this.apiGatewayMetric("Latency", api, `${api.label} latency p99`, "p99"),
      ),
      leftYAxis: { label: "milliseconds", min: 0 },
    });
  }

  private ddbTargets(props: ObservabilityStackProps): NamedMetricTarget[] {
    // Issue #2440 / #2441 / #2442: 純 SQL backend では deployments/events/teams/
    // competitorAccounts/problemEndpoints が undefined (= table 自体が無い) なので widget を
    // 省く (criticalLambdaTargets の participantPortal と同じ filter パターン)。
    const targets: Array<NamedMetricTarget | undefined> = [
      props.dynamoDbTableNames.deployments
        ? { label: "Deployments", name: props.dynamoDbTableNames.deployments }
        : undefined,
      props.dynamoDbTableNames.events
        ? { label: "Events", name: props.dynamoDbTableNames.events }
        : undefined,
      props.dynamoDbTableNames.teams
        ? { label: "Teams", name: props.dynamoDbTableNames.teams }
        : undefined,
      props.dynamoDbTableNames.competitorAccounts
        ? { label: "CompetitorAccounts", name: props.dynamoDbTableNames.competitorAccounts }
        : undefined,
      props.dynamoDbTableNames.problemEndpoints
        ? { label: "ProblemEndpoints", name: props.dynamoDbTableNames.problemEndpoints }
        : undefined,
      { label: "TenantMappingTable", name: props.dynamoDbTableNames.tenantMappingTable },
    ];
    return targets.filter((target): target is NamedMetricTarget => target !== undefined);
  }

  private criticalLambdaTargets(props: ObservabilityStackProps): NamedMetricTarget[] {
    const targets: Array<NamedMetricTarget | undefined> = [
      { label: "deploy-api", name: props.lambdaFunctionNames.deployApi },
      { label: "event-api", name: props.lambdaFunctionNames.eventApi },
      props.lambdaFunctionNames.participantPortal
        ? { label: "participant-portal-lambda", name: props.lambdaFunctionNames.participantPortal }
        : undefined,
      { label: "admin-insight", name: props.lambdaFunctionNames.adminInsight },
      { label: "competitor-accounts", name: props.lambdaFunctionNames.competitorAccounts },
    ];
    return targets.filter((target): target is NamedMetricTarget => target !== undefined);
  }

  private apiGatewayTargets(props: ObservabilityStackProps): ApiGatewayMetricTarget[] {
    return [
      props.apiGateways.controlPlane,
      props.apiGateways.tenant,
      ...(props.apiGateways.problemDeploy ? [props.apiGateways.problemDeploy] : []),
      props.apiGateways.adminInsight,
    ];
  }

  private stateMachineMetric(
    metricName: string,
    stateMachineArn: string,
    label: string,
    statistic = "Sum",
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: "AWS/States",
      metricName,
      dimensionsMap: { StateMachineArn: stateMachineArn },
      statistic,
      period: DASHBOARD_PERIOD,
      label,
    });
  }

  private codeBuildMetric(
    metricName: string,
    projectName: string,
    label: string,
    statistic = "Sum",
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: "AWS/CodeBuild",
      metricName,
      dimensionsMap: { ProjectName: projectName },
      statistic,
      period: DASHBOARD_PERIOD,
      label,
    });
  }

  private ddbMetric(metricName: string, tableName: string, label: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: "AWS/DynamoDB",
      metricName,
      dimensionsMap: { TableName: tableName },
      statistic: "Sum",
      period: DASHBOARD_PERIOD,
      label,
    });
  }

  private lambdaMetric(
    metricName: string,
    functionName: string,
    label: string,
    statistic = "Sum",
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: "AWS/Lambda",
      metricName,
      dimensionsMap: { FunctionName: functionName },
      statistic,
      period: DASHBOARD_PERIOD,
      label,
    });
  }

  private apiGatewayMetric(
    metricName: string,
    api: ApiGatewayMetricTarget,
    label: string,
    statistic: string,
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: "AWS/ApiGateway",
      metricName,
      dimensionsMap: this.apiGatewayDimensions(api),
      statistic,
      period: DASHBOARD_PERIOD,
      label,
    });
  }

  private apiGatewayDimensions(api: ApiGatewayMetricTarget): Record<string, string> {
    if (api.kind === "http") {
      return api.stage ? { ApiId: api.apiId, Stage: api.stage } : { ApiId: api.apiId };
    }
    return api.stage ? { ApiName: api.apiName, Stage: api.stage } : { ApiName: api.apiName };
  }

  private clientErrorMetricName(api: ApiGatewayMetricTarget): string {
    return api.kind === "http" ? "4xx" : "4XXError";
  }

  private serverErrorMetricName(api: ApiGatewayMetricTarget): string {
    return api.kind === "http" ? "5xx" : "5XXError";
  }
}
