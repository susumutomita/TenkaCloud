import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");

const TEMPLATES = [
  {
    path: "problems/challenges/hello-world/template.yaml",
    actions: ["ssm:GetParameter"],
  },
  {
    path: "problems/battles/hello-world-battle/template.yaml",
    actions: ["ec2:Describe*", "ssm:StartSession", "ssm:TerminateSession", "logs:FilterLogEvents"],
  },
  {
    path: "problems/battles/security-battle-royale/template.yaml",
    actions: [
      "ec2:Describe*",
      "ssm:StartSession",
      "ssm:TerminateSession",
      "cloudformation:DescribeStacks",
    ],
  },
  {
    path: "problems/battles/microservice-migration-battle/template.yaml",
    actions: [
      "ec2:Describe*",
      "ssm:StartSession",
      "ssm:TerminateSession",
      "lambda:GetFunction",
      // scheduler:GetSchedule was dropped in catalog #167, which removed the
      // self-firing EventBridge Scheduler (it duplicated the phase disruption
      // and never reverted). The participant role no longer touches Scheduler.
      "logs:FilterLogEvents",
    ],
  },
] as const;

function readTemplate(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function roleBlock(template: string): string {
  const start = template.indexOf("\n  ParticipantViewerRole:");
  const end = template.indexOf("\nOutputs:");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return template.slice(start, end);
}

/**
 * Issue #1038 P2 #10: 参加者 IAM Role の problem resource isolation を
 * 維持しつつ、AWS IAM が resource-scope を許さない API (= ec2:Describe* / sts:GetCallerIdentity
 * 等) も使えるようにする。 Resource:"*" は次の条件下でのみ許可:
 *   1. tag-based Condition (= `aws:ResourceTag/TenkaCloud:NamePrefix`) で team scope を強制
 *   2. または特定 Sid (= 後述 allowlist) で metadata-only / self-identity API のみ
 *
 * この guard は従来から禁止していた leak (= ssm:DescribeParameters / GetParametersByPath /
 * cloudformation:ListStacks の Resource:* with no Condition) は引き続き fail させる。
 */
const RESOURCE_STAR_OK_SIDS = new Set([
  // metadata-only API (= no per-team resource leak、 per-team dedicated AWS account 前提で安全)
  "ConsoleEc2Metadata",
  // self-identity (= sts:GetCallerIdentity は呼び出し元 token を返すだけ)
  "ConsoleSelfIdentity",
  // Issue #1198 (#1208 follow-up): CloudShell launch action は session 用 per-team
  // dedicated AWS account に閉じる (= 他 tenant の cloudshell に触れない)。
  // Resource-level scope は CloudShell API が持たないため、 Resource:"*" 必須。
  "OpenCloudShellSession",
  // TenkaCloudChallenge PR #20 (migration deploy IAM):
  // ecs:RegisterTaskDefinition / DeregisterTaskDefinition / DescribeTaskDefinition
  // は AWS 仕様で resource-level permission を受け付けない。 単独では tenant 越境
  // にならない — 登録した TD を deploy するには ecs:CreateService / RunTask が必要で、
  // それらは ${NamePrefix}* な cluster / service ARN にスコープ済み。
  "ManageOwnTaskDefinitions",
  // TenkaCloudChallenge PR #20 (migration deploy IAM):
  // ecr:GetAuthorizationToken は account-scoped で 12 時間 token を返すだけ。
  // token は呼び出し元 identity に bind されており、 そのうえで repository ARN ベース
  // の ecr:* grant が掛かっている範囲 (= ${NamePrefix}*) しか push/pull できない。
  "EcrAuthForOwnPush",
  // TenkaCloudChallenge PR #23 (catalog promotion: microservice-migration-battle / stackstack):
  // elasticloadbalancing:Describe* は AWS IAM 仕様で resource-level permission も
  // tag-based Condition も受け付けない metadata-only API。 ec2:Describe* と同じ扱い
  // (= 参加者は console / CLI で自分の LB / TG / Listener / TargetHealth を観測する
  // のに必要)。 per-team dedicated AWS account 前提で cross-tenant leak リスクなし。
  "ReadLoadBalancerState",
  // TenkaCloudChallenge PR #25: microservice-migration-battle intentionally
  // allows Console navigation list APIs. These reveal account-local names but
  // do not grant cross-resource access; mutating/inspect grants remain
  // ${NamePrefix}*-scoped in the same role.
  "ConsoleListLambda",
  "ConsoleListEcs",
  "ConsoleListAppRunner",
  "ConsoleListEcr",
  "ConsoleListLogs",
  "ConsoleListIamRoles",
  // Issue #1316: hello-world hint で案内している AWS Console の SSM Parameter
  // detail page は navigation chrome (sidebar list / breadcrumb) で
  // ssm:DescribeParameters を呼ぶ。 これは AWS IAM 仕様で resource-level perm
  // を受け付けない metadata-only API。 per-team dedicated AWS account 前提で
  // cross-tenant leak リスクなし。 ConsoleEc2Metadata / ManageOwnTaskDefinitions
  // / ReadLoadBalancerState と同じ扱い。
  "DescribeOwnParameters",
]);

describe("problem template ParticipantViewerRole (#744)", () => {
  for (const t of TEMPLATES) {
    it(`\${t.path} should declare ParticipantViewerRole and its Output`, () => {
      const template = readTemplate(t.path);
      const role = roleBlock(template);

      expect(template).toContain("TenkaCloudAccountId:");
      expect(template).toContain("ExternalId:");
      expect(role).toContain("Type: AWS::IAM::Role");
      // TenkaCloudChallenge #77 dropped the explicit `RoleName: !Sub "${NamePrefix}-participant-viewer"`:
      // `${NamePrefix}` (= tc-{problemSlug}-{teamSlug}) overflowed IAM's 64-char RoleName limit for long
      // slugs, blocking deploys. CloudFormation now auto-names the role. This is safe (so RoleName is no
      // longer asserted): the role is consumed by its GetAtt ARN via the `ParticipantViewerRoleArn`
      // Output (asserted below), the cross-account AssumeRole caller (CompetitorDeployRole) holds
      // AdministratorAccess, and the trust is account-id + ExternalId based — all name-independent.
      expect(role).toContain(`AWS: !Sub "arn:aws:iam::\${TenkaCloudAccountId}:root"`);
      expect(role).toContain("sts:ExternalId: !Ref ExternalId");
      expect(role).toContain("PolicyName: ProblemSpecific");
      // Problem resource isolation を維持: 各 statement で Resource:"*" 単独
      // (= no Condition + no allowlisted Sid)
      // を禁止する。 旧 ssm:DescribeParameters / GetParametersByPath / cloudformation:ListStacks
      // を Resource:* で付与していた policy が platform / 他 tenant の Parameter Store と
      // CFn stack を CLI 越しに leak していた問題 (= security 事故) の再発防止。
      const statements = role.split(/^\s+- Sid: /m).slice(1);
      for (const stmt of statements) {
        const sid = stmt.split(/\s/, 1)[0] ?? "";
        const hasWildcard = stmt.includes('Resource: "*"') || stmt.includes("Resource: '*'");
        if (!hasWildcard) continue;
        const hasCondition = /^\s+Condition:/m.test(stmt);
        const sidAllowlisted = RESOURCE_STAR_OK_SIDS.has(sid);
        expect(
          hasCondition || sidAllowlisted,
          `Sid "${sid}" uses Resource:"*" without Condition and is not allowlisted — JAM/GameDay 前提では参加者 Role の Resource:"*" は tag-based Condition か metadata-only API allowlist が必要 (#820 撤回)`,
        ).toBe(true);
      }
      expect(template).toContain("ParticipantViewerRoleArn:");
      expect(template).toContain("Value: !GetAtt ParticipantViewerRole.Arn");

      for (const action of t.actions) {
        expect(role).toContain(action);
      }
    });
  }
});
