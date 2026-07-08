import { describe, expect, it } from "vitest";
import { DeployCreateRequestedDetailSchema } from "../../../lib/problem-deploy/handlers/shared/events";

const VALID_DETAIL = {
  jobId: "job-abc",
  tenantId: "tenant-a",
  problemId: "hello-world",
  problemDir: "problems/challenges/hello-world",
  teamSlug: "team-alpha",
  namePrefix: "tc-hello-world-team-alpha",
  region: "us-east-1",
  awsAccountId: "111111111111",
};

function accepts(problemDir: string): boolean {
  return DeployCreateRequestedDetailSchema.safeParse({ ...VALID_DETAIL, problemDir }).success;
}

describe("DeployCreateRequestedDetailSchema problemDir (#2462)", () => {
  it("should accept the core problems directory form", () => {
    expect(accepts("problems/challenges/hello-world")).toBe(true);
  });

  it("should accept the active pack problems directory form", () => {
    expect(accepts("pack-problems/com.example.cloud-pack/1.0.0/challenges/hello-world")).toBe(true);
  });

  it("should reject traversal through the pack version segment", () => {
    expect(accepts("pack-problems/x/../../problems/y/z")).toBe(false);
  });

  it("should reject a dot-dot run in the pack version segment", () => {
    expect(accepts("pack-problems/com.example.cloud-pack/1..0/challenges/hello-world")).toBe(false);
  });

  it("should reject traversal through the core directory form", () => {
    expect(accepts("problems/../secrets")).toBe(false);
  });

  it("should reject directories outside the supported source prefixes", () => {
    expect(accepts("uploads/challenges/hello-world")).toBe(false);
  });
});
