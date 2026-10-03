import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  pluginStateSchemaVersion,
  reconcileStateSchema,
} from "../../lib/problem-deploy/handlers/participant-handler/coordination-state-schema.js";

/**
 * [Issue #3150] Pins every branch of the one function that decides what
 * happens when a persisted row's `stateSchemaVersion` and the currently
 * loaded plugin's disagree. The op path (`coordination-dispatch.ts`), the
 * read-only projection path (same file), and the tick host
 * (`coordination-tick.ts`) all call this instead of deciding on their own --
 * the branches pinned here are the whole contract, not an implementation
 * detail of any one caller.
 */

interface CounterState {
  readonly count: number;
}

function plugin(over: {
  stateSchemaVersion?: number;
  migrateState?: (state: unknown, fromVersion: number) => CounterState;
}): Pick<CoordinationPlugin<CounterState, unknown>, "stateSchemaVersion" | "migrateState"> {
  return over;
}

describe("pluginStateSchemaVersion", () => {
  it("should default an undeclared version to 1", () => {
    expect(pluginStateSchemaVersion(plugin({}))).toBe(1);
  });

  it("should return the declared version", () => {
    expect(pluginStateSchemaVersion(plugin({ stateSchemaVersion: 4 }))).toBe(4);
  });
});

describe("reconcileStateSchema", () => {
  it("should treat a row with no stateSchemaVersion as version 1 -- ok against an undeclared plugin", () => {
    const out = reconcileStateSchema(plugin({}), {
      state: { count: 3 },
      stateSchemaVersion: undefined,
    });
    expect(out).toEqual({ kind: "ok", state: { count: 3 }, migrated: false });
  });

  it("should be ok without migrating when the versions are equal", () => {
    const out = reconcileStateSchema(plugin({ stateSchemaVersion: 2 }), {
      state: { count: 3 },
      stateSchemaVersion: 2,
    });
    expect(out).toEqual({ kind: "ok", state: { count: 3 }, migrated: false });
  });

  /** A rollback: the row was written by a plugin newer than the one now loaded. */
  it("should report newer_row when the row outversions the plugin", () => {
    const out = reconcileStateSchema(plugin({ stateSchemaVersion: 1 }), {
      state: { count: 3 },
      stateSchemaVersion: 2,
    });
    expect(out).toEqual({ kind: "mismatch", reason: "newer_row" });
  });

  it("should report missing_migration when the plugin outversions the row and declares no migrateState", () => {
    const out = reconcileStateSchema(plugin({ stateSchemaVersion: 2 }), {
      state: { count: 3 },
      stateSchemaVersion: 1,
    });
    expect(out).toEqual({ kind: "mismatch", reason: "missing_migration" });
  });

  it("should report missing_migration when the row predates the envelope (stateSchemaVersion undefined = 1) and the plugin is v2", () => {
    const out = reconcileStateSchema(plugin({ stateSchemaVersion: 2 }), {
      state: { count: 3 },
      stateSchemaVersion: undefined,
    });
    expect(out).toEqual({ kind: "mismatch", reason: "missing_migration" });
  });

  it("should migrate and report ok when migrateState succeeds", () => {
    const out = reconcileStateSchema(
      plugin({
        stateSchemaVersion: 2,
        migrateState: (state, fromVersion) => {
          const legacy = state as { legacyCount: number };
          expect(fromVersion).toBe(1);
          return { count: legacy.legacyCount };
        },
      }),
      { state: { legacyCount: 7 }, stateSchemaVersion: 1 },
    );
    expect(out).toEqual({ kind: "ok", state: { count: 7 }, migrated: true });
  });

  it("should report migration_failed when migrateState throws", () => {
    const out = reconcileStateSchema(
      plugin({
        stateSchemaVersion: 2,
        migrateState: () => {
          throw new Error("cannot migrate this row");
        },
      }),
      { state: { count: 3 }, stateSchemaVersion: 1 },
    );
    expect(out).toEqual({
      kind: "mismatch",
      reason: "migration_failed",
      detail: "cannot migrate this row",
    });
  });

  /**
   * A non-Error throw (a plugin is third-party code) must still resolve to
   * `migration_failed`, not propagate and take the caller down with it.
   */
  it("should report migration_failed when migrateState throws a non-Error value", () => {
    const out = reconcileStateSchema(
      plugin({
        stateSchemaVersion: 2,
        migrateState: () => {
          throw "not an Error instance";
        },
      }),
      { state: { count: 3 }, stateSchemaVersion: 1 },
    );
    expect(out).toEqual({
      kind: "mismatch",
      reason: "migration_failed",
      detail: "not an Error instance",
    });
  });
});
