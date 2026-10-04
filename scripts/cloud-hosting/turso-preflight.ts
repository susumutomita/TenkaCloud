import type { CloudControlDataConfiguration } from "../../infrastructure/lib/cloud-hosting/config";
import type { ProcessResult } from "./process";

export type TursoTokenProbe = (databaseUrl: string, authToken: string) => Promise<void>;

function tokenExpiry(token: string): number | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || !("exp" in parsed)) return undefined;
    return typeof parsed.exp === "number" && Number.isFinite(parsed.exp)
      ? parsed.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/** Same selected AWS identity as deploy; never print the decrypted value or return it to callers. */
export async function verifyTursoBeforeDeployment(options: {
  readonly configuration: Extract<CloudControlDataConfiguration, { kind: "turso" }>;
  readonly region: string;
  readonly run: (args: readonly string[]) => Promise<ProcessResult>;
  readonly probe: TursoTokenProbe;
  readonly now: number;
  readonly output: (message: string) => void;
}): Promise<void> {
  const { databaseUrl, authTokenParameterName } = options.configuration;
  const result = await options.run([
    "ssm",
    "get-parameter",
    "--name",
    authTokenParameterName,
    "--with-decryption",
    "--region",
    options.region,
    "--query",
    "Parameter",
    "--output",
    "json",
  ]);
  if (result.code !== 0)
    throw new Error(
      `Turso preflight cannot read ${authTokenParameterName} in ${options.region}. Check that this exact SSM SecureString exists and the selected AWS caller has ssm:GetParameter and its decryption permission. Deployment stopped before AWS changes.`,
    );
  let parameter: unknown;
  try {
    parameter = JSON.parse(result.stdout);
  } catch {
    throw new Error("Turso preflight received invalid SSM metadata; deployment stopped.");
  }
  if (
    typeof parameter !== "object" ||
    parameter === null ||
    !("Type" in parameter) ||
    parameter.Type !== "SecureString" ||
    !("Value" in parameter) ||
    typeof parameter.Value !== "string" ||
    !parameter.Value.trim()
  )
    throw new Error("Turso auth token must be a nonempty SSM SecureString; deployment stopped.");
  const token = parameter.Value.trim();
  const expiresAt = tokenExpiry(token);
  if (expiresAt !== undefined && expiresAt <= options.now)
    throw new Error(
      "The saved Turso token has expired. Rotate it in the selected SSM parameter before deployment.",
    );
  try {
    await options.probe(databaseUrl, token);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const forms = [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)];
    const redacted = forms.reduce((text, secret) => text.split(secret).join("[REDACTED]"), detail);
    throw new Error(
      `Turso authenticated SELECT 1 failed; deployment stopped before AWS changes. ${redacted}`,
    );
  }
  if (expiresAt !== undefined && expiresAt - options.now <= 7 * 24 * 60 * 60 * 1000)
    options.output(
      "[cloud] The saved Turso token expires within seven days; plan rotation before the event.\n",
    );
  options.output(
    "[cloud] Turso read-only preflight passed (SSM SecureString and authenticated SELECT 1).\n",
  );
}
