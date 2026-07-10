import type { ControlDataBackend } from "./types.js";

/**
 * [#2527 Slice 4] `CONTROL_DATA_BACKEND` parsing, extracted verbatim from
 * `runtime-repositories.ts` so backend selection can be reasoned about (and
 * tested) apart from the SSM/libSQL cache and the aggregate resolvers.
 */

export interface RuntimeEnvironment {
  readonly CONTROL_DATA_BACKEND?: string;
  readonly TURSO_DATABASE_URL?: string;
  readonly TURSO_AUTH_TOKEN_PARAMETER_NAME?: string;
}

export type SqlDialect = Extract<ControlDataBackend, "turso" | "sql">;
export type SelectedBackend =
  | { readonly kind: "dynamodb" }
  | { readonly kind: "pure"; readonly dialect: SqlDialect }
  | { readonly kind: "mirror"; readonly dialect: SqlDialect };

export function selectBackend(env: RuntimeEnvironment): SelectedBackend {
  const backend = env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (backend === "dynamodb") return { kind: "dynamodb" };
  if (backend === "turso" || backend === "sql") return { kind: "pure", dialect: backend };
  if (backend === "turso-mirror") return { kind: "mirror", dialect: "turso" };
  if (backend === "sql-mirror") return { kind: "mirror", dialect: "sql" };
  throw new Error(
    `Unknown CONTROL_DATA_BACKEND="${env.CONTROL_DATA_BACKEND}" ` +
      "(expected one of: dynamodb, turso, sql, turso-mirror, sql-mirror).",
  );
}
