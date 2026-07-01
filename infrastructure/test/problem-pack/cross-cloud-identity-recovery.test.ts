/**
 * [Composite Runtime / Issue #2080] Cross-cloud identity recovery composite
 * challenge.
 *
 * Two surfaces are pinned offline (NO network, NO cloud credentials, NO synth):
 *
 *   1. The shipped pack validates with zero diagnostics through the REAL #2088
 *      offline validator, and its metadata declares the exact composite runtime
 *      (aws/cloudformation + gcp/infra-manager) and composite-probe scoring the
 *      issue requires.
 *
 *   2. The problem's pure, dependency-injected end-to-end grader awards points
 *      ONLY on the post-remediation keyless path and fails closed for every
 *      required negative case (broken audience, unbound SA, static-key injection,
 *      one-target-ready, anonymous traffic).
 *
 * The grader is imported directly from the pack so the checked-in artifact is the
 * thing under test -- it never drifts from the suite.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseScoringMetadata } from "@tenkacloud/problem-sdk/internal";
import { describe, expect, it } from "vitest";
import {
  type GraderDeps,
  gradeRecovery,
  RECOVERY_POINTS_ALL_OK,
} from "../../../packs/cross-cloud-identity-recovery/problems/challenges/cross-cloud-identity-recovery/grader/grader";
import { validatePackDirectory } from "../../lib/problem-pack/validate-pack";

/** Repo root is two levels up from `infrastructure/test`. */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PACK_DIR = path.join(REPO_ROOT, "packs", "cross-cloud-identity-recovery");
const METADATA_FILE = path.join(
  PACK_DIR,
  "problems",
  "challenges",
  "cross-cloud-identity-recovery",
  "metadata.json",
);

function readMetadata(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(METADATA_FILE, "utf-8"));
}

/**
 * A fully-remediated, all-green grader input. Each negative test clones this and
 * breaks exactly one thing, so the assertions isolate a single failure mode.
 */
function remediatedDeps(): GraderDeps {
  const audience =
    "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/cross-cloud-recovery/providers/aws-workload";
  return {
    aws: { ready: true, outputs: { RecoveryProbeUrl: "https://probe.example.com" } },
    gcp: {
      ready: true,
      outputs: { protected_endpoint_url: "https://protected.example.com" },
    },
    subject: { awsAccountId: "111122223333", audience },
    providerTrust: {
      trustedAwsAccountId: "111122223333",
      allowedAudiences: [audience],
    },
    serviceAccountBinding: { workloadIdentityUserAwsAccounts: ["111122223333"] },
    protectedEndpoint: {
      allowsAnonymous: false,
      allowedInvokerServiceAccounts: ["protected-caller@proj.iam.gserviceaccount.com"],
      impersonatedServiceAccount: "protected-caller@proj.iam.gserviceaccount.com",
    },
    now: () => 1_000,
  };
}

describe("cross-cloud identity recovery pack (#2080)", () => {
  it("should live outside the core problems/ directory", () => {
    expect(fs.existsSync(PACK_DIR)).toBe(true);
    expect(PACK_DIR).not.toContain(`${path.sep}problems${path.sep}`);
  });

  it("should validate with zero diagnostics", () => {
    const result = validatePackDirectory(PACK_DIR);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.problemIds).toContain("cross-cloud-identity-recovery");
  });

  it("should declare a composite runtime with the two required targets in order", () => {
    const runtime = readMetadata().runtime as {
      kind: string;
      targets: { id: string; provider: string; engine: string; entry: string }[];
    };
    expect(runtime.kind).toBe("composite");
    expect(runtime.targets).toEqual([
      {
        id: "aws-workload",
        provider: "aws",
        engine: "cloudformation",
        entry: "aws/template.yaml",
      },
      { id: "gcp-service", provider: "gcp", engine: "infra-manager", entry: "gcp/terraform" },
    ]);
  });

  it("should declare composite-probe scoring that the SDK parser accepts", () => {
    const scoring = parseScoringMetadata(readMetadata().scoring);
    expect(scoring).toBeDefined();
    expect(scoring?.kind).toBe("composite-probe");
  });

  it("should not commit any static service-account key artifact", () => {
    // Scan the deployable artifacts and docs (not the grader source, whose
    // detection logic legitimately names key markers it must reject).
    const files = walk(PACK_DIR).filter(
      (f) => /\.(ya?ml|tf|json|md)$/.test(f) && !f.includes(`${path.sep}grader${path.sep}`),
    );
    for (const file of files) {
      const contents = fs.readFileSync(file, "utf-8");
      expect(contents).not.toContain("BEGIN PRIVATE KEY");
      // No google_service_account_key resource may exist in the GCP target.
      if (file.endsWith(".tf")) {
        expect(contents).not.toMatch(/resource\s+"google_service_account_key"/);
      }
    }
  });
});

describe("cross-cloud identity recovery grader (#2080)", () => {
  it("should award full points on the remediated end-to-end keyless path", () => {
    const result = gradeRecovery(remediatedDeps());
    expect(result.awarded).toBe(true);
    expect(result.points).toBe(RECOVERY_POINTS_ALL_OK);
    expect(result.reason).toBeUndefined();
  });

  it("should fail when the federation audience claim is broken", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      providerTrust: { ...deps.providerTrust, allowedAudiences: ["//iam.googleapis.com/wrong"] },
    });
    expect(result.awarded).toBe(false);
    expect(result.points).toBe(0);
    expect(result.reason).toBe("broken-audience");
  });

  it("should fail when the workload AWS account is not trusted by the provider", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      providerTrust: { ...deps.providerTrust, trustedAwsAccountId: "000000000000" },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("unauthorized-aws-account");
  });

  it("should fail when the GCP service account is unbound for impersonation", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      serviceAccountBinding: { workloadIdentityUserAwsAccounts: [] },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("unbound-service-account");
  });

  it("should fail when a static service-account key is injected into the call", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      subject: { ...deps.subject, injectedStaticKey: "-----BEGIN PRIVATE KEY-----" },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("static-key-present");
  });

  it("should fail when a static key leaks into a target output", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      gcp: { ready: true, outputs: { leaked: '{"private_key":"x"}' } },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("static-key-present");
  });

  it("should award nothing when AWS is ready but GCP is unavailable", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({ ...deps, gcp: { ready: false, outputs: {} } });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("gcp-not-ready");
  });

  it("should award nothing when GCP is ready but the AWS target is unavailable", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({ ...deps, aws: { ready: false, outputs: {} } });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("aws-not-ready");
  });

  it("should fail when the protected endpoint accepts anonymous traffic", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      protectedEndpoint: { ...deps.protectedEndpoint, allowsAnonymous: true },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("anonymous-traffic-accepted");
  });

  it("should fail when the impersonated SA is not an allowed invoker of the endpoint", () => {
    const deps = remediatedDeps();
    const result = gradeRecovery({
      ...deps,
      protectedEndpoint: {
        ...deps.protectedEndpoint,
        allowedInvokerServiceAccounts: ["someone-else@proj.iam.gserviceaccount.com"],
      },
    });
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe("protected-endpoint-rejected");
  });
});

/** Recursively list every file under a directory (test helper, no deps). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
