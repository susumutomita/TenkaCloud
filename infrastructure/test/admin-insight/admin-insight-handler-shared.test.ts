import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSharedResources } from "../../lib/admin-insight/handlers/admin-insight-handler/shared";

/**
 * Issue #2440 (ADR-049 §5.1 Phase A5): pure SQL backend (turso|sql) 選択時は Events/Teams
 * table 自体が synth されず env も配線されない。module load (cold start) を fail-fast にすると
 * AdminInsight Lambda が Initialization Error で落ちるため、`EVENTS_TABLE_NAME` /
 * `TEAMS_TABLE_NAME` は空文字 default に緩和した。`DEPLOYMENTS_TABLE_NAME` は引き続き必須
 * (module 評価時に throw)。
 */
describe("AdminInsight buildSharedResources cold start (#2440)", () => {
  beforeEach(() => {
    process.env.DEPLOYMENTS_TABLE_NAME = "Deployments";
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.TEAMS_TABLE_NAME;
  });
  afterEach(() => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.TEAMS_TABLE_NAME;
  });

  it("should not throw and should default eventsTableName/teamsTableName to '' when unset (pure SQL backend cold start)", () => {
    expect(() => buildSharedResources()).not.toThrow();
    const s = buildSharedResources();
    expect(s.eventsTableName).toBe("");
    expect(s.teamsTableName).toBe("");
  });

  it("should still read EVENTS_TABLE_NAME/TEAMS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.EVENTS_TABLE_NAME = "Events";
    process.env.TEAMS_TABLE_NAME = "Teams";
    const s = buildSharedResources();
    expect(s.eventsTableName).toBe("Events");
    expect(s.teamsTableName).toBe("Teams");
  });

  it("should throw when DEPLOYMENTS_TABLE_NAME (still required) is missing", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildSharedResources()).toThrow();
  });
});
