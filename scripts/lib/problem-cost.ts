import { parse as parseYaml } from "yaml";

export type CostRiskLevel = "none" | "low" | "medium" | "high" | "critical" | "unknown";

export interface ResourceCostHeuristic {
  readonly roughHourlyUsd: number;
  readonly alwaysOn: boolean;
  readonly riskLevel: CostRiskLevel;
  readonly note: string;
}

export interface CostedResource {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly roughHourlyUsd: number;
  readonly alwaysOn: boolean;
  readonly riskLevel: CostRiskLevel;
  readonly notes: readonly string[];
}

export interface ProblemCostEstimate {
  readonly resources: readonly CostedResource[];
  readonly totalHourlyUsd: number;
  readonly alwaysOnHourlyUsd: number;
  readonly sessionHours: number | undefined;
  readonly perSessionUsd: number | undefined;
  readonly perDayIfLeftRunningUsd: number;
  readonly alwaysOnWarnings: readonly CostedResource[];
  readonly unpricedResourceTypes: readonly string[];
}

interface YamlCstNode {
  readonly strValue?: string;
}

const CFN_YAML_TAGS = [
  "!And",
  "!Base64",
  "!Cidr",
  "!Equals",
  "!FindInMap",
  "!GetAtt",
  "!GetAZs",
  "!If",
  "!ImportValue",
  "!Join",
  "!Not",
  "!Or",
  "!Ref",
  "!Select",
  "!Split",
  "!Sub",
].map((tag) => ({
  tag,
  resolve: (_doc: unknown, cst: YamlCstNode) => cst.strValue ?? "",
}));

export const RESOURCE_COST_HEURISTICS: Readonly<Record<string, ResourceCostHeuristic>> = {
  "AWS::CloudWatch::Alarm": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "CloudWatch alarms are low-cost; verify alarm count for large catalogs.",
  },
  "AWS::DynamoDB::Table": {
    roughHourlyUsd: 0.00078,
    alwaysOn: true,
    riskLevel: "low",
    note: "Provisioned 1 RCU / 1 WCU is tiny but still capacity that remains until teardown.",
  },
  "AWS::EC2::EIP": {
    roughHourlyUsd: 0.005,
    alwaysOn: true,
    riskLevel: "medium",
    note: "Elastic IP and public IPv4 addresses can bill while allocated.",
  },
  "AWS::EC2::InternetGateway": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Internet gateways do not bill independently.",
  },
  "AWS::EC2::Route": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Route table entries do not bill independently.",
  },
  "AWS::EC2::RouteTable": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Route tables do not bill independently.",
  },
  "AWS::EC2::SecurityGroup": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Security groups do not bill independently.",
  },
  "AWS::EC2::Subnet": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Subnets do not bill independently.",
  },
  "AWS::EC2::SubnetRouteTableAssociation": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Subnet route table associations do not bill independently.",
  },
  "AWS::EC2::VPC": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "VPCs do not bill independently.",
  },
  "AWS::EC2::VPCGatewayAttachment": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Gateway attachments do not bill independently.",
  },
  "AWS::EC2::Instance": {
    roughHourlyUsd: 0.0104,
    alwaysOn: true,
    riskLevel: "low",
    note: "EC2 instances bill while running; instance type can raise this estimate.",
  },
  "AWS::EC2::NatGateway": {
    roughHourlyUsd: 0.045,
    alwaysOn: true,
    riskLevel: "high",
    note: "NAT Gateway bills hourly plus data processing even when idle.",
  },
  "AWS::ElastiCache::CacheCluster": {
    roughHourlyUsd: 0.018,
    alwaysOn: true,
    riskLevel: "high",
    note: "ElastiCache nodes bill while provisioned.",
  },
  "AWS::ECR::Repository": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "ECR repositories bill for stored data, not the empty repository resource itself.",
  },
  "AWS::ECS::Cluster": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "ECS clusters do not bill independently.",
  },
  "AWS::ECS::Service": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "ECS services do not bill directly; underlying EC2 or Fargate tasks do.",
  },
  "AWS::ElasticLoadBalancing::LoadBalancer": {
    roughHourlyUsd: 0.025,
    alwaysOn: true,
    riskLevel: "medium",
    note: "Classic Load Balancer bills hourly while provisioned.",
  },
  "AWS::ElasticLoadBalancingV2::LoadBalancer": {
    roughHourlyUsd: 0.0225,
    alwaysOn: true,
    riskLevel: "medium",
    note: "ALB/NLB bills hourly plus LCU/NLCU usage while provisioned.",
  },
  "AWS::ElasticLoadBalancingV2::Listener": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "ELB listeners do not bill independently; the load balancer carries the hourly cost.",
  },
  "AWS::ElasticLoadBalancingV2::TargetGroup": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "Target groups do not bill independently; the load balancer carries the hourly cost.",
  },
  "AWS::OpenSearchService::Domain": {
    roughHourlyUsd: 0.05,
    alwaysOn: true,
    riskLevel: "high",
    note: "OpenSearch domains bill for nodes and storage while provisioned.",
  },
  "AWS::RDS::DBInstance": {
    roughHourlyUsd: 0.02,
    alwaysOn: true,
    riskLevel: "high",
    note: "RDS instances bill while running; storage and backups can add cost.",
  },
  "AWS::Redshift::Cluster": {
    roughHourlyUsd: 0.25,
    alwaysOn: true,
    riskLevel: "critical",
    note: "Redshift clusters are expensive always-on capacity.",
  },
  "AWS::SageMaker::NotebookInstance": {
    roughHourlyUsd: 0.05,
    alwaysOn: true,
    riskLevel: "high",
    note: "Notebook instances bill while in service.",
  },
  "AWS::Events::Rule": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "EventBridge rules are usage-priced and normally negligible for problem templates.",
  },
  "AWS::IAM::ManagedPolicy": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM managed policies do not bill independently.",
  },
  "AWS::IAM::Policy": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM policies do not bill independently.",
  },
  "AWS::IAM::Role": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM roles do not bill independently.",
  },
  "AWS::IAM::InstanceProfile": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM instance profiles do not bill independently.",
  },
  "AWS::Lambda::Function": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "Lambda is usage-priced; idle functions do not bill.",
  },
  "AWS::Logs::LogGroup": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "Log groups bill for stored and ingested logs, not for an empty group.",
  },
  "AWS::S3::Bucket": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "S3 buckets bill for storage and requests, not for an empty bucket.",
  },
  "AWS::Scheduler::Schedule": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "EventBridge Scheduler is usage-priced and normally negligible for problem templates.",
  },
  "AWS::SSM::Parameter": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "Standard SSM parameters are free at typical problem scale.",
  },
  "AWS::RDS::DBSubnetGroup": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "RDS DB subnet groups do not bill independently.",
  },
  "AWS::WAFv2::WebACL": {
    roughHourlyUsd: 0.0068,
    alwaysOn: true,
    riskLevel: "medium",
    note: "WAF web ACLs have a fixed monthly cost plus request and rule charges.",
  },
  "AWS::WAFv2::WebACLAssociation": {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "none",
    note: "WAF associations do not bill independently; the web ACL carries cost.",
  },
};

