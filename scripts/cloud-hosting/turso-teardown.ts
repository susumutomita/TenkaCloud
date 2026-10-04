import type { TursoResetTarget } from "./turso-reset";
/** Preserve the old purge-or-warn contract, using deployed identity instead of a changed .env. */
export type TursoTeardownPlan =
  | { readonly kind: "not-turso" }
  | { readonly kind: "warn" | "unverified"; readonly message: string }
  | {
      readonly kind: "purge";
      readonly target: Omit<TursoResetTarget, "region">;
    };
export function planDeployedTursoTeardown(
  outputs: Readonly<Record<string, string>>,
  purge: boolean,
): TursoTeardownPlan {
  const provider = outputs.CloudControlDataBackend;
  if (
    provider === "dynamodb" ||
    (!provider &&
      ["EventsTableName", "TeamsTableName", "DeploymentsTableName"].every((key) => outputs[key]))
  )
    return { kind: "not-turso" };
  if (provider !== "turso")
    return {
      kind: "unverified",
      message:
        "Deployed control-data provider could not be verified from stack outputs or its original template. Ordinary platform removal remains available; external database rows may remain. Purge requires the deployed provider/target identity, never a changed local .env." +
        (outputs.CloudDataIdentityError ? ` ${outputs.CloudDataIdentityError}` : ""),
    };
  if (!purge)
    return {
      kind: "warn",
      message:
        "Turso control-data rows remain outside AWS after make destroy. Use make destroy-all before removing the platform to purge them while its SSM authentication is still available.",
    };
  const databaseUrl = outputs.TursoDatabaseUrl ?? "";
  const parameterName = outputs.TursoAuthTokenParameterName ?? "";
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Deployed Turso database URL is missing or invalid; purge stopped before mutation.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !parameterName.startsWith("/")
  )
    throw new Error(
      "Deployed Turso URL or SSM parameter identity is invalid; purge stopped before mutation.",
    );
  const composition = outputs.CloudComposition;
  if (composition && composition !== "lite-baseline-v1")
    throw new Error("Unknown deployed composition; Turso purge stopped before mutation.");
  return {
    kind: "purge",
    target: {
      databaseUrl,
      parameterName,
      schema: composition === "lite-baseline-v1" ? "lite-baseline-v1" : "cloud-v1",
    },
  };
}
