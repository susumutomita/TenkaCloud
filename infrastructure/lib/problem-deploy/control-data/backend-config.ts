/**
 * [#2527 Slice 4] `CONTROL_DATA_BACKEND` parsing, extracted verbatim from
 * `runtime-repositories.ts` so backend selection can be reasoned about (and
 * tested) apart from the SSM/libSQL cache and the aggregate resolvers.
 *
 * [#2677] The backend is a two-way choice: `dynamodb` (default) or `turso`
 * (pure SQL, zero DynamoDB tables). The former `sql` alias and the
 * mirror dual-write bridge were removed — an unknown or
 * legacy value fails loudly here (and at synth time in `resolveAppConfig`)
 * instead of silently changing the data path.
 */

export interface RuntimeEnvironment {
  readonly CONTROL_DATA_BACKEND?: string;
  readonly TURSO_DATABASE_URL?: string;
  readonly TURSO_AUTH_TOKEN_PARAMETER_NAME?: string;
  /**
   * [Issue #3151] Overrides the coordination state ceiling on the SQL backends
   * only — see `domain/coordination-budget.ts`. The DynamoDB ceiling is derived
   * from that service's 400 KB item limit and is deliberately not overridable.
   */
  readonly COORDINATION_STATE_MAX_BYTES?: string;
}

export type SelectedBackend = { readonly kind: "dynamodb" } | { readonly kind: "pure" };

export function selectBackend(env: RuntimeEnvironment): SelectedBackend {
  const backend = env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (backend === "dynamodb") return { kind: "dynamodb" };
  if (backend === "turso") return { kind: "pure" };
  throw new Error(
    `Unknown CONTROL_DATA_BACKEND="${env.CONTROL_DATA_BACKEND}" ` +
      "(expected one of: dynamodb, turso).",
  );
}
