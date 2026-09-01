import type { CollectionTag, ScalarTag } from "yaml";
import { parse as parseYaml } from "yaml";

export type CostRiskLevel = "none" | "low" | "medium" | "high" | "critical" | "unknown";

export interface ResourceCostHeuristic {
  readonly alwaysOn: boolean;
  readonly riskLevel: CostRiskLevel;
  readonly note: string;
}

export interface CostedResource {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly alwaysOn: boolean;
  readonly riskLevel: CostRiskLevel;
  readonly notes: readonly string[];
}

export interface ProblemCostEstimate {
  readonly resources: readonly CostedResource[];
  readonly alwaysOnWarnings: readonly CostedResource[];
  readonly unclassifiedResourceTypes: readonly string[];
}

const CFN_INTRINSIC_TAG_NAMES = [
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
] as const;

// CloudFormation short-form intrinsics appear on scalars (`!Ref Param`), sequences
// (`!GetAtt [Server, PublicIp]`) and mappings (`!Base64 { "Fn::Sub": ... }`). Register
// every form so the parser keeps the value in place instead of reporting an
// unresolved tag; the heuristics below only ever read plain-string properties.
const CFN_YAML_TAGS: readonly (ScalarTag | CollectionTag)[] = CFN_INTRINSIC_TAG_NAMES.flatMap(
  (tag): (ScalarTag | CollectionTag)[] => [
    { tag, resolve: (value: string) => value },
    { tag, collection: "seq", resolve: (node) => node },
    { tag, collection: "map", resolve: (node) => node },
  ],
);

