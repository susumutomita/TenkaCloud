import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #2755: SECURITY.md used to describe the competitor IAM role as
 * "least-privilege", but infrastructure/templates/competitor-bootstrap.yaml
 * deliberately attaches the AWS managed AdministratorAccess policy (Issue
 * #721 rationale — granular per-service policies kept missing permissions as
 * new problem templates were added, causing repeated CREATE_FAILED /
 * ROLLBACK_COMPLETE). Public security docs must describe the real trust
 * model instead of a false least-privilege claim: AdministratorAccess is a
 * deliberate, compensated exception scoped to the competitor bootstrap role
 * only, not a precedent for Control Plane / Application Plane / CI /
 * operator roles, which stay least-privilege.
 *
 * This test pins (a) the template still attaches AdministratorAccess with
 * its compensating controls (ExternalId-gated trust policy, 1h
 * MaxSessionDuration), and (b) SECURITY.md documents that exception
 * explicitly and does not claim the competitor role is least-privilege, so
 * CI catches future drift between the two files.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const securityMd = readFileSync(join(REPO_ROOT, "SECURITY.md"), "utf8");
const competitorBootstrapYaml = readFileSync(
  join(REPO_ROOT, "infrastructure/templates/competitor-bootstrap.yaml"),
  "utf8",
);

describe("SECURITY.md matches the competitor-bootstrap.yaml IAM trust model (Issue #2755)", () => {
  it("should keep competitor-bootstrap.yaml attaching AdministratorAccess with its compensating controls", () => {
    expect(competitorBootstrapYaml).toContain("arn:aws:iam::aws:policy/AdministratorAccess");
    expect(competitorBootstrapYaml).toContain("sts:ExternalId: !Ref ExternalId");
    expect(competitorBootstrapYaml).toContain("MaxSessionDuration: 3600");
  });

  it("should explicitly document the AdministratorAccess exception in SECURITY.md", () => {
    expect(securityMd).toContain("AdministratorAccess");
    expect(securityMd).toContain("ExternalId");
    expect(securityMd).toMatch(/1[- ]hour|MaxSessionDuration/);
  });

  it("should not describe the competitor IAM role as least-privilege in SECURITY.md", () => {
    // The false claim reads "role is least-privilege" (is/are immediately
    // followed by the phrase). The correct disclaimer reads "not
    // least-privilege" with other words between "is" and the phrase, so this
    // must not flag the fix itself.
    expect(securityMd).not.toMatch(/\b(?:is|are)\s+least[- ]privilege\b/i);
    expect(securityMd).not.toContain("competitor IAM role is least-privilege");
  });

  it("should still state that Control Plane / operator roles stay least-privilege", () => {
    expect(securityMd).toMatch(/least[- ]privilege/i);
  });

  it("should mention stack deletion as the one-shot revocation path", () => {
    expect(securityMd.toLowerCase()).toMatch(/delet(e|ing) the stack|deleting.{0,20}stack/i);
  });
});
