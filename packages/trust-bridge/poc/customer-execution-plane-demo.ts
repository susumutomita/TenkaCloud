/**
 * Issue #1727 — Customer Execution Plane proof of concept.
 *
 * Run: `bun packages/trust-bridge/poc/customer-execution-plane-demo.ts`
 *      (or `bun run poc:cep` inside packages/trust-bridge)
 *
 * What it proves, end to end and offline:
 *
 *   - The hosted control plane holds ONLY a signing key. It builds a
 *     `CloudActionIntent`, binds the approved artifact by sha256 digest, binds
 *     the recipient by `audience`, and signs it. It has NO AWS credential and
 *     NO role trusted by the target deployment authority.
 *
 *   - The customer execution plane validates the intent against LOCAL policy the
 *     control plane cannot influence (audience, account allowlist, approved
 *     problem ids, fail-closed PolicyEvaluator, artifact digest + inspector),
 *     then deploys using a LOCAL adapter (here a MockCloudAdapter standing in for
 *     a same-account CloudFormation service role / LocalStack).
 *
 *   - A hosted-control-plane compromise that mints a perfectly signed intent for
 *     an un-approved account / problem / artifact is still rejected, because a
 *     valid signature is authenticity, not authorization.
 *
 * The script asserts every expected outcome and sets a non-zero exit code if any
 * scenario does not behave as documented, so it doubles as an executable spec.
 */

import { createHash } from "node:crypto";
import {
  type ArtifactInspector,
  type CloudActionIntent,
  CustomerExecutionPlane,
  type CustomerExecutionPolicy,
  type ExchangeContext,
  INTENT_VERSION,
  type PolicyEvaluator,
  signIntent,
} from "../src/index.js";
import { MockCloudAdapter } from "../src/mock-cloud-adapter.js";

// --- Shared fixtures -------------------------------------------------------

const CONTROL_PLANE_SIGNING_KEY = new TextEncoder().encode("poc-control-plane-signing-key-hs256");
const APPROVED_TEMPLATE = new TextEncoder().encode(
  [
    "AWSTemplateFormatVersion: '2010-09-09'",
    "Description: net-evo-01 reachability challenge (approved artifact)",
    "Resources:",
    "  CoreInstance:",
    "    Type: AWS::EC2::Instance",
    "    Properties:",
    "      InstanceType: t3.micro",
    "",
  ].join("\n"),
);
const APPROVED_DIGEST = `sha256:${createHash("sha256").update(APPROVED_TEMPLATE).digest("hex")}`;
const PLANE_AUDIENCE = "customer-exec-plane://acme-corp/challenge-ou";
const CHALLENGE_ACCOUNT = "210987654321";

function buildIntent(overrides: Partial<CloudActionIntent> = {}): CloudActionIntent {
  return {
    version: INTENT_VERSION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    audience: PLANE_AUDIENCE,
    source: {
      system: "tenkacloud",
      tenantId: "t-acme",
      eventId: "evt-summer-2026",
      teamId: "team-7",
      problemId: "net-evo-01-reachability",
      deploymentId: "dep-001",
      workloadId: "deploy-worker",
    },
    target: { provider: "aws", providerAccountRef: CHALLENGE_ACCOUNT, region: "us-east-1" },
    action: {
      type: "deploy",
      engine: "cloudformation",
      requestedScopes: ["cloudformation:CreateStack", "ec2:*"],
      artifact: {
        digest: APPROVED_DIGEST,
        mediaType: "application/yaml",
        sizeBytes: APPROVED_TEMPLATE.byteLength,
      },
    },
    constraints: { ttlSeconds: 600, expiresAt: future(600), allowPrivilegeEscalation: false },
    ...overrides,
  };
}

