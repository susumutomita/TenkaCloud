import { App, Aspects, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Key } from "aws-cdk-lib/aws-kms";
import { describe, expect, it } from "vitest";
import {
  KMS_PENDING_WINDOW_MAX_DAYS,
  KMS_PENDING_WINDOW_MIN_DAYS,
  KmsKeyShortPendingWindow,
} from "../../lib/cdk-aspect/kms-key-short-pending-window";

/**
 * KMS Key の `PendingWindowInDays` が aspect 適用で caller 指定値になることを pin する。
 * SBT の BashJobRunner が内部で作る CodeBuild encryption key 等、操作者が直接触れない
 * KMS Key にも適用されるべき (全 stack 横断の Aspect)。
 */

function buildHarness(pendingWindow: number): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  new Key(stack, "MyKey");
  Aspects.of(stack).add(new KmsKeyShortPendingWindow(pendingWindow));
  return Template.fromStack(stack);
}

describe("KmsKeyShortPendingWindow", () => {
  it("caller が 7 を渡すと PendingWindowInDays=7 になるべき", () => {
    buildHarness(7).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 7 });
  });

  it("caller が 30 を渡すと PendingWindowInDays=30 になるべき (= production 想定)", () => {
    buildHarness(30).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 30 });
  });

  it("caller が範囲内の任意値 (= 14) を渡すと PendingWindowInDays=14 になるべき", () => {
    buildHarness(14).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 14 });
  });

  it("複数の KMS Key が混在する stack でも全件に同じ値が適用されるべき", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new Key(stack, "KeyA");
    new Key(stack, "KeyB");
    new Key(stack, "KeyC");
    Aspects.of(stack).add(new KmsKeyShortPendingWindow(7));

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
    Aspects.of(stack).add(new KmsKeyShortPendingWindow(7));

    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::KMS::Key", 0);
  });

  describe("validation", () => {
    it("AWS KMS の許容範囲 [7, 30] 外は throw するべき", () => {
      expect(() => new KmsKeyShortPendingWindow(6)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(31)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(0)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(-1)).toThrow(/must be an integer in \[7, 30\]/);
    });

    it("非整数 (= 14.5 / NaN) は throw するべき", () => {
      expect(() => new KmsKeyShortPendingWindow(14.5)).toThrow(/must be an integer/);
      expect(() => new KmsKeyShortPendingWindow(Number.NaN)).toThrow(/must be an integer/);
    });

    it("境界値 (= 7 / 30) は許容すべき", () => {
      expect(() => new KmsKeyShortPendingWindow(KMS_PENDING_WINDOW_MIN_DAYS)).not.toThrow();
      expect(() => new KmsKeyShortPendingWindow(KMS_PENDING_WINDOW_MAX_DAYS)).not.toThrow();
    });
  });
});
