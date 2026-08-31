import * as cdk from "aws-cdk-lib";
import { App, Aspects, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { describe, expect, it } from "vitest";
import { LogGroupRetention } from "../../lib/cdk-aspect/log-group-retention";
import { CoordinationDispatcherLambda } from "../../lib/problem-deploy/coordination-dispatcher-lambda";
import {
  LAMBDA_LOG_RETENTION,
  LAMBDA_LOG_RETENTION_DAYS,
  resolveLogRetention,
} from "../../lib/utils/lambda-runtime";

/**
 * LogGroupRetention Aspect は cost-zero invariant の一部。 Lambda は LogGroup を明示しないと
 * "Never expire" の log group を勝手に作り、 ログが無限に蓄積してコスト leak になる。 各 Lambda に
 * 明示 LogGroup を持たせ、 本 Aspect が `CDK_PARAM_LOG_RETENTION_DAYS` (= 既定 1 日) を一括適用する。
 * その 3 つの単位挙動を直接 assert する。
 */
describe("LogGroupRetention aspect", () => {
  it("should set RetentionInDays=1 (the param default) on an explicit Lambda LogGroup", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "RetentionStack");
    new LambdaFunction(stack, "Fn", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: Code.fromInline("exports.handler = async () => {};"),
      // 本番の各 Lambda 構成と同様に LogGroup を明示する (= Aspect 適用前は retention 未設定)。
      logGroup: new LogGroup(stack, "FnLogGroup", { removalPolicy: RemovalPolicy.DESTROY }),
    });
    Aspects.of(app).add(new LogGroupRetention());

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: LAMBDA_LOG_RETENTION_DAYS,
    });
    // env 未設定なら default 1 日 (= RetentionDays.ONE_DAY) に倒れることを pin。
    expect(LAMBDA_LOG_RETENTION_DAYS).toBe(1);
    expect(LAMBDA_LOG_RETENTION).toBe(RetentionDays.ONE_DAY);
  });

  it("should overwrite an already-set retention so the param always wins", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "OverwriteStack");
    // 既に retention=ONE_WEEK (= 7 日) が設定済の LogGroup (= state-machine / log-destination 相当)。
    new LogGroup(stack, "Preset", {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    Aspects.of(app).add(new LogGroupRetention());

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: LAMBDA_LOG_RETENTION_DAYS,
    });
  });

  it("should leave stacks without LogGroups untouched", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "EmptyStack");
    Aspects.of(app).add(new LogGroupRetention());

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Logs::LogGroup", 0);
  });

  it("should cap a representative production Lambda construct's LogGroup at RetentionInDays=1", () => {
    // 実 Lambda construct (CoordinationDispatcherLambda) は明示 LogGroup を持つようになった。
    // bin/wire の App scope と同様に Aspect を適用すると、 その LogGroup の retention が 1 日に
    // 倒れることを end-to-end で pin する (= "Never expire" log group の根絶)。
    const app = new cdk.App({ autoSynth: false });
    const stack = new cdk.Stack(app, "RepresentativeStack");
    const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", {
      partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
    });
    const events = new cdk.aws_dynamodb.Table(stack, "Events", {
      partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
    });
    new CoordinationDispatcherLambda(stack, "CoordinationDispatcher", {
      deploymentsTable: deployments,
      eventsTable: events,
      environmentName: "development",
    });
    Aspects.of(app).add(new LogGroupRetention());

    const template = Template.fromStack(stack);
    // 明示 LogGroup が 1 件以上あり、 全件が RetentionInDays=1 であること。
    const logGroups = template.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(logGroups).length).toBeGreaterThan(0);
    for (const lg of Object.values(logGroups)) {
      expect(
        (lg as { Properties?: { RetentionInDays?: number } }).Properties?.RetentionInDays,
      ).toBe(1);
    }
    // 実 Lambda construct の bundling を伴うため既定 15s では負荷時に marginal(CI 実測 ~12s)。
  }, 60_000);
});

describe("resolveLogRetention", () => {
  it("should map every AWS-supported discrete value to a RetentionDays enum member", () => {
    const supported: ReadonlyArray<[number, RetentionDays]> = [
      [1, RetentionDays.ONE_DAY],
      [3, RetentionDays.THREE_DAYS],
      [5, RetentionDays.FIVE_DAYS],
      [7, RetentionDays.ONE_WEEK],
      [14, RetentionDays.TWO_WEEKS],
      [30, RetentionDays.ONE_MONTH],
      [60, RetentionDays.TWO_MONTHS],
      [90, RetentionDays.THREE_MONTHS],
      [120, RetentionDays.FOUR_MONTHS],
      [150, RetentionDays.FIVE_MONTHS],
      [180, RetentionDays.SIX_MONTHS],
      [365, RetentionDays.ONE_YEAR],
      [400, RetentionDays.THIRTEEN_MONTHS],
      [545, RetentionDays.EIGHTEEN_MONTHS],
      [731, RetentionDays.TWO_YEARS],
      [1827, RetentionDays.FIVE_YEARS],
      [3653, RetentionDays.TEN_YEARS],
    ];
    for (const [days, expected] of supported) {
      expect(resolveLogRetention(days)).toBe(expected);
    }
  });

  it("should throw a clear error on an unsupported retention value (fail loudly)", () => {
    expect(() => resolveLogRetention(2)).toThrow(/Unsupported CloudWatch Logs retention: 2 days/);
    expect(() => resolveLogRetention(10)).toThrow(/CDK_PARAM_LOG_RETENTION_DAYS must be one of/);
    expect(() => resolveLogRetention(0)).toThrow(/Unsupported CloudWatch Logs retention/);
  });
});