function future(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Hosted control plane: sign only. No AWS credential anywhere in this function. */
function controlPlaneSign(intent: CloudActionIntent): string {
  return signIntent(intent, { secret: CONTROL_PLANE_SIGNING_KEY, kid: "cp-2026" });
}

// --- Customer execution plane configuration (all customer-local) -----------

const localPolicy: CustomerExecutionPolicy = {
  audience: PLANE_AUDIENCE,
  allowedProviderAccountRefs: [CHALLENGE_ACCOUNT], // dedicated challenge account only
  allowedRegions: ["us-east-1"],
  approvedProblemIds: ["net-evo-01-reachability", "stackstack"],
  allowPrivilegeEscalation: false,
  maxTtlSeconds: 900,
};

const budgetPolicyEvaluator: PolicyEvaluator = {
  async evaluate(intent) {
    const cost = intent.constraints.maxEstimatedCostUsd ?? 0;
    if (cost > 5) {
      return {
        decision: "deny",
        reason: `estimated cost ${cost} USD over local cap`,
        policyVersion: "local-1",
      };
    }
    return { decision: "allow", policyVersion: "local-1" };
  },
};

// Artifact safety: reject any approved-but-risky template that creates an IAM user.
const templateInspector: ArtifactInspector = {
  async inspect(_intent, bytes) {
    const text = new TextDecoder().decode(bytes);
    if (/AWS::IAM::User/.test(text)) {
      return { decision: "deny", reason: "template creates a standalone IAM user" };
    }
    return { decision: "allow" };
  },
};

const replayGuard = (() => {
  const seen = new Set<string>();
  return {
    async recordNonce(intent: CloudActionIntent) {
      if (seen.has(intent.nonce)) {
        return "replay" as const;
      }
      seen.add(intent.nonce);
      return "accepted" as const;
    },
  };
})();

const plane = new CustomerExecutionPlane({
  policy: localPolicy,
  verify: { resolveSecret: () => CONTROL_PLANE_SIGNING_KEY, nonceStore: replayGuard },
  policyEvaluator: budgetPolicyEvaluator,
  artifactInspector: templateInspector,
});

// A LOCAL adapter: the customer execution plane's own authority. In production
// this is a same-account CloudFormation service role or LocalStack — never an
// AssumeRole back into a role the hosted control plane trusts.
const localAdapter = new MockCloudAdapter({ provider: "aws", maxTtlSeconds: 900 });

// --- Scenario runner -------------------------------------------------------

let failures = 0;
function check(label: string, pass: boolean, detail: string): void {
  const mark = pass ? "PASS" : "FAIL";
  if (!pass) {
    failures += 1;
  }
  console.log(`  [${mark}] ${label} — ${detail}`);
}

async function run(): Promise<void> {
  console.log("\n=== TenkaCloud Customer Execution Plane PoC (Issue #1727) ===\n");

  // Happy path: approved deploy is authorized, then executed with LOCAL authority.
  console.log("1) Approved deploy through the customer-controlled plane:");
  {
    const token = controlPlaneSign(buildIntent());
    const outcome = await plane.authorize({ token, artifact: { bytes: APPROVED_TEMPLATE } });
    if (outcome.ok) {
      const cred = await localAdapter.exchange(outcome.intent, {} as ExchangeContext);
      check(
        "authorize + local exchange",
        cred.deploymentSignal.status === "SUCCEEDED" && cred.mode === "mock",
        `deployed problem=${outcome.intent.source.problemId} via ${cred.mode} authority (status=${cred.deploymentSignal.status})`,
      );
    } else {
      check(
        "authorize + local exchange",
        false,
        `unexpected rejection ${outcome.stage}/${outcome.reason}`,
      );
    }
  }

  // Rejection battery: each is a perfectly signed intent the control plane could
  // have produced; only customer-local policy stops them.
  console.log("\n2) Rejection battery (valid signature, blocked by local policy):");
  const cases: ReadonlyArray<{
    label: string;
    intent: CloudActionIntent;
    bytes: Uint8Array;
    stage: string;
    reason: string;
  }> = [
    {
      label: "wrong audience",
      intent: buildIntent({ audience: "customer-exec-plane://attacker" }),
      bytes: APPROVED_TEMPLATE,
      stage: "intent-authorization",
      reason: "audience-mismatch",
    },
    {
      label: "account not approved",
      intent: buildIntent({
        target: { provider: "aws", providerAccountRef: "000000000000", region: "us-east-1" },
      }),
      bytes: APPROVED_TEMPLATE,
      stage: "intent-authorization",
      reason: "account-not-allowed",
    },
    {
      label: "problem not approved",
      intent: buildIntent({
        source: { ...buildIntent().source, problemId: "exfiltrate-everything" },
      }),
      bytes: APPROVED_TEMPLATE,
      stage: "intent-authorization",
      reason: "problem-not-approved",
    },
    {
      label: "over budget",
      intent: buildIntent({
        constraints: {
          ttlSeconds: 600,
          expiresAt: future(600),
          allowPrivilegeEscalation: false,
          maxEstimatedCostUsd: 50,
        },
      }),
      bytes: APPROVED_TEMPLATE,
      stage: "intent-authorization",
      reason: "policy-denied",
    },
    {
      label: "tampered artifact bytes",
      intent: buildIntent(),
      bytes: new TextEncoder().encode("Resources:\n  Backdoor:\n    Type: AWS::IAM::Role\n"),
      stage: "artifact-integrity",
      reason: "artifact-digest-mismatch",
    },
  ];

  for (const c of cases) {
    const token = controlPlaneSign(c.intent);
    const outcome = await plane.authorize({ token, artifact: { bytes: c.bytes } });
    const got = outcome.ok ? "ok" : `${outcome.stage}/${outcome.reason}`;
    check(
      c.label,
      !outcome.ok && outcome.stage === c.stage && outcome.reason === c.reason,
      `→ ${got}`,
    );
  }

  // Expired and replay are time/state based.
  console.log("\n3) Time and replay defenses:");
  {
    const expired = controlPlaneSign(
      buildIntent({
        constraints: { ttlSeconds: 1, expiresAt: future(-60), allowPrivilegeEscalation: false },
      }),
    );
    const o = await plane.authorize({ token: expired, artifact: { bytes: APPROVED_TEMPLATE } });
    check("expired intent", !o.ok && o.reason === "expired", `→ ${o.ok ? "ok" : o.reason}`);
  }
  {
    const token = controlPlaneSign(buildIntent());
    const first = await plane.authorize({ token, artifact: { bytes: APPROVED_TEMPLATE } });
    const second = await plane.authorize({ token, artifact: { bytes: APPROVED_TEMPLATE } });
    check(
      "replayed intent",
      first.ok && !second.ok && second.reason === "nonce-replay",
      `first=${first.ok ? "ok" : "rejected"}, second=${second.ok ? "ok" : second.reason}`,
    );
  }

  console.log(
    `\n=== ${failures === 0 ? "ALL SCENARIOS BEHAVED AS SPECIFIED" : `${failures} SCENARIO(S) FAILED`} ===\n`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