export const ALWAYS_ON_RESOURCE_TYPES = Object.freeze(
  Object.entries(RESOURCE_COST_HEURISTICS)
    .filter(([, heuristic]) => heuristic.alwaysOn)
    .map(([resourceType]) => resourceType)
    .sort(),
);

const INSTANCE_TYPE_HOURLY_USD: Readonly<Record<string, number>> = {
  "t3.nano": 0.0052,
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t4g.nano": 0.0042,
  "t4g.micro": 0.0084,
  "t4g.small": 0.0168,
  "t4g.medium": 0.0336,
  "t4g.large": 0.0672,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "c6i.large": 0.085,
  "c6i.xlarge": 0.17,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getStringProperty(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  return typeof value === "string" ? value : undefined;
}

function hourlyForResourceType(
  resourceType: string,
  props: Record<string, unknown>,
  heuristic: ResourceCostHeuristic | undefined,
): { readonly value: number; readonly notes: readonly string[]; readonly risk?: CostRiskLevel } {
  if (resourceType !== "AWS::EC2::Instance") {
    return { value: heuristic?.roughHourlyUsd ?? 0, notes: [] };
  }

  const instanceType = getStringProperty(props, "InstanceType");
  if (!instanceType) return { value: heuristic?.roughHourlyUsd ?? 0, notes: [] };
  if (!instanceType.includes(".")) {
    return {
      value: heuristic?.roughHourlyUsd ?? 0,
      notes: [`InstanceType is dynamic (${instanceType}); using the default EC2 estimate.`],
    };
  }
  const override = INSTANCE_TYPE_HOURLY_USD[instanceType];
  const value = override ?? heuristic?.roughHourlyUsd ?? 0;
  const notes = [`InstanceType=${instanceType}`];
  const risk = isLargeEc2Instance(instanceType, value) ? "high" : undefined;
  return { value, notes, risk };
}

function isLargeEc2Instance(instanceType: string, hourlyUsd: number): boolean {
  if (hourlyUsd >= 0.05) return true;
  return /\.(large|xlarge|[2-9]xlarge|[1-9][0-9]+xlarge)$/.test(instanceType);
}

function costedResourceFromCfn(
  logicalId: string,
  resource: Record<string, unknown>,
): CostedResource | undefined {
  const resourceType = resource.Type;
  if (typeof resourceType !== "string") return undefined;
  const props = isPlainObject(resource.Properties) ? resource.Properties : {};
  const heuristic = RESOURCE_COST_HEURISTICS[resourceType] ?? customResourceHeuristic(resourceType);
  const hourly = hourlyForResourceType(resourceType, props, heuristic);
  const notes = [
    ...(heuristic
      ? [heuristic.note]
      : ["No offline cost heuristic yet; verify manually if this resource can bill."]),
    ...hourly.notes,
  ];
  return {
    logicalId,
    resourceType,
    roughHourlyUsd: hourly.value,
    alwaysOn: heuristic?.alwaysOn ?? false,
    riskLevel: hourly.risk ?? heuristic?.riskLevel ?? "unknown",
    notes,
  };
}

function customResourceHeuristic(resourceType: string): ResourceCostHeuristic | undefined {
  if (!resourceType.startsWith("Custom::")) return undefined;
  return {
    roughHourlyUsd: 0,
    alwaysOn: false,
    riskLevel: "low",
    note: "Custom resources are invocation-time Lambda work and do not bill as standing resources.",
  };
}

export function analyzeProblemCost(
  templateYaml: string,
  estimatedDuration?: string,
): ProblemCostEstimate {
  const parsed = parseYaml(templateYaml, { customTags: CFN_YAML_TAGS as never });
  const template = isPlainObject(parsed) ? parsed : {};
  const resources = isPlainObject(template.Resources) ? template.Resources : {};
  const costedResources = Object.entries(resources)
    .map(([logicalId, resource]) =>
      isPlainObject(resource) ? costedResourceFromCfn(logicalId, resource) : undefined,
    )
    .filter((entry): entry is CostedResource => entry !== undefined)
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  const totalHourlyUsd = sum(costedResources.map((resource) => resource.roughHourlyUsd));
  const alwaysOnWarnings = costedResources.filter(
    (resource) => resource.alwaysOn && resource.roughHourlyUsd > 0,
  );
  const alwaysOnHourlyUsd = sum(alwaysOnWarnings.map((resource) => resource.roughHourlyUsd));
  const sessionHours = estimatedDuration
    ? parseEstimatedDurationHours(estimatedDuration)
    : undefined;
  const unpricedResourceTypes = [
    ...new Set(
      costedResources
        .filter((resource) => resource.riskLevel === "unknown")
        .map((resource) => resource.resourceType),
    ),
  ].sort();
  return {
    resources: costedResources,
    totalHourlyUsd,
    alwaysOnHourlyUsd,
    sessionHours,
    perSessionUsd: sessionHours === undefined ? undefined : totalHourlyUsd * sessionHours,
    perDayIfLeftRunningUsd: alwaysOnHourlyUsd * 24,
    alwaysOnWarnings,
    unpricedResourceTypes,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export function parseEstimatedDurationHours(input: string): number | undefined {
  const normalized = input.trim();
  if (normalized.length === 0) return undefined;
  const hourMinute =
    /(\d+(?:\.\d+)?)\s*(?:h|hr|hour|hours|時間)\s*(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes|分)/i.exec(
      normalized,
    );
  if (hourMinute?.[1] && hourMinute[2]) {
    return Number(hourMinute[1]) + Number(hourMinute[2]) / 60;
  }

  const numbers = [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length === 0) return undefined;
  const average = sum(numbers) / numbers.length;
  if (/(h|hr|hour|hours)\b/i.test(normalized) || normalized.includes("時間")) return average;
  if (/(m|min|minute|minutes)\b/i.test(normalized) || normalized.includes("分")) {
    return average / 60;
  }
  return undefined;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

export function formatHours(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return `${value.toFixed(value >= 1 ? 2 : 3)}h`;
}
