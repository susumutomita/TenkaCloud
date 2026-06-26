import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Capability,
  CloudFormationClient,
  type Parameter as CloudFormationParameter,
  CreateStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { parse as parseYaml } from "yaml";
import type { LocalFlagProblem } from "./catalog";
import { materializeTemplate } from "./kumo-materializer";

const REGION = "us-east-1";
const ACCOUNT_ID = "000000000000";
const CREATE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

interface YamlCstNode {
  readonly strValue?: string;
}

function scalarTag(tag: string, key: string, transform = (value: string): unknown => value) {
  return {
    tag,
    resolve: (_doc: unknown, cst: YamlCstNode) => {
      if (cst.strValue === undefined) {
        throw new Error(`${tag} must use scalar form in local play`);
      }
      return { [key]: transform(cst.strValue) };
    },
  };
}

const CFN_YAML_TAGS = [
  scalarTag("!Ref", "Ref"),
  scalarTag("!Sub", "Fn::Sub"),
  scalarTag("!GetAtt", "Fn::GetAtt", (value) => value.split(".", 2)),
  scalarTag("!Base64", "Fn::Base64"),
  scalarTag("!Cidr", "Fn::Cidr"),
  scalarTag("!FindInMap", "Fn::FindInMap"),
  scalarTag("!GetAZs", "Fn::GetAZs"),
  scalarTag("!ImportValue", "Fn::ImportValue"),
  scalarTag("!Join", "Fn::Join"),
  scalarTag("!Select", "Fn::Select"),
  scalarTag("!Split", "Fn::Split"),
];

export interface LocalPlayDeployment {
  readonly problem: LocalFlagProblem;
  readonly stackName: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly expectedFlag: string;
  readonly discoveryCommand: string;
}

export function assertLocalKumoEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new Error(`Invalid Kumo endpoint: ${endpoint}`, { cause: error });
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!isLoopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`Refusing non-local Kumo endpoint: ${url.origin}`);
  }
  return url;
}

export function buildLocalParameters(
  problemId: string,
  configured: Readonly<Record<string, string>>,
  generatedSecret: string,
): Readonly<Record<string, string>> {
  const mapped = Object.fromEntries(
    Object.entries(configured).map(([key, value]) => [
      key,
      value === "__RANDOM_PASSWORD__" ? generatedSecret : value,
    ]),
  );
  const stackName = `tc-${problemId}-kumo`;
  return {
    ...mapped,
    NamePrefix: stackName,
    TenkaCloudAccountId: ACCOUNT_ID,
    ExternalId: `${stackName}-external-id`,
  };
}

export function renderCloudFormationTemplate(templateYaml: string): string {
  const parsed = parseYaml(templateYaml, { customTags: CFN_YAML_TAGS as never });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CloudFormation template must contain a YAML object");
  }
  return JSON.stringify(parsed);
}

function parameters(configured: Readonly<Record<string, string>>): CloudFormationParameter[] {
  return Object.entries(configured).map(([ParameterKey, ParameterValue]) => ({
    ParameterKey,
    ParameterValue,
  }));
}

function makeClient(endpoint: string): CloudFormationClient {
  assertLocalKumoEndpoint(endpoint);
  return new CloudFormationClient({
    endpoint,
    region: REGION,
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });
}

async function describeStack(client: CloudFormationClient, stackName: string): Promise<string> {
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack?.StackStatus) throw new Error(`Kumo did not return stack "${stackName}"`);
  return stack.StackStatus;
}

async function waitForStack(client: CloudFormationClient, stackName: string): Promise<void> {
  const deadline = Date.now() + CREATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await describeStack(client, stackName);
    if (status === "CREATE_COMPLETE") return;
    if (status.endsWith("_FAILED") || status.includes("ROLLBACK")) {
      throw new Error(`Kumo stack "${stackName}" failed with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for Kumo stack "${stackName}"`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function discoveryCommand(endpoint: string, outputs: Readonly<Record<string, string>>): string {
  const parameterName = outputs.ParameterName;
  if (!parameterName) {
    return `aws --endpoint-url ${shellQuote(endpoint)} cloudformation describe-stacks`;
  }
  return [
    "AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws",
    `--endpoint-url ${shellQuote(endpoint)}`,
    `--region ${REGION}`,
    "ssm get-parameter",
    `--name ${shellQuote(parameterName)}`,
    "--query Parameter.Value",
    "--output text",
  ].join(" ");
}

export async function deployProblemToKumo(
  problem: LocalFlagProblem,
  endpoint: string,
): Promise<LocalPlayDeployment> {
  const normalizedEndpoint = assertLocalKumoEndpoint(endpoint).origin;
  const client = makeClient(normalizedEndpoint);
  const stackName = `tc-${problem.problemId}-kumo`;
  const seed = randomBytes(16).toString("hex");
  const templateBody = renderCloudFormationTemplate(readFileSync(problem.templatePath, "utf8"));
  const templateParameters = buildLocalParameters(problem.problemId, problem.cfnParameters, seed);

  await client.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: templateBody,
      Parameters: parameters(templateParameters),
      Capabilities: [Capability.CAPABILITY_IAM, Capability.CAPABILITY_NAMED_IAM],
    }),
  );
  await waitForStack(client, stackName);
  // Kumo's CloudFormation API records stack metadata/resources, but v0.25.3
  // does not invoke service APIs or evaluate Outputs. Materialize the explicit
  // local-play subset against Kumo, then evaluate the real template Outputs.
  const outputs = await materializeTemplate(
    normalizedEndpoint,
    stackName,
    templateBody,
    templateParameters,
  );
  const expectedFlag = outputs[problem.scoring.flagOutputKey];
  if (!expectedFlag) {
    const availableOutputs = Object.keys(outputs).sort().join(", ") || "(none)";
    throw new Error(
      `Kumo stack "${stackName}" did not produce scoring output "${problem.scoring.flagOutputKey}" (available: ${availableOutputs})`,
    );
  }
  return {
    problem,
    stackName,
    outputs,
    expectedFlag,
    discoveryCommand: discoveryCommand(normalizedEndpoint, outputs),
  };
}
