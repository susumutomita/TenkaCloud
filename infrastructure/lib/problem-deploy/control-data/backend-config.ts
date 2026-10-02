/** The existing cloud backend choice; local hosting keeps its own SQLite store. */
export interface RuntimeEnvironment {
  readonly CONTROL_DATA_BACKEND?: string;
  readonly TURSO_DATABASE_URL?: string;
  readonly TURSO_AUTH_TOKEN_PARAMETER_NAME?: string;
}
export type SelectedBackend = { readonly kind: "dynamodb" } | { readonly kind: "turso" };
export function selectBackend(env: RuntimeEnvironment): SelectedBackend {
  const backend = env.CONTROL_DATA_BACKEND?.trim().toLowerCase() || "dynamodb";
  if (backend === "dynamodb" || backend === "turso") return { kind: backend };
  throw new Error(
    `Unknown CONTROL_DATA_BACKEND="${env.CONTROL_DATA_BACKEND}" (expected one of: dynamodb, turso).`,
  );
}
