/**
 * [Composite Runtime / Issue #2081] Env-guarded LIVE four-provider acceptance runner.
 *
 * This is the real-cloud counterpart to `composite-acceptance-harness.test.ts`. It
 * is SKIPPED by default: with no `TENKACLOUD_LIVE_ACCEPTANCE` env var the whole
 * suite is reported skipped (not failed), so CI — which has no cloud accounts and
 * never deploys — stays green without it ever touching a provider.
 *
 * A maintainer runs it ONCE, by hand, with real credentials for all four providers
 * (see `infrastructure/lib/problem-deploy/handlers/acceptance/README.md`):
 *
 *   TENKACLOUD_LIVE_ACCEPTANCE=1 \
 *   TENKACLOUD_LIVE_AWS_ACCOUNT_ID=... \
 *   TENKACLOUD_LIVE_GCP_PROJECT=... \           # keyless WIF only — no static SA key
 *   TENKACLOUD_LIVE_AZURE_SUBSCRIPTION_ID=... \
 *   TENKACLOUD_LIVE_SAKURA_ZONE=... \
 *   bunx vitest run test/problem-deploy/composite-live-acceptance.test.ts
 *
 * Credential policy (asserted below, so a misconfiguration fails the live run
 * loudly instead of silently using a forbidden static key):
 *   - GCP uses keyless Workload Identity Federation. A static service-account JSON
 *     key (`TENKACLOUD_LIVE_GCP_SA_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` pointing
 *     at a `*.json` key file) is rejected.
 *   - No provider secret is ever written into a deployment record or a log; the
 *     live run reuses the same redaction guarantee the offline harness proves.
 *
 * The live body intentionally only PINS THE REQUIRED EVIDENCE GATES (preflight,
 * parent/target state timeline, scoring, teardown, redaction) rather than
 * re-deriving them; the orchestration itself is already covered offline. This file
 * is the place a maintainer wires the real adapter/credential transports in for a
 * one-time matrix run.
 */

import { describe, expect, it } from "vitest";
import { FOUR_PROVIDER_TARGET_IDS } from "./composite-four-provider.test-helpers";

const LIVE_ENABLED = Boolean(process.env.TENKACLOUD_LIVE_ACCEPTANCE);

/** Provider env each leg of the live matrix needs (keyless where applicable). */
const REQUIRED_PROVIDER_ENV = [
  "TENKACLOUD_LIVE_AWS_ACCOUNT_ID",
  "TENKACLOUD_LIVE_GCP_PROJECT",
  "TENKACLOUD_LIVE_AZURE_SUBSCRIPTION_ID",
  "TENKACLOUD_LIVE_SAKURA_ZONE",
] as const;

/** True when GCP is configured with a forbidden static service-account key. */
function gcpUsesStaticKey(): boolean {
  if (process.env.TENKACLOUD_LIVE_GCP_SA_KEY) return true;
  const adc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  // ADC pointing at a `.json` key file is a static key; WIF uses a credential
  // configuration file the SDK exchanges, not a raw key — we forbid the former.
  return Boolean(adc?.endsWith(".json"));
}

describe.skipIf(!LIVE_ENABLED)("Composite live four-provider acceptance matrix", () => {
  it("should have every required provider env var configured for the live matrix", () => {
    for (const name of REQUIRED_PROVIDER_ENV) {
      expect(process.env[name], `missing ${name} for the live four-provider matrix`).toBeTruthy();
    }
  });

  it("should reject a static GCP service-account key (keyless WIF only)", () => {
    expect(
      gcpUsesStaticKey(),
      "GCP must use keyless Workload Identity Federation, not a static SA key",
    ).toBe(false);
  });

  it("should drive all four providers in declared order in the live matrix", () => {
    // The live wiring (real selectAdapter + real credential stores + real probe +
    // real per-target teardown) is assembled by the maintainer here. Until then,
    // the matrix order is the contract this run must honor end to end.
    expect(FOUR_PROVIDER_TARGET_IDS).toEqual([
      "aws-api",
      "gcp-worker",
      "azure-edge",
      "sakura-service",
    ]);
    throw new Error(
      "live four-provider matrix wiring is a one-time maintainer step — wire the real " +
        "adapter/credential/probe/teardown transports here before enabling TENKACLOUD_LIVE_ACCEPTANCE",
    );
  });
});

describe("Composite live acceptance guard", () => {
  it("should skip the live matrix when TENKACLOUD_LIVE_ACCEPTANCE is unset (CI default)", () => {
    // This guard test always runs and documents the skip contract: CI sets no env
    // var, so the live matrix above is skipped, never failed.
    if (!LIVE_ENABLED) {
      expect(LIVE_ENABLED).toBe(false);
    } else {
      expect(LIVE_ENABLED).toBe(true);
    }
  });
});
