import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  buildParticipantSharedResources,
  queryTeamItems,
} from "../../lib/problem-deploy/handlers/participant-handler/shared";

/**
 * Issue #1418: 2 つの shared-resource builder (event-handler/shared.ts +
 * participant-handler/shared.ts) は 25-50% branch だった。 既存テストは build を mock するため
 * 実 build が通らない。 getEnv 必須 read、 optional env の default 枝、 parseProblemsDisruptions、
 * feature-flag 判定を pin する。 build は同期で client を構築するだけ (network なし)。
 */
const EVENT_ENV = {
  EVENTS_TABLE_NAME: "Events",
  TEAMS_TABLE_NAME: "Teams",
  DEPLOYMENTS_TABLE_NAME: "Deployments",
  COMPETITOR_ACCOUNTS_TABLE_NAME: "CompetitorAccounts",
  DISRUPTIONS_TABLE_NAME: "Disruptions",
  DEPLOY_EVENT_BUS_NAME: "bus",
  DEPLOY_ENVIRONMENT: "development",
};
const OPTIONAL_KEYS = [
  "PROBLEM_ENDPOINTS_TABLE_NAME",
  "BATTLE_PROBLEMS_SCORING",
  "PROBLEM_ENDPOINTS",
  "BATTLE_PROBLEMS_CATALOG",
  "BATTLE_PROBLEMS_DISRUPTIONS",
  "BATTLE_PROBLEMS_PROVENANCE",
  "BULK_DEPLOY_PAYLOAD_BUCKET",
  "BULK_DEPLOY_VIA_DISTRIBUTED_MAP",
];
const ALL_KEYS = [...Object.keys(EVENT_ENV), ...OPTIONAL_KEYS];

beforeEach(() => {
  for (const [k, v] of Object.entries(EVENT_ENV)) process.env[k] = v;
  for (const k of OPTIONAL_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

describe("buildEventSharedResources", () => {
  it("should read required env, defaulting optionals when absent", () => {
    const s = buildEventSharedResources();
    expect(s.eventsTableName).toBe("Events");
    expect(s.disruptionsTableName).toBe("Disruptions");
    expect(s.bulkDeployPayloadBucket).toBe(""); // BULK_DEPLOY_PAYLOAD_BUCKET ?? ""
    expect(s.useBulkDistributedMap).toBe(false); // flag absent → false
    expect(s.problemsDisruptions).toEqual({}); // BATTLE_PROBLEMS_DISRUPTIONS absent → {}
    expect(s.problemsProvenance).toEqual({}); // BATTLE_PROBLEMS_PROVENANCE absent → {}
    expect(s.ddb).toBeDefined();
    expect(s.events).toBeDefined();
  });

  it("should honor the optional env (bucket / distributed-map flag / disruptions catalog)", () => {
    process.env.BULK_DEPLOY_PAYLOAD_BUCKET = "payloads";
    process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP = "TRUE"; // case-insensitive
    process.env.BATTLE_PROBLEMS_DISRUPTIONS = JSON.stringify({ p1: [{ id: "d1" }] });
    process.env.BATTLE_PROBLEMS_PROVENANCE = JSON.stringify({
      p1: {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: "sha256-abc",
      },
    });
    const s = buildEventSharedResources();
    expect(s.bulkDeployPayloadBucket).toBe("payloads");
    expect(s.useBulkDistributedMap).toBe(true);
    expect(s.problemsDisruptions).toMatchObject({ p1: [{ id: "d1" }] });
    expect(s.problemsProvenance).toEqual({
      p1: {
        source: "pack",
        packId: "com.example.cloud-pack",
        packVersion: "1.0.0",
        contentDigest: "sha256-abc",
      },
    });
  });

  it("should fall back to {} when BATTLE_PROBLEMS_DISRUPTIONS is invalid JSON", () => {
    process.env.BATTLE_PROBLEMS_DISRUPTIONS = "{not json";
    expect(buildEventSharedResources().problemsDisruptions).toEqual({});
  });

  it("should fall back to {} and warn when BATTLE_PROBLEMS_PROVENANCE has an invalid shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.BATTLE_PROBLEMS_PROVENANCE = JSON.stringify({
      p1: { source: "core" },
    });
    expect(buildEventSharedResources().problemsProvenance).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BATTLE_PROBLEMS_PROVENANCE"));
    warn.mockRestore();
  });

  it("should treat a non-true distributed-map flag as false", () => {
    process.env.BULK_DEPLOY_VIA_DISTRIBUTED_MAP = "false";
    expect(buildEventSharedResources().useBulkDistributedMap).toBe(false);
  });

  it("should throw when a required env var is missing", () => {
    delete process.env.EVENTS_TABLE_NAME;
    expect(() => buildEventSharedResources()).toThrow();
  });
});

describe("buildParticipantSharedResources", () => {
  it("should default the endpoints table to '' when unset", () => {
    const s = buildParticipantSharedResources();
    expect(s.tableName).toBe("Deployments");
    expect(s.eventsTableName).toBe("Events");
    expect(s.endpointsTableName).toBe(""); // PROBLEM_ENDPOINTS_TABLE_NAME ?? ""
    expect(s.ddb).toBeDefined();
    expect(s.ssm).toBeDefined();
  });

  it("should use PROBLEM_ENDPOINTS_TABLE_NAME when present", () => {
    process.env.PROBLEM_ENDPOINTS_TABLE_NAME = "Endpoints";
    expect(buildParticipantSharedResources().endpointsTableName).toBe("Endpoints");
  });

  it("should throw when a required env var is missing", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildParticipantSharedResources()).toThrow();
  });
});

describe("queryTeamItems", () => {
  it("should return the queried items", async () => {
    const shared = {
      ddb: { send: vi.fn().mockResolvedValue({ Items: [{ jobId: "j1" }] }) },
      tableName: "Deployments",
    } as unknown as ParticipantSharedResources;
    expect(await queryTeamItems(shared, "key")).toHaveLength(1);
  });

  it("should default to [] when the query returns no Items", async () => {
    const shared = {
      ddb: { send: vi.fn().mockResolvedValue({}) },
      tableName: "Deployments",
    } as unknown as ParticipantSharedResources;
    expect(await queryTeamItems(shared, "key")).toEqual([]);
  });
});
