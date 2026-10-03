import type { CoordinationPlugin } from "@tenkacloud/coordination-plugin-sdk";
import type { CoordinationStateRow } from "./coordination-store.js";

/**
 * [Issue #3150] The one place that reconciles a persisted row's schema version
 * against the plugin currently loaded.
 *
 * The issue this closes: plugin state had no version, so new code read old
 * rows unconditionally. `ac26-crypto-battle` hit this four times in one
 * session (missing fields read as `NaN` / silently-stalled distribution /
 * `NaN` scores / a throw) -- three of four failed silently rather than
 * throwing. A version alone does not fix that; a rule for what happens on a
 * mismatch does. This module is that rule, used identically by the op path
 * (`coordination-dispatch.ts`), the read-only projection path (same file),
 * and the tick host (`coordination-tick.ts`) so the three call sites cannot
 * drift into disagreeing about what a mismatch means.
 */

/** A plugin's declared state-schema version, or 1 when it declares none. */
export function pluginStateSchemaVersion(
  plugin: Pick<CoordinationPlugin<unknown, unknown>, "stateSchemaVersion">,
): number {
  return plugin.stateSchemaVersion ?? 1;
}

/** Why a row's schema version could not be reconciled against the plugin's. */
export type StateSchemaMismatchReason =
  | "newer_row"
  | "missing_migration"
  | "migration_failed"
  /**
   * [Issue #3150] plugin 自身の版宣言が契約違反 (= 行と突き合わせる以前の問題)。
   * **{@link reconcileStateSchema} はこれを返さない** -- 唯一の発生源は
   * `coordination-plugin-loader.ts` の `coordinationPluginSchemaDefect` で、 下の突き合わせ表には
   * 現れない。 ここに同居させているのは、 3 経路 (op / projection / tick) から見て「plugin の版が
   * 理由でこの行を進められない」という同じ扱いになるため。
   */
  | "invalid_plugin_schema";

export type StateSchemaReconcile<State> =
  | { readonly kind: "ok"; readonly state: State; readonly migrated: boolean }
  | {
      readonly kind: "mismatch";
      readonly reason: StateSchemaMismatchReason;
      /**
       * `migration_failed` only: what the plugin's `migrateState` threw. Kept
       * for the operator's log line and never sent over HTTP -- a migration
       * that throws and then has its message discarded is a silent failure by
       * another name, which is the thing this issue exists to end.
       */
      readonly detail?: string;
    };

/**
 * Reconciles one persisted row against the currently-loaded plugin.
 *
 * A row written before this issue (or by a plugin that never declared
 * {@link CoordinationPlugin.stateSchemaVersion}) carries no
 * `stateSchemaVersion` at all -- `coordination-store.ts` surfaces that as
 * `undefined`, which this function treats as version 1. That is the only
 * default: an unversioned row is never treated as incompatible on its own.
 *
 * On a mismatch the caller must not touch the row: no `initialState`, no
 * write, no reset. Silently rebuilding a live match's state is exactly the
 * "quietly breaks" failure mode this issue exists to close -- and it is worse
 * than the mismatch, because it discards a real match in progress instead of
 * refusing one request.
 */
export function reconcileStateSchema<State>(
  plugin: Pick<CoordinationPlugin<State, unknown>, "stateSchemaVersion" | "migrateState">,
  row: Pick<CoordinationStateRow, "state" | "stateSchemaVersion">,
): StateSchemaReconcile<State> {
  const rowVersion = row.stateSchemaVersion ?? 1;
  const pluginVersion = pluginStateSchemaVersion(plugin);

  if (rowVersion === pluginVersion) {
    return { kind: "ok", state: row.state as State, migrated: false };
  }
  if (rowVersion > pluginVersion) {
    // The row was written by a NEWER plugin than the one now loaded (a
    // rollback, most often). Reading it as the older shape would be exactly
    // the bug this issue closes, just running backwards.
    return { kind: "mismatch", reason: "newer_row" };
  }
  // rowVersion < pluginVersion: the plugin's shape has moved on. Only a
  // declared `migrateState` may bridge that gap.
  if (typeof plugin.migrateState !== "function") {
    return { kind: "mismatch", reason: "missing_migration" };
  }
  try {
    return { kind: "ok", state: plugin.migrateState(row.state, rowVersion), migrated: true };
  } catch (err) {
    // A throwing migration must not leave the row half-touched. The caller
    // stops here -- no write, no fallback to `initialState`. The message is
    // carried out so the caller can log it; it is never part of a response.
    return {
      kind: "mismatch",
      reason: "migration_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
