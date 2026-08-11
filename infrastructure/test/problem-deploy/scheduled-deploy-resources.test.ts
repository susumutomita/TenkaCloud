import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildScheduledDeployResources,
  buildScheduledTeardownResources,
} from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * `buildScheduledDeployResources` の段階的有効化ガード (= teardown 配線の鏡像)。
 *
 * deploy に必須な env が 1 つでも欠けると `undefined` (= dormant) を返し、 reconciler が scheduled
 * deploy を skip して毎分 tick / 採点を壊さないことを pin する。 全 env が揃って初めて有効な
 * EventSharedResources (teamsTableName / problemsCatalog 込み) を返す。
 */

const REQUIRED_ENV = {
  COMPETITOR_ACCOUNTS_TABLE_NAME: "Accounts",
  EVENTS_TABLE_NAME: "Events",
  DEPLOYMENTS_TABLE_NAME: "Deployments",
  TEAMS_TABLE_NAME: "Teams",
  DEPLOY_EVENT_BUS_NAME: "bus",
  DEPLOY_ENVIRONMENT: "test",
  BATTLE_PROBLEMS_CATALOG: JSON.stringify({ "hello-world-battle": "battle/hello-world-battle" }),
} as const;

const ENV_KEYS = [...Object.keys(REQUIRED_ENV), "DISRUPTIONS_TABLE_NAME"] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("buildScheduledDeployResources", () => {
  it("should return undefined when no env is wired (dormant)", () => {
    expect(buildScheduledDeployResources(makeTestControlDataRuntime())).toBeUndefined();
  });

  it.each(
    Object.keys(REQUIRED_ENV),
  )("should return undefined when only %s is missing (every required env is needed)", (missing) => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      if (key !== missing) process.env[key] = value;
    }
    expect(buildScheduledDeployResources(makeTestControlDataRuntime())).toBeUndefined();
  });

  it("should return undefined when BATTLE_PROBLEMS_CATALOG is an empty catalog (no problemDir to resolve)", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    process.env.BATTLE_PROBLEMS_CATALOG = JSON.stringify({});
    expect(buildScheduledDeployResources(makeTestControlDataRuntime())).toBeUndefined();
  });

  it("should build full resources (teams + catalog) when every required env is wired", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    const res = buildScheduledDeployResources(makeTestControlDataRuntime());
    expect(res).toBeDefined();
    expect(res?.eventsTableName).toBe("Events");
    expect(res?.deploymentsTableName).toBe("Deployments");
    expect(res?.teamsTableName).toBe("Teams");
    expect(res?.competitorAccountsTableName).toBe("Accounts");
    expect(res?.eventBusName).toBe("bus");
    expect(res?.env).toBe("test");
    expect(res?.problemsCatalog).toEqual({
      "hello-world-battle": "battle/hello-world-battle",
    });
    // reconciler は旧 fan-out 経路を使うので Distributed Map は無効固定。
    expect(res?.useBulkDistributedMap).toBe(false);
    expect(res?.bulkDeployPayloadBucket).toBe("");
  });

  it("should default DISRUPTIONS_TABLE_NAME to empty string when unset", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    const res = buildScheduledDeployResources(makeTestControlDataRuntime());
    expect(res?.disruptionsTableName).toBe("");
  });

  it("should place the injected runtime on the built resources", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    const runtime = makeTestControlDataRuntime();
    expect(buildScheduledDeployResources(runtime)?.runtime).toBe(runtime);
  });

  // [#2571] Before this fix, the scheduled auto-deploy path bypassed even the
  // v1 `unsupportedRuntime` refusal gate for non-AWS single-provider problems
  // (silent skip — the core #2571 bug), because neither `ssm` nor
  // `resolveProblemRuntimeDescriptor` were wired here. The generic-scoring
  // Lambda already carries the SSM read + kms:Decrypt IAM grants for the
  // sakura/azure/gcp credential parameter paths, so wiring `ssm` here needs no
  // new IAM.
  it("should wire ssm + sakuraAppRunBaseUrl + resolveProblemRuntimeDescriptor for adapter dispatch (#2571)", () => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    process.env.SAKURA_APPRUN_BASE_URL = "https://apprun.example.test";
    process.env.BATTLE_PROBLEMS_RUNTIMES = JSON.stringify({
      "gcp-problem": { provider: "gcp", engine: "infra-manager", entry: "template.yaml" },
    });
    const res = buildScheduledDeployResources(makeTestControlDataRuntime());
    expect(res?.ssm).toBeDefined();
    expect(res?.sakuraAppRunBaseUrl).toBe("https://apprun.example.test");
    expect(res?.resolveProblemRuntimeDescriptor?.("gcp-problem")).toEqual({
      provider: "gcp",
      engine: "infra-manager",
      entry: "template.yaml",
    });
    delete process.env.SAKURA_APPRUN_BASE_URL;
    delete process.env.BATTLE_PROBLEMS_RUNTIMES;
  });
});

