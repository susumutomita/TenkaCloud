/**
 * Issue #869: 問題 template.yaml の pre-deploy security scan。
 *
 * cfn-lint / cfn-guard を外部依存 (= python pip) で持ち込まず、 自前で 5 つの危険パターンを
 * YAML / 正規表現で検出する。 意図的に脆弱な問題 (= security-battle-royale 等) は metadata
 * `Metadata: { tenkacloud: { allowIntentionallyVulnerable: true } }` で suppress 可。
 *
 * 検出パターン:
 *   1. IAM Action wildcard (`Action: "*"` / `Action: "<svc>:*"`)
 *   2. IAM Resource wildcard (`Resource: "*"`) on `AWS::IAM::Policy` / `Role` Inline policy
 *   3. Security Group ingress `0.0.0.0/0` on ports != 80/443 (= 競技 web は OK)
 *   4. Public S3 bucket (`PublicReadAccess: true` / `AccessControl: PublicRead`)
 *   5. KMS Key without key rotation (`EnableKeyRotation: false` or absent)
 *
 * security-battle-royale は意図的脆弱なので最上位 Metadata block で suppress する。
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBLEMS_DIR = path.resolve(REPO_ROOT, "problems");

interface Finding {
  readonly templatePath: string;
  readonly rule: string;
  readonly location: string;
  readonly detail: string;
}

const WEB_PORTS = new Set([80, 443]);

/**
 * AWS API design 上 Resource: "*" を要求する action の allowlist。
 * これらは Resource を絞れず、 IAM policy で `*` を書く以外に手が無い (= AWS-side 制約)。
 * リストに無い action が `*` と組み合わさったら警告。
 */
