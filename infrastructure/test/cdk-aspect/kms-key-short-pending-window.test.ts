import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Key } from "aws-cdk-lib/aws-kms";
import { describe, expect, it } from "vitest";
import { KmsKeyShortPendingWindow } from "../../lib/cdk-aspect/kms-key-short-pending-window";

/**
 * KMS Key の `PendingWindowInDays` が aspect 適用で 7 日になることを pin する。
 * SBT の BashJobRunner が内部で作る CodeBuild encryption key 等、操作者が直接触れない
 * KMS Key にも適用されるべき (全 stack 横断の Aspect)。
 */

describe("KmsKeyShortPendingWindow", () => {
  it("明示的に作った KMS Key の PendingWindowInDays を 7 にするべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new Key(stack, "MyKey");
    Aspects.of(stack).add(new KmsKeyShortPendingWindow());

    const tpl = Template.fromStack(stack);
    tpl.hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 7 });
  });

  it("複数の KMS Key が混在する stack でも全件に適用されるべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new Key(stack, "KeyA");
    new Key(stack, "KeyB");
    new Key(stack, "KeyC");
    Aspects.of(stack).add(new KmsKeyShortPendingWindow());

    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::KMS::Key", 3);
    const keys = tpl.findResources("AWS::KMS::Key");
    for (const [, resource] of Object.entries(keys)) {
      expect(resource.Properties.PendingWindowInDays).toBe(7);
    }
  });

  it("KMS Key が無い stack には影響しないべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    Aspects.of(stack).add(new KmsKeyShortPendingWindow());

    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::KMS::Key", 0);
  });
});
