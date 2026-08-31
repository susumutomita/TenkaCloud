import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { describe, expect, it } from "vitest";
import { FreeTierAlarms } from "../../lib/observability/free-tier-alarms";

/**
 * Issue #952 cost guardrails: FreeTierAlarms construct の CFn synth を pin する。
 *
 * - Lambda 1 件あたり 1 個の Alarm
 * - DDB Table 1 件あたり Read / Write 2 個の Alarm
 * - 各 Alarm に SNS topic action が wire される
 * - Lambda の threshold は default 26666 (= 800k/month / 30 days、 Free Tier 80%)
 * - DDB の threshold は default 100000 (= 1 RCU * 86400 sec + 余裕)
 */

function buildStack() {
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, "TestStack");
  const topic = new Topic(stack, "Topic");
  return { app, stack, topic };
}

describe("FreeTierAlarms (#952 cost guardrails)", () => {
  it("should generate 6 Alarms for 2 Lambdas + 1 DDB table (Lambda invocations + Lambda errors + DDB read/write)", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [
        { label: "fn-a", name: "fn-a" },
        { label: "fn-b", name: "fn-b" },
      ],
      dynamoDbTableNames: [{ label: "table-x", name: "table-x" }],
    });
    const tpl = Template.fromStack(stack);
    // Lambda: 2 fn × (invocations + errors) = 4 / DDB: 1 table × (read + write) = 2
    tpl.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });

  it("Lambda alarm の threshold は default 26666、 metric namespace=AWS/Lambda", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [{ label: "fn-a", name: "fn-a" }],
      dynamoDbTableNames: [],
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/Lambda",
      MetricName: "Invocations",
      Threshold: 26666,
      Statistic: "Sum",
    });
  });

  it("DDB Read Capacity Alarm の threshold default は 100000", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [],
      dynamoDbTableNames: [{ label: "table-x", name: "table-x" }],
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/DynamoDB",
      MetricName: "ConsumedReadCapacityUnits",
      Threshold: 100000,
    });
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/DynamoDB",
      MetricName: "ConsumedWriteCapacityUnits",
      Threshold: 100000,
    });
  });

  it("each Alarm should have an SNS topic action", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [{ label: "fn-a", name: "fn-a" }],
      dynamoDbTableNames: [],
    });
    const tpl = Template.fromStack(stack);
    const alarms = tpl.findResources("AWS::CloudWatch::Alarm");
    const first = Object.values(alarms)[0];
    expect(first?.Properties?.AlarmActions).toBeDefined();
    expect(Array.isArray(first?.Properties?.AlarmActions)).toBe(true);
  });

  it("override threshold should be applied", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [{ label: "fn-a", name: "fn-a" }],
      dynamoDbTableNames: [{ label: "table-x", name: "table-x" }],
      lambdaDailyInvocationThreshold: 5000,
      dynamoDbDailyConsumedThreshold: 50000,
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/Lambda",
      Threshold: 5000,
    });
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/DynamoDB",
      Threshold: 50000,
    });
  });

  it("should sanitize non-alphanumeric labels into a valid logical ID (no synth crash)", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      // `name` (the real, possibly-token function name) may contain any character; `label`
      // (caller-supplied, deterministic) is what construct IDs derive from.
      lambdaFunctionNames: [{ label: "deploy-api", name: "tenkacloud-deploy-api-fn.prod" }],
      dynamoDbTableNames: [],
    });
    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("#2239: should produce identical logical IDs across two synths of the same labeled config", () => {
    // Construct IDs must depend only on the caller-supplied `label`, never on a CFn token's
    // process-local numbering -- otherwise an unrelated code change can shift token allocation
    // order and force every FreeTierAlarms Alarm through a DELETE+CREATE on next deploy.
    const targets = {
      lambdaFunctionNames: [{ label: "deploy-api", name: "some-token-like-value-1" }],
      dynamoDbTableNames: [{ label: "deployments", name: "some-token-like-value-2" }],
    };
    const idsOf = () => {
      const { stack, topic } = buildStack();
      new FreeTierAlarms(stack, "Alarms", { notificationTopic: topic, ...targets });
      return Object.keys(Template.fromStack(stack).findResources("AWS::CloudWatch::Alarm")).sort();
    };
    expect(idsOf()).toEqual(idsOf());
  });

  it("#1080: should provision a Lambda errors alarm (metric=Errors / threshold=default 50)", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [{ label: "fn-a", name: "fn-a" }],
      dynamoDbTableNames: [],
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Threshold: 50,
      Statistic: "Sum",
    });
  });

  it("#1080: should provision an API Gateway 5XX alarm for both HTTP and REST APIs", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [],
      dynamoDbTableNames: [],
      apiGateways: [
        { kind: "http", label: "control-plane", apiId: "abc123", stage: "$default" },
        { kind: "rest", label: "tenant", apiName: "tenant-api", stage: "prod" },
      ],
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/ApiGateway",
      MetricName: "5xx",
      Threshold: 50,
      Dimensions: [
        { Name: "ApiId", Value: "abc123" },
        { Name: "Stage", Value: "$default" },
      ],
    });
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/ApiGateway",
      MetricName: "5XXError",
      Threshold: 50,
      Dimensions: [
        { Name: "ApiName", Value: "tenant-api" },
        { Name: "Stage", Value: "prod" },
      ],
    });
  });

  it("#1080: should omit the Stage dimension for API Gateway targets without a stage", () => {
    const { stack, topic } = buildStack();
    new FreeTierAlarms(stack, "Alarms", {
      notificationTopic: topic,
      lambdaFunctionNames: [],
      dynamoDbTableNames: [],
      apiGateways: [
        { kind: "http", label: "control-plane", apiId: "abc123" },
        { kind: "rest", label: "tenant", apiName: "tenant-api" },
      ],
    });
    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/ApiGateway",
      MetricName: "5xx",
      Dimensions: [{ Name: "ApiId", Value: "abc123" }],
    });
    tpl.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/ApiGateway",
      MetricName: "5XXError",
      Dimensions: [{ Name: "ApiName", Value: "tenant-api" }],
    });
  });
});
