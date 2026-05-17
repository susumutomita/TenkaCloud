import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../..");

const TEMPLATES = [
  {
    path: "problems/challenges/hello-world/template.yaml",
    actions: ["ssm:GetParameter", "cloudformation:DescribeStacks"],
  },
  {
    path: "problems/battles/hello-world-battle/template.yaml",
    actions: [
      "ec2:DescribeInstances",
      "ssm:StartSession",
      "ssm:TerminateSession",
      "cloudformation:DescribeStacks",
      "logs:FilterLogEvents",
    ],
  },
  {
    path: "problems/battles/security-battle-royale/template.yaml",
    actions: [
      "ec2:DescribeInstances",
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
      "ec2:DescribeInstances",
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

describe("problem template ParticipantViewerRole (#744)", () => {
  for (const t of TEMPLATES) {
    it(`${t.path} は ParticipantViewerRole と Output を宣言すべき`, () => {
      const template = readTemplate(t.path);
      const role = roleBlock(template);

      expect(template).toContain("TenkaCloudAccountId:");
      expect(template).toContain("ExternalId:");
      expect(role).toContain("Type: AWS::IAM::Role");
      expect(role).toContain(`RoleName: !Sub "\${NamePrefix}-participant-viewer"`);
      expect(role).toContain(`AWS: !Sub "arn:aws:iam::\${TenkaCloudAccountId}:root"`);
      expect(role).toContain("sts:ExternalId: !Ref ExternalId");
      expect(role).toContain("PolicyName: ProblemSpecific");
      // Issue #820 撤回 / ADR-021: AWS JAM/GameDay 前提 — 参加者の IAM Role は
      // **その問題の resource しか触れない** を IAM レベルで強制する。 旧 policy は
      // \`ssm:DescribeParameters\` / \`ssm:GetParametersByPath\` / \`cloudformation:ListStacks\`
      // を Resource:* で付与しており、 CLI 越しに platform / 他 tenant の Parameter Store と
      // CFn stack の存在 / 値が見えていた (= security 事故レベル)。 list 系 IAM action は
      // 一切付与しない。 Resource:"*" がどの statement にあっても test を fail させる。
      const statements = role.split(/^\s+- Sid: /m).slice(1);
      for (const stmt of statements) {
        const sid = stmt.split(/\s/, 1)[0] ?? "";
        const hasWildcard = stmt.includes('Resource: "*"') || stmt.includes("Resource: '*'");
        expect(
          hasWildcard,
          `Sid "${sid}" uses Resource:"*" — JAM/GameDay 前提では参加者 Role に list 系を付与しない方針 (#820 撤回)`,
        ).toBe(false);
      }
      expect(template).toContain("ParticipantViewerRoleArn:");
      expect(template).toContain("Value: !GetAtt ParticipantViewerRole.Arn");

      for (const action of t.actions) {
        expect(role).toContain(action);
      }
    });
  }
});
