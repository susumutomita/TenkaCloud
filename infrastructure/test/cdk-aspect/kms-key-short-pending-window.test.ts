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
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, "TestStack");
  new Key(stack, "MyKey");
  Aspects.of(stack).add(new KmsKeyShortPendingWindow(pendingWindow));
  return Template.fromStack(stack);
}

describe("KmsKeyShortPendingWindow", () => {
  it("should set PendingWindowInDays=7 when the caller passes 7", () => {
    buildHarness(7).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 7 });
  });

  it("should set PendingWindowInDays=30 when the caller passes 30 (production)", () => {
    buildHarness(30).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 30 });
  });

  it("should set PendingWindowInDays=14 when the caller passes a value in range (= 14)", () => {
    buildHarness(14).hasResourceProperties("AWS::KMS::Key", { PendingWindowInDays: 14 });
  });

  it("should apply the same value to every KMS Key even in stacks with multiple KMS Keys mixed", () => {
    const app = new App({ autoSynth: false });
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

  it("should leave stacks without KMS Keys untouched", () => {
    const app = new App({ autoSynth: false });
    const stack = new Stack(app, "TestStack");
    Aspects.of(stack).add(new KmsKeyShortPendingWindow(7));

    const tpl = Template.fromStack(stack);
    tpl.resourceCountIs("AWS::KMS::Key", 0);
  });

  describe("validation", () => {
    it("should throw outside the AWS KMS allowed range [7, 30]", () => {
      expect(() => new KmsKeyShortPendingWindow(6)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(31)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(0)).toThrow(/must be an integer in \[7, 30\]/);
      expect(() => new KmsKeyShortPendingWindow(-1)).toThrow(/must be an integer in \[7, 30\]/);
    });

    it("should throw on non-integers (14.5 / NaN)", () => {
      expect(() => new KmsKeyShortPendingWindow(14.5)).toThrow(/must be an integer/);
      expect(() => new KmsKeyShortPendingWindow(Number.NaN)).toThrow(/must be an integer/);
    });

    it("should allow boundary values (7 / 30)", () => {
      expect(() => new KmsKeyShortPendingWindow(KMS_PENDING_WINDOW_MIN_DAYS)).not.toThrow();
      expect(() => new KmsKeyShortPendingWindow(KMS_PENDING_WINDOW_MAX_DAYS)).not.toThrow();
    });
  });
});