/**
 * `buildScheduledTeardownResources` の段階的有効化ガード (deploy 側の鏡像)。
 * teardown は Teams / catalog を使わないため必須 env が deploy より狭い。
 */
describe("buildScheduledTeardownResources", () => {
  const TEARDOWN_REQUIRED_ENV = {
    COMPETITOR_ACCOUNTS_TABLE_NAME: "Accounts",
    EVENTS_TABLE_NAME: "Events",
    DEPLOYMENTS_TABLE_NAME: "Deployments",
    DEPLOY_EVENT_BUS_NAME: "bus",
    DEPLOY_ENVIRONMENT: "test",
  } as const;

  it("should return undefined when no env is wired (dormant)", () => {
    expect(buildScheduledTeardownResources(makeTestControlDataRuntime())).toBeUndefined();
  });

  it.each(
    Object.keys(TEARDOWN_REQUIRED_ENV),
  )("should return undefined when only %s is missing (every required env is needed)", (missing) => {
    for (const [key, value] of Object.entries(TEARDOWN_REQUIRED_ENV)) {
      if (key !== missing) process.env[key] = value;
    }
    expect(buildScheduledTeardownResources(makeTestControlDataRuntime())).toBeUndefined();
  });

  it("should build teardown resources with the injected runtime and safe placeholders", () => {
    for (const [key, value] of Object.entries(TEARDOWN_REQUIRED_ENV)) process.env[key] = value;
    const runtime = makeTestControlDataRuntime();
    const res = buildScheduledTeardownResources(runtime);
    expect(res).toBeDefined();
    expect(res?.runtime).toBe(runtime);
    expect(res?.eventsTableName).toBe("Events");
    expect(res?.deploymentsTableName).toBe("Deployments");
    expect(res?.competitorAccountsTableName).toBe("Accounts");
    expect(res?.eventBusName).toBe("bus");
    expect(res?.env).toBe("test");
    // teardown 未使用 field は安全な placeholder (bulkTeardownEvent は参照しない)。
    expect(res?.teamsTableName).toBe("");
    expect(res?.problemsCatalog).toEqual({});
    expect(res?.useBulkDistributedMap).toBe(false);
    // [#2571] ssm は adapter dispatch 用に無条件で wire される。
    expect(res?.ssm).toBeDefined();
    expect(res?.sakuraAppRunBaseUrl).toBeUndefined();
  });

  // [#2571] Before this fix, `bulkTeardownEvent`'s non-AWS adapter branch was
  // dormant even on the scheduled reconciler path because `ssm` /
  // `sakuraAppRunBaseUrl` were never wired here — a non-AWS single-provider
  // deployment would leak its cloud resources when torn down by the auto
  // teardown tick. The generic-scoring Lambda already carries the SSM read +
  // kms:Decrypt IAM grants for the sakura/azure/gcp credential parameter
  // paths, so wiring `ssm` here needs no new IAM.
  it("should wire ssm + sakuraAppRunBaseUrl for adapter dispatch (#2571)", () => {
    for (const [key, value] of Object.entries(TEARDOWN_REQUIRED_ENV)) process.env[key] = value;
    process.env.SAKURA_APPRUN_BASE_URL = "https://apprun.example.test";
    const res = buildScheduledTeardownResources(makeTestControlDataRuntime());
    expect(res?.ssm).toBeDefined();
    expect(res?.sakuraAppRunBaseUrl).toBe("https://apprun.example.test");
    delete process.env.SAKURA_APPRUN_BASE_URL;
  });
});
