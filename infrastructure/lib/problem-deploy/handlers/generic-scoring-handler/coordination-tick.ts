import {
  type CoordinationContext,
  type CoordinationPlugin,
  runTick,
} from "@tenkacloud/coordination-plugin-sdk";
import {
  loadCoordinationPlugin,
  type PluginImporter,
} from "../participant-handler/coordination-plugin-loader.js";
import {
  type CoordinationStoreDeps,
  readCoordinationState,
  writeCoordinationState,
} from "../participant-handler/coordination-store.js";

export interface CoordinationTickInput {
  readonly tenantId: string;
  readonly eventId: string;
  readonly moduleRef: string;
  readonly ctx: CoordinationContext;
  readonly eventNowMs: number;
  readonly nowIso: string;
}

export type CoordinationTickOutcome =
  | { readonly kind: "updated" }
  | { readonly kind: "noop" }
  | { readonly kind: "conflict" }
  | { readonly kind: "plugin_unavailable" };

/**
 * Run one optional coordination tick against the event-scoped shared row.
 * Identity equality is the SDK's no-op contract: plugins return the existing
 * state when time has not crossed a boundary, avoiding a needless DDB write.
 */
export async function tickCoordinationState(
  importer: PluginImporter,
  store: CoordinationStoreDeps,
  input: CoordinationTickInput,
): Promise<CoordinationTickOutcome> {
  const plugin = (await loadCoordinationPlugin(importer, input.moduleRef)) as CoordinationPlugin<
    unknown,
    unknown
  > | null;
  if (!plugin) return { kind: "plugin_unavailable" };

  const existing = await readCoordinationState(store, input.tenantId, input.eventId);
  const state = existing?.state ?? plugin.initialState(input.ctx);
  const next = runTick(plugin, state, input.eventNowMs);
  if (Object.is(next, state)) return { kind: "noop" };

  const written = await writeCoordinationState(
    store,
    input.tenantId,
    input.eventId,
    next,
    existing?.version ?? 0,
    input.nowIso,
  );
  return written.kind === "conflict" ? { kind: "conflict" } : { kind: "updated" };
}