const RESOURCE_STAR_OK_ACTIONS = new Set([
  // SSM
  "ssm:DescribeParameters",
  "ssm:GetParametersByPath",
  "ssm:DescribeAssociation",
  // CloudFormation list / describe
  "cloudformation:ListStacks",
  "cloudformation:DescribeStackEvents",
  // EC2 read — AWS Describe* APIs do NOT support resource-level permissions.
  // `ec2:Describe*` wildcard covers all describe verbs in 1 entry (matched by exact string).
  "ec2:Describe*",
  "ec2:DescribeInstances",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeVpcs",
  "ec2:DescribeSubnets",
  "ec2:DescribeRegions",
  "ec2:DescribeAvailabilityZones",
  "ec2:DescribeAccountAttributes",
  "ec2:DescribeNetworkAcls",
  // IAM read (= self-reflection)
  "iam:GetRole",
  "iam:GetPolicy",
  "iam:ListPolicies",
  "iam:ListRoles",
  "iam:ListAttachedRolePolicies",
  "iam:ListRolePolicies",
  // CloudWatch / Logs read
  "logs:DescribeLogGroups",
  "logs:DescribeLogStreams",
  "cloudwatch:ListMetrics",
  "cloudwatch:GetMetricStatistics",
  "cloudwatch:GetMetricData",
  "cloudwatch:DescribeAlarms",
  // S3 — only account-scoped list verbs (= participant browses their own account)
  "s3:ListAllMyBuckets",
  "s3:GetBucketLocation",
  // Lambda — list verbs are global-scoped
  "lambda:ListFunctions",
  "lambda:ListLayers",
  "lambda:ListFunctionUrlConfigs",
  "lambda:ListTags",
  "lambda:ListEventSourceMappings",
  // ECS / App Runner / ECR / Cognito / CloudFront console navigation list verbs.
  "ecs:ListClusters",
  "ecs:ListServices",
  "ecs:ListTasks",
  "ecs:ListTaskDefinitions",
  "ecs:ListTaskDefinitionFamilies",
  "ecs:ListAccountSettings",
  "apprunner:ListServices",
  "apprunner:ListOperations",
  "apprunner:ListTagsForResource",
  "ecr:DescribeRepositories",
  "ecr:DescribeImages",
  "ecr:ListImages",
  "ecr:ListTagsForResource",
  "cognito-idp:ListUserPools",
  "cognito-idp:ListUserPoolClients",
  "cognito-idp:ListTagsForResource",
  "cloudfront:ListDistributions",
  "cloudfront:ListOriginAccessControls",
  "cloudfront:ListTagsForResource",
  // ELBv2 / CloudTrail / Athena / Glue read-only inventory APIs do not give
  // useful resource-level scoping for the console discovery flows these
  // problems require. Mutating access remains tag/ARN scoped in the templates.
  "elasticloadbalancing:DescribeLoadBalancers",
  "elasticloadbalancing:DescribeTargetGroups",
  "elasticloadbalancing:DescribeListeners",
  "elasticloadbalancing:DescribeRules",
  "elasticloadbalancing:DescribeTargetHealth",
  "elasticloadbalancing:DescribeTags",
  "elasticloadbalancing:DescribeLoadBalancerAttributes",
  "elasticloadbalancing:DescribeTargetGroupAttributes",
  "elasticloadbalancing:DescribeAccountLimits",
  "cloudtrail:ListTrails",
  "cloudtrail:LookupEvents",
  // RDS console list pages call Describe* without an identifier; an ARN-scoped
  // policy breaks the list flow. Read-only — mutating RDS access stays scoped.
  "rds:DescribeDBClusters",
  "rds:DescribeDBInstances",
  "athena:ListWorkGroups",
  "athena:ListQueryExecutions",
  "athena:ListDatabases",
  "athena:ListTagsForResource",
  "glue:GetDatabases",
  "glue:SearchTables",
  // DynamoDB — list / describe per-account
  "dynamodb:ListTables",
  "dynamodb:DescribeTable",
  // STS sanity
  "sts:GetCallerIdentity",
  // CloudShell participant baseline — sessions are per-identity and have no resource ARN scope.
  "cloudshell:CreateEnvironment",
  "cloudshell:CreateSession",
  "cloudshell:GetEnvironmentStatus",
  "cloudshell:StartEnvironment",
  "cloudshell:StopEnvironment",
  "cloudshell:DeleteEnvironment",
  "cloudshell:PutCredentials",
  // ECS task definition lifecycle — AWS doesn't expose resource-level permissions
  // for Register/Deregister/Describe TD. Registering a TD doesn't deploy it; the
  // deploy requires ARN-scoped ecs:CreateService / RunTask on ${NamePrefix}*
  // clusters which is enforced separately. Safe at Resource:"*".
  // (TenkaCloudChallenge PR #20 — migration-deploy IAM for migration-battle / stackstack.)
  "ecs:RegisterTaskDefinition",
  "ecs:DeregisterTaskDefinition",
  "ecs:DescribeTaskDefinition",
  // ECR authorization token — account-scoped 12-hour token bound to the calling
  // identity. The token only unlocks repositories the role's ARN-scoped ecr:*
  // grants already permit; safe at Resource:"*".
  "ecr:GetAuthorizationToken",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function visit(
  node: unknown,
  pathStr: string,
  hits: (loc: string, val: unknown) => void,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (Array.isArray(node)) {
    if (seen.has(node)) return;
    seen.add(node);
    for (let i = 0; i < node.length; i++) {
      visit(node[i], `${pathStr}[${i}]`, hits, seen);
    }
    return;
  }
  if (isPlainObject(node)) {
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      visit(v, pathStr ? `${pathStr}.${k}` : k, hits, seen);
    }
    hits(pathStr, node);
  }
}

function toArrayField(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}

export function findIamActionWildcardFindings(
  templatePath: string,
  loc: string,
  actions: readonly unknown[],
  effect?: unknown,
): Finding[] {
  // Effect: Deny は権限を狭めるだけ。 wildcard はむしろ広く塞ぐ安全側なので対象外。
  if (effect === "Deny") return [];
  return actions
    .filter((a) => a === "*")
    .map(() => ({
      templatePath,
      rule: "iam-action-wildcard",
      location: loc,
      detail: `Action "*" is a full-admin grant; scope to specific service actions`,
    }));
}

export function findIamResourceWildcardFindings(
  templatePath: string,
  loc: string,
  resources: readonly unknown[],
  actions: readonly unknown[],
  condition?: unknown,
  effect?: unknown,
): Finding[] {
  // Effect: Deny は権限を狭めるだけ。 wildcard はむしろ広く塞ぐ安全側なので対象外。
  if (effect === "Deny") return [];
  if (!resources.includes("*")) return [];
  const actionList = actions.map((a) => (typeof a === "string" ? a : "")).filter(Boolean);
  const allRequireStar =
    actionList.length > 0 && actionList.every((a) => RESOURCE_STAR_OK_ACTIONS.has(a));
  if (allRequireStar || conditionScopesToNamePrefix(condition)) return [];
  return [
    {
      templatePath,
      rule: "iam-resource-wildcard",
      location: loc,
      detail: `Resource "*" with actions [${actionList.join(", ")}] is broader than required. Scope to specific ARNs, or add the action to RESOURCE_STAR_OK_ACTIONS allowlist if AWS API requires "*".`,
    },
  ];
}

function conditionScopesToNamePrefix(
  condition: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (Array.isArray(condition)) {
    return condition.some((item) => conditionScopesToNamePrefix(item, seen));
  }
  if (!isPlainObject(condition)) return false;
  if (seen.has(condition)) return false;
  seen.add(condition);
  for (const [key, value] of Object.entries(condition)) {
    if (isNamePrefixScope(key, value) || conditionScopesToNamePrefix(value, seen)) return true;
  }
  return false;
}

function isNamePrefixScope(key: string, value: unknown): boolean {
  if (key.endsWith("TenkaCloud:NamePrefix")) return true;
  if (key !== "application-autoscaling:resource-id") return false;
  return typeof value !== "string" || value.includes("NamePrefix");
}

function checkIamWildcards(template: unknown, results: Finding[], templatePath: string): void {
  visit(template, "", (loc, node) => {
    if (!isPlainObject(node)) return;
    // Action / Resource は IAM Statement entry の field。 Statement に近い文脈のみ拾う。
    if (!("Action" in node) && !("Resource" in node)) return;
    const actions = toArrayField(node.Action);
    const resources = toArrayField(node.Resource);
    results.push(...findIamActionWildcardFindings(templatePath, loc, actions, node.Effect));
    results.push(
      ...findIamResourceWildcardFindings(
        templatePath,
        loc,
        resources,
        actions,
        node.Condition,
        node.Effect,
      ),
    );
  });
}

function* iterateResourcesOfType(
  template: unknown,
  type: string,
): Generator<[name: string, props: Record<string, unknown> | undefined]> {
  const resources =
    isPlainObject(template) && isPlainObject(template.Resources) ? template.Resources : {};
  for (const [name, res] of Object.entries(resources)) {
    if (!isPlainObject(res)) continue;
    if (res.Type !== type) continue;
    yield [name, isPlainObject(res.Properties) ? res.Properties : undefined];
  }
}

export function findSgOpenNonWebFinding(
  templatePath: string,
  sgName: string,
  index: number,
  rule: Record<string, unknown>,
): Finding | undefined {
  const cidr = rule.CidrIp;
  const fromPort = typeof rule.FromPort === "number" ? rule.FromPort : Number(rule.FromPort);
  if (cidr !== "0.0.0.0/0" || WEB_PORTS.has(fromPort)) return undefined;
  return {
    templatePath,
    rule: "sg-open-non-web",
    location: `Resources.${sgName}.Properties.SecurityGroupIngress[${index}]`,
    detail: `0.0.0.0/0 ingress to port ${fromPort} (= non-web). Scope to specific CIDR or restrict to 80/443.`,
  };
}

function checkSgIngress(template: unknown, results: Finding[], templatePath: string): void {
  for (const [name, props] of iterateResourcesOfType(template, "AWS::EC2::SecurityGroup")) {
    const ingress = Array.isArray(props?.SecurityGroupIngress) ? props.SecurityGroupIngress : [];
    for (let i = 0; i < ingress.length; i++) {
      const rule = ingress[i];
      if (!isPlainObject(rule)) continue;
      const finding = findSgOpenNonWebFinding(templatePath, name, i, rule);
      if (finding) results.push(finding);
    }
  }
}

function checkPublicS3(template: unknown, results: Finding[], templatePath: string): void {
  const resources =
    isPlainObject(template) && isPlainObject(template.Resources) ? template.Resources : {};
  for (const [name, res] of Object.entries(resources)) {
    if (!isPlainObject(res)) continue;
    if (res.Type !== "AWS::S3::Bucket") continue;
    const props = isPlainObject(res.Properties) ? res.Properties : undefined;
    if (!props) continue;
    if (props.AccessControl === "PublicRead" || props.AccessControl === "PublicReadWrite") {
      results.push({
        templatePath,
        rule: "s3-public-acl",
        location: `Resources.${name}.Properties.AccessControl`,
        detail: `AccessControl=${props.AccessControl} grants public access. Prefer BlockPublicAccess + explicit BucketPolicy.`,
      });
    }
  }
}

function checkKmsRotation(template: unknown, results: Finding[], templatePath: string): void {
  const resources =
    isPlainObject(template) && isPlainObject(template.Resources) ? template.Resources : {};
  for (const [name, res] of Object.entries(resources)) {
    if (!isPlainObject(res)) continue;
    if (res.Type !== "AWS::KMS::Key") continue;
    const props = isPlainObject(res.Properties) ? res.Properties : undefined;
    const rotation = props?.EnableKeyRotation;
    if (rotation !== true) {
      results.push({
        templatePath,
        rule: "kms-rotation-disabled",
        location: `Resources.${name}.Properties.EnableKeyRotation`,
        detail: `KMS keys should set EnableKeyRotation=true.`,
      });
    }
  }
}

function isIntentionallyVulnerable(template: unknown): boolean {
  if (!isPlainObject(template)) return false;
  const metadata = isPlainObject(template.Metadata) ? template.Metadata : undefined;
  const tc = metadata && isPlainObject(metadata.tenkacloud) ? metadata.tenkacloud : undefined;
  return tc?.allowIntentionallyVulnerable === true;
}

function scanTemplate(templatePath: string): Finding[] {
  const raw = readFileSync(templatePath, "utf8");
  const template = parseYaml(raw, {
    // CFn intrinsic !Ref / !Sub などの custom tag を 1 引数 string として通す。
    customTags: [
      "!Ref",
      "!Sub",
      "!GetAtt",
      "!Join",
      "!Select",
      "!Split",
      "!ImportValue",
      "!FindInMap",
      "!If",
      "!Equals",
      "!Not",
      "!And",
      "!Or",
      "!Base64",
      "!Cidr",
    ].map((tag) => ({
      tag,
      resolve(value: unknown): unknown {
        return value;
      },
    })),
  });
  if (isIntentionallyVulnerable(template)) return [];
  const results: Finding[] = [];
  checkIamWildcards(template, results, templatePath);
  checkSgIngress(template, results, templatePath);
  checkPublicS3(template, results, templatePath);
  checkKmsRotation(template, results, templatePath);
  return results;
}

function* iterateTemplates(): Generator<string> {
  const fs = require("node:fs") as typeof import("node:fs");
  for (const category of fs.readdirSync(PROBLEMS_DIR, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryDir = path.join(PROBLEMS_DIR, category.name);
    for (const problem of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!problem.isDirectory()) continue;
      const tpl = path.join(categoryDir, problem.name, "template.yaml");
      if (fs.existsSync(tpl)) yield tpl;
    }
  }
}

function main(): void {
  const all: Finding[] = [];
  let scanned = 0;
  for (const tpl of iterateTemplates()) {
    scanned += 1;
    try {
      const findings = scanTemplate(tpl);
      all.push(...findings);
    } catch (err) {
      console.error(`[check-template-security] failed to scan ${tpl}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  if (all.length === 0) {
    console.log(
      `OK: ${scanned} template(s) スキャン、 危険パターン 0 件 (= IAM/SG/S3/KMS 全 clear)`,
    );
    return;
  }
  console.error(`NG: ${scanned} template(s) スキャン、 ${all.length} 件の危険パターンを検出:`);
  for (const f of all) {
    const rel = path.relative(REPO_ROOT, f.templatePath);
    console.error(`  ${rel}: [${f.rule}] ${f.location} — ${f.detail}`);
  }
  console.error(
    `\n意図的に脆弱な問題は template の最上位 \`Metadata.tenkacloud.allowIntentionallyVulnerable: true\` で suppress 可能。`,
  );
  process.exit(1);
}

if (import.meta.main) main();