export const RESOURCE_COST_HEURISTICS: Readonly<Record<string, ResourceCostHeuristic>> = {
  "AWS::CloudWatch::Alarm": {
    alwaysOn: false,
    riskLevel: "low",
    note: "CloudWatch alarms are low-cost; verify alarm count for large catalogs.",
  },
  "AWS::DynamoDB::Table": {
    alwaysOn: true,
    riskLevel: "low",
    note: "Provisioned 1 RCU / 1 WCU is tiny but still capacity that remains until teardown.",
  },
  "AWS::EC2::EIP": {
    alwaysOn: true,
    riskLevel: "medium",
    note: "Elastic IP and public IPv4 addresses can bill while allocated.",
  },
  "AWS::EC2::InternetGateway": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Internet gateways do not bill independently.",
  },
  "AWS::EC2::Route": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Route table entries do not bill independently.",
  },
  "AWS::EC2::RouteTable": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Route tables do not bill independently.",
  },
  "AWS::EC2::SecurityGroup": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Security groups do not bill independently.",
  },
  "AWS::EC2::Subnet": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Subnets do not bill independently.",
  },
  "AWS::EC2::SubnetRouteTableAssociation": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Subnet route table associations do not bill independently.",
  },
  "AWS::EC2::VPC": {
    alwaysOn: false,
    riskLevel: "none",
    note: "VPCs do not bill independently.",
  },
  "AWS::EC2::VPCGatewayAttachment": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Gateway attachments do not bill independently.",
  },
  "AWS::EC2::Instance": {
    alwaysOn: true,
    riskLevel: "low",
    note: "EC2 instances bill while running; instance type can raise this estimate.",
  },
  "AWS::EC2::NatGateway": {
    alwaysOn: true,
    riskLevel: "high",
    note: "NAT Gateway bills hourly plus data processing even when idle.",
  },
  "AWS::ElastiCache::CacheCluster": {
    alwaysOn: true,
    riskLevel: "high",
    note: "ElastiCache nodes bill while provisioned.",
  },
  "AWS::ECR::Repository": {
    alwaysOn: false,
    riskLevel: "low",
    note: "ECR repositories bill for stored data, not the empty repository resource itself.",
  },
  "AWS::ECS::Cluster": {
    alwaysOn: false,
    riskLevel: "none",
    note: "ECS clusters do not bill independently.",
  },
  "AWS::ECS::Service": {
    alwaysOn: false,
    riskLevel: "low",
    note: "ECS services do not bill directly; underlying EC2 or Fargate tasks do.",
  },
  "AWS::ElasticLoadBalancing::LoadBalancer": {
    alwaysOn: true,
    riskLevel: "medium",
    note: "Classic Load Balancer bills hourly while provisioned.",
  },
  "AWS::ElasticLoadBalancingV2::LoadBalancer": {
    alwaysOn: true,
    riskLevel: "medium",
    note: "ALB/NLB bills hourly plus LCU/NLCU usage while provisioned.",
  },
  "AWS::ElasticLoadBalancingV2::Listener": {
    alwaysOn: false,
    riskLevel: "none",
    note: "ELB listeners do not bill independently; the load balancer carries the hourly cost.",
  },
  "AWS::ElasticLoadBalancingV2::TargetGroup": {
    alwaysOn: false,
    riskLevel: "none",
    note: "Target groups do not bill independently; the load balancer carries the hourly cost.",
  },
  "AWS::OpenSearchService::Domain": {
    alwaysOn: true,
    riskLevel: "high",
    note: "OpenSearch domains bill for nodes and storage while provisioned.",
  },
  "AWS::RDS::DBInstance": {
    alwaysOn: true,
    riskLevel: "high",
    note: "RDS instances bill while running; storage and backups can add cost.",
  },
  "AWS::Redshift::Cluster": {
    alwaysOn: true,
    riskLevel: "critical",
    note: "Redshift clusters are expensive always-on capacity.",
  },
  "AWS::SageMaker::NotebookInstance": {
    alwaysOn: true,
    riskLevel: "high",
    note: "Notebook instances bill while in service.",
  },
  "AWS::Events::Rule": {
    alwaysOn: false,
    riskLevel: "low",
    note: "EventBridge rules are usage-priced and normally negligible for problem templates.",
  },
  "AWS::IAM::ManagedPolicy": {
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM managed policies do not bill independently.",
  },
  "AWS::IAM::Policy": {
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM policies do not bill independently.",
  },
  "AWS::IAM::Role": {
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM roles do not bill independently.",
  },
  "AWS::IAM::InstanceProfile": {
    alwaysOn: false,
    riskLevel: "none",
    note: "IAM instance profiles do not bill independently.",
  },
  "AWS::Lambda::Function": {
    alwaysOn: false,
    riskLevel: "low",
    note: "Lambda is usage-priced; idle functions do not bill.",
  },
  "AWS::Logs::LogGroup": {
    alwaysOn: false,
    riskLevel: "low",
    note: "Log groups bill for stored and ingested logs, not for an empty group.",
  },
  "AWS::S3::Bucket": {
    alwaysOn: false,
    riskLevel: "low",
    note: "S3 buckets bill for storage and requests, not for an empty bucket.",
  },
  "AWS::Scheduler::Schedule": {
    alwaysOn: false,
    riskLevel: "low",
    note: "EventBridge Scheduler is usage-priced and normally negligible for problem templates.",
  },
  "AWS::SSM::Parameter": {
    alwaysOn: false,
    riskLevel: "low",
    note: "Standard SSM parameters are free at typical problem scale.",
  },
  "AWS::RDS::DBSubnetGroup": {
    alwaysOn: false,
    riskLevel: "none",
    note: "RDS DB subnet groups do not bill independently.",
  },
  "AWS::WAFv2::WebACL": {
    alwaysOn: true,
    riskLevel: "medium",
    note: "WAF web ACLs have a fixed monthly cost plus request and rule charges.",
  },
  "AWS::WAFv2::WebACLAssociation": {
    alwaysOn: false,
    riskLevel: "none",
    note: "WAF associations do not bill independently; the web ACL carries cost.",
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getStringProperty(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  return typeof value === "string" ? value : undefined;
}

function instanceDetails(
  resourceType: string,
  props: Record<string, unknown>,
): { readonly notes: readonly string[]; readonly risk?: CostRiskLevel } {
  if (resourceType !== "AWS::EC2::Instance") return { notes: [] };

  const instanceType = getStringProperty(props, "InstanceType");
  if (!instanceType) return { notes: [] };
  if (!instanceType.includes(".")) {
    return {
      notes: [
        `InstanceType is dynamic (${instanceType}); verify the selected size and current regional price.`,
      ],
    };
  }
  const notes = [`InstanceType=${instanceType}`];
  const risk = isLargeEc2Instance(instanceType) ? "high" : undefined;
  return { notes, risk };
}

function isLargeEc2Instance(instanceType: string): boolean {
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
  const details = instanceDetails(resourceType, props);
  const notes = [
    ...(heuristic
      ? [heuristic.note]
      : [
          "No billing-risk classification yet; verify manually whether this resource can incur charges.",
        ]),
    ...details.notes,
  ];
  return {
    logicalId,
    resourceType,
    alwaysOn: heuristic?.alwaysOn ?? false,
    riskLevel: details.risk ?? heuristic?.riskLevel ?? "unknown",
    notes,
  };
}

function customResourceHeuristic(resourceType: string): ResourceCostHeuristic | undefined {
  if (!resourceType.startsWith("Custom::")) return undefined;
  return {
    alwaysOn: false,
    riskLevel: "low",
    note: "Custom resources are invocation-time Lambda work and do not bill as standing resources.",
  };
}

export function analyzeProblemCost(templateYaml: string): ProblemCostEstimate {
  const parsed = parseYaml(templateYaml, { customTags: [...CFN_YAML_TAGS] });
  const template = isPlainObject(parsed) ? parsed : {};
  const resources = isPlainObject(template.Resources) ? template.Resources : {};
  const costedResources = Object.entries(resources)
    .map(([logicalId, resource]) =>
      isPlainObject(resource) ? costedResourceFromCfn(logicalId, resource) : undefined,
    )
    .filter((entry): entry is CostedResource => entry !== undefined)
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  const alwaysOnWarnings = costedResources.filter((resource) => resource.alwaysOn);
  const unclassifiedResourceTypes = [
    ...new Set(
      costedResources
        .filter((resource) => resource.riskLevel === "unknown")
        .map((resource) => resource.resourceType),
    ),
  ].sort();
  return {
    resources: costedResources,
    alwaysOnWarnings,
    unclassifiedResourceTypes,
  };
}
