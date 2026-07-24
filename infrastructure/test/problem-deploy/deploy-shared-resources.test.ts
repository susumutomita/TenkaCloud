import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContext,
  buildSharedResources,
} from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * [Issue #2745 / #2743] `buildSharedResources` is the deploy-handler Lambda's module-scope
 * cold-start bootstrap — it reads every `process.env.*` wiring flag directly and is never
 * exercised by `deploy-handler-index.test.ts` (which stubs the whole function via `vi.mock`) or
 * by `deploy-runtime-dispatch.test.ts` (which builds a `DeployContext` through its own local
 * `buildContext()` test helper, bypassing this production function entirely). That left every
 * env-var fallback branch here uncovered from the day it was written.
 *
 * The infra critical-file coverage ratchet (`make infra-coverage-check`, #2758) flagged a
 * regression on this file when the GCP Terraform materializer (#2745) added the
 * `SOURCE_BUCKET_NAME` field/branch here without a test to match — two new uncovered branches
 * dropped `deploy.ts`'s ratio under the frozen baseline even though no *existing* covered branch
 * was lost. This file closes that gap by exercising every `?? ""` / `|| undefined` fallback in
 * `buildSharedResources` on both sides (present / absent), matching the sibling pattern already
 * used for AdminInsight's own `buildSharedResources`
 * (`test/admin-insight/admin-insight-handler-shared.test.ts`).
 */
describe("deploy-handler buildSharedResources cold start (#2745 / #2743)", () => {
  beforeEach(() => {
    process.env.DEPLOY_ENVIRONMENT = "development";
    process.env.DEPLOY_EVENT_BUS_NAME = "test-bus";
    delete process.env.CHALLENGE_PAYLOAD_BUCKET;
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    delete process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
    delete process.env.SOURCE_BUCKET_NAME;
    delete process.env.SAKURA_APPRUN_BASE_URL;
  });
  afterEach(() => {
    delete process.env.DEPLOY_ENVIRONMENT;
    delete process.env.DEPLOY_EVENT_BUS_NAME;
    delete process.env.CHALLENGE_PAYLOAD_BUCKET;
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    delete process.env.COMPETITOR_ACCOUNTS_TABLE_NAME;
    delete process.env.SOURCE_BUCKET_NAME;
    delete process.env.SAKURA_APPRUN_BASE_URL;
  });

  it("should default every optional wiring field to its dormant value when unset (Lite mode cold start)", () => {
    expect(() => buildSharedResources(makeTestControlDataRuntime())).not.toThrow();
    const shared = buildSharedResources(makeTestControlDataRuntime());
    expect(shared.challengePayloadBucket).toBeUndefined();
    expect(shared.tableName).toBe("");
    expect(shared.competitorAccountsTableName).toBe("");
    expect(shared.sourceBucketName).toBeUndefined();
    expect(shared.sakuraAppRunBaseUrl).toBeUndefined();
  });

  it("should read CHALLENGE_PAYLOAD_BUCKET / DEPLOYMENTS_TABLE_NAME / COMPETITOR_ACCOUNTS_TABLE_NAME / SOURCE_BUCKET_NAME / SAKURA_APPRUN_BASE_URL when present", () => {
    process.env.CHALLENGE_PAYLOAD_BUCKET = "challenge-payload-bucket";
    process.env.DEPLOYMENTS_TABLE_NAME = "Deployments";
    process.env.COMPETITOR_ACCOUNTS_TABLE_NAME = "CompetitorAccounts";
    process.env.SOURCE_BUCKET_NAME = "source-bucket";
    process.env.SAKURA_APPRUN_BASE_URL = "https://apprun.example.invalid";
    const shared = buildSharedResources(makeTestControlDataRuntime());
    expect(shared.challengePayloadBucket).toBe("challenge-payload-bucket");
    expect(shared.tableName).toBe("Deployments");
    expect(shared.competitorAccountsTableName).toBe("CompetitorAccounts");
    expect(shared.sourceBucketName).toBe("source-bucket");
    expect(shared.sakuraAppRunBaseUrl).toBe("https://apprun.example.invalid");
  });

  it("should attach tenantId and a live now() clock via buildContext", () => {
    const shared = buildSharedResources(makeTestControlDataRuntime());
    const ctx = buildContext(shared, "tenant-acme");
    expect(ctx.tenantId).toBe("tenant-acme");
    expect(typeof ctx.now).toBe("function");
    expect(ctx.now()).toBeGreaterThan(0);
  });
});
