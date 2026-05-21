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
      "logs:FilterLogEvents",
      "lambda:GetFunction",
    ],
  },
  {
    path: "problems/battles/microservice-migration-battle/template.yaml",
    actions: [
      "ec2:Describe*",
      "ssm:StartSession",
      "ssm:TerminateSession",
      "lambda:GetFunction",
      "scheduler:GetSchedule",
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
 * Issue #1038 P2 #10: ADR-021 (= 「参加者 IAM Role はその問題の resource しか触れない」) を
 * 維持しつつ、 AWS IAM が resource-scope を許さない API (= ec2:Describe* / sts:GetCallerIdentity
 * 等) も使えるようにする。 Resource:"*" は次の条件下でのみ許可:
 *   1. tag-based Condition (= `aws:ResourceTag/TenkaCloud:NamePrefix`) で team scope を強制
 *   2. または特定 Sid (= 後述 allowlist) で metadata-only / self-identity API のみ
 *
 * 旧 ADR-021 が厳格に禁止していた leak (= ssm:DescribeParameters / GetParametersByPath /
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
]);

describe("problem template ParticipantViewerRole (#744)", () => {
  for (const t of TEMPLATES) {
    it(`\${t.path} should declare ParticipantViewerRole and its Output`, () => {
      const template = readTemplate(t.path);
      const role = roleBlock(template);

      expect(template).toContain("TenkaCloudAccountId:");
      expect(template).toContain("ExternalId:");
      expect(role).toContain("Type: AWS::IAM::Role");
      expect(role).toContain(`RoleName: !Sub "\${NamePrefix}-participant-viewer"`);
      expect(role).toContain(`AWS: !Sub "arn:aws:iam::\${TenkaCloudAccountId}:root"`);
      expect(role).toContain("sts:ExternalId: !Ref ExternalId");
      expect(role).toContain("PolicyName: ProblemSpecific");
      // ADR-021 を維持: 各 statement で Resource:"*" 単独 (= no Condition + no allowlisted Sid)
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
          `Sid "${sid}" uses Resource:"*" without Condition and is not allowlisted — JAM/GameDay 前提では参加者 Role の Resource:"*" は tag-based Condition か metadata-only API allowlist が必要 (#820 撤回 / ADR-021)`,
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
