import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildScheduledDeployResources,
  buildScheduledTeardownResources,
} from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #2739: pure Turso has no DynamoDB tables or table-name environment variables.
 * Scheduled actions must therefore gate on the selected backend rather than treating
 * absent DynamoDB wiring as a universal dormant signal.
 */

const ENV_KEYS = [
  "CONTROL_DATA_BACKEND",
  "COMPETITOR_ACCOUNTS_TABLE_NAME",
  "EVENTS_TABLE_NAME",
  "DEPLOYMENTS_TABLE_NAME",
  "TEAMS_TABLE_NAME",
  "DEPLOY_EVENT_BUS_NAME",
  "DEPLOY_ENVIRONMENT",
  "BATTLE_PROBLEMS_CATALOG",
] as const;

const saved: Record<string, string | undefined> = {};
const CATALOG = JSON.stringify({ "hello-world": "problems/challenges/hello-world" });

function makeTursoRuntime() {
  return makeTestControlDataRuntime({
    CONTROL_DATA_BACKEND: "turso",
    TURSO_DATABASE_URL: "https://example.turso.io",
    TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/test/turso-token",
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("scheduled EventSharedResources on Turso (#2739)", () => {
  it("should build teardown resources without DynamoDB table-name env variables", () => {
    process.env.CONTROL_DATA_BACKEND = "turso";
    process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
    process.env.DEPLOY_ENVIRONMENT = "test";
    const runtime = makeTursoRuntime();

    const resources = buildScheduledTeardownResources(runtime);

    expect(resources).toBeDefined();
    expect(resources?.runtime).toBe(runtime);
    expect(resources?.eventsTableName).toBe("");
    expect(resources?.deploymentsTableName).toBe("");
    expect(resources?.competitorAccountsTableName).toBe("");
    expect(resources?.teamsTableName).toBe("");
    expect(resources?.eventBusName).toBe("deploy-bus");
    expect(resources?.env).toBe("test");
  });

  it("should build deploy resources without DynamoDB table-name env variables", () => {
    process.env.CONTROL_DATA_BACKEND = "turso";
    process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
    process.env.DEPLOY_ENVIRONMENT = "test";
    process.env.BATTLE_PROBLEMS_CATALOG = CATALOG;

    const resources = buildScheduledDeployResources(makeTursoRuntime());

    expect(resources).toBeDefined();
    expect(resources?.eventsTableName).toBe("");
    expect(resources?.deploymentsTableName).toBe("");
    expect(resources?.teamsTableName).toBe("");
    expect(resources?.competitorAccountsTableName).toBe("");
    expect(resources?.problemsCatalog).toEqual({
      "hello-world": "problems/challenges/hello-world",
    });
  });

  it("should keep deploy dormant on Turso when the problem catalog is empty", () => {
    process.env.CONTROL_DATA_BACKEND = "turso";
    process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
    process.env.DEPLOY_ENVIRONMENT = "test";
    process.env.BATTLE_PROBLEMS_CATALOG = JSON.stringify({});

    expect(buildScheduledDeployResources(makeTursoRuntime())).toBeUndefined();
  });

  it("should preserve the DynamoDB staged-enablement guard when table env variables are absent", () => {
    process.env.CONTROL_DATA_BACKEND = "dynamodb";
    process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
    process.env.DEPLOY_ENVIRONMENT = "test";
    process.env.BATTLE_PROBLEMS_CATALOG = CATALOG;
    const runtime = makeTestControlDataRuntime();

    expect(buildScheduledTeardownResources(runtime)).toBeUndefined();
    expect(buildScheduledDeployResources(runtime)).toBeUndefined();
  });

  it("should fail loudly for an unknown control-data backend", () => {
    process.env.CONTROL_DATA_BACKEND = "sql";
    process.env.DEPLOY_EVENT_BUS_NAME = "deploy-bus";
    process.env.DEPLOY_ENVIRONMENT = "test";

    expect(() => buildScheduledTeardownResources(makeTestControlDataRuntime())).toThrow(
      'Unknown CONTROL_DATA_BACKEND="sql"',
    );
  });
});
