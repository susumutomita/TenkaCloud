import { describe, expect, it } from "vitest";
import {
  DEPLOY_AWS_ACCOUNT_ID_PATTERN,
  DEPLOY_AWS_REGION_PATTERN,
  DEPLOY_PROBLEM_ID_PATTERN,
} from "../src/deploy-command-patterns.js";

describe("deploy command patterns (ADR-049 Phase 4 / #2293)", () => {
  it("should accept lowercase problem slugs and reject anything the frozen schema rejects", () => {
    for (const ok of ["a", "hello-world", "a1-b2-c3", "x".repeat(64)]) {
      expect(DEPLOY_PROBLEM_ID_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["", "Hello-World", "hello_world", "-leading", "trailing-", "x".repeat(65)]) {
      expect(DEPLOY_PROBLEM_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  it("should accept exactly 12-digit AWS account ids", () => {
    expect(DEPLOY_AWS_ACCOUNT_ID_PATTERN.test("111111111111")).toBe(true);
    for (const bad of ["", "1234", "1111111111111", "11111111111a"]) {
      expect(DEPLOY_AWS_ACCOUNT_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  it("should accept AWS region names and reject other formats", () => {
    for (const ok of ["ap-northeast-1", "us-east-1", "eu-west-2"]) {
      expect(DEPLOY_AWS_REGION_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["", "AP-NORTHEAST-1", "us-east", "useast1", "us-east-1a"]) {
      expect(DEPLOY_AWS_REGION_PATTERN.test(bad)).toBe(false);
    }
  });
});
