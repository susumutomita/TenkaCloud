import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSharedResources } from "../../lib/admin-insight/handlers/admin-insight-handler/shared";

/**
 * Issue #2440 (ADR-049 §5.1 Phase A5) / #2441 (Phase B PR-6): pure SQL backend (turso|sql)
 * 選択時は Events/Teams/Deployments table 自体が synth されず env も配線されない。module load
 * (cold start) を fail-fast にすると AdminInsight Lambda が Initialization Error で落ちるため、
 * `EVENTS_TABLE_NAME` / `TEAMS_TABLE_NAME` / `DEPLOYMENTS_TABLE_NAME` は全て空文字 default に
 * 緩和した (#2441 で DEPLOYMENTS_TABLE_NAME も揃えた)。
 */
describe("AdminInsight buildSharedResources cold start (#2440 / #2441)", () => {
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

  it("should not throw and should default deploymentsTableName to '' when DEPLOYMENTS_TABLE_NAME is missing (#2441 pure SQL backend cold start)", () => {
    delete process.env.DEPLOYMENTS_TABLE_NAME;
    expect(() => buildSharedResources()).not.toThrow();
    const s = buildSharedResources();
    expect(s.deploymentsTableName).toBe("");
  });

  it("should still read DEPLOYMENTS_TABLE_NAME when present (dynamodb/mirror backend)", () => {
    process.env.DEPLOYMENTS_TABLE_NAME = "Deployments";
    const s = buildSharedResources();
    expect(s.deploymentsTableName).toBe("Deployments");
  });
});
