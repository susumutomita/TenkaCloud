import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ConsoleViewerRole } from "../../lib/problem-deploy/console-viewer-role.js";

/**
 * #704: 旧 `ReadOnlyAccess` 経路では competitor が AWS Console から operator の
 * CodePipeline / CodeBuild / 他テナント tc-* stack を閲覧できてしまった。
 * 本テストは Role に managed policy が無いこと + inline policy が `tc-*` 接頭辞に
 * 絞られていることを保証する。
 */
describe("ConsoleViewerRole (#704)", () => {
  function synthRole(): Template {
    const app = new App();
    const stack = new Stack(app, "TestStack", {
      env: { account: "123456789012", region: "ap-northeast-1" },
    });
    new ConsoleViewerRole(stack, "ConsoleViewer");
    return Template.fromStack(stack);
  }

  it("ReadOnlyAccess の AWS managed policy を attach していないべき", () => {
    const template = synthRole();
    const roles = template.findResources("AWS::IAM::Role");
    const role = Object.values(roles)[0] as {
      Properties: { ManagedPolicyArns?: unknown[] };
    };
    expect(role.Properties.ManagedPolicyArns ?? []).toEqual([]);
  });

  it("inline TcReadOnly policy の cloudformation/logs/lambda/s3 Allow が tc-* 接頭辞に scope されているべき", () => {
    const template = synthRole();
    const role = Object.values(template.findResources("AWS::IAM::Role"))[0] as {
      Properties: {
        Policies?: Array<{
          PolicyName: string;
          PolicyDocument: {
            Statement: Array<{
              Effect: string;
              Action: string | string[];
              Resource: string | string[];
            }>;
          };
        }>;
      };
    };
    const tcPolicy = role.Properties.Policies?.find((p) => p.PolicyName === "TcReadOnly");
    expect(tcPolicy).toBeDefined();

    const flatten = (r: string | string[]) => (Array.isArray(r) ? r : [r]);
    const allowResources = tcPolicy?.PolicyDocument.Statement.filter((s) => s.Effect === "Allow")
      .flatMap((s) => flatten(s.Resource))
      .filter((r) => r !== "*");

    expect(allowResources?.some((r) => r === "arn:aws:cloudformation:*:*:stack/tc-*")).toBe(true);
    expect(allowResources?.some((r) => r === "arn:aws:logs:*:*:log-group:/aws/lambda/tc-*")).toBe(
      true,
    );
    expect(allowResources?.some((r) => r === "arn:aws:lambda:*:*:function:tc-*")).toBe(true);
    expect(allowResources?.some((r) => r === "arn:aws:s3:::tc-*")).toBe(true);
  });

  it("MaxSessionDuration は federation TTL と揃えて 1h にすべき", () => {
    const template = synthRole();
    template.hasResourceProperties("AWS::IAM::Role", { MaxSessionDuration: 3600 });
  });
});
