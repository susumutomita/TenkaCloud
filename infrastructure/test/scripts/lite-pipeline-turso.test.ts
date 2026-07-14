import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CodeBuild launcher (infrastructure/templates/lite-pipeline.yaml) is the
 * pipeline path for `make deploy`. Before #2617 follow-up it exposed no way to pick
 * the zero-cost Turso backend — the buildspec only wrote DynamoDB-mode `.env`, so a
 * pipeline deploy could only ever use DynamoDB. This pins the Turso opt-in wiring so
 * it cannot silently regress back to "DynamoDB only".
 */
const template = readFileSync(
  join(__dirname, "..", "..", "templates", "lite-pipeline.yaml"),
  "utf8",
);

describe("lite-pipeline.yaml Turso backend opt-in", () => {
  it("should declare a ControlDataBackend parameter that allows turso/sql", () => {
    expect(template).toMatch(/ControlDataBackend:\s*\n\s*Type: String/);
    // dynamodb stays the default so existing pipelines are unchanged.
    expect(template).toMatch(/ControlDataBackend:[\s\S]*?Default: dynamodb/);
    for (const value of ["dynamodb", "turso", "sql", "turso-mirror", "sql-mirror"]) {
      expect(template).toContain(`- ${value}`);
    }
  });

  it("should declare the Turso database URL and auth-token-parameter-name parameters", () => {
    expect(template).toMatch(/TursoDatabaseUrl:\s*\n\s*Type: String/);
    expect(template).toMatch(/TursoAuthTokenParameterName:\s*\n\s*Type: String/);
  });

  it("should forward the three inputs to the build as environment variables", () => {
    expect(template).toMatch(/Name: CONTROL_DATA_BACKEND\s*\n\s*Value: !Ref ControlDataBackend/);
    expect(template).toMatch(/Name: TURSO_DATABASE_URL\s*\n\s*Value: !Ref TursoDatabaseUrl/);
    expect(template).toMatch(
      /Name: TURSO_AUTH_TOKEN_PARAMETER_NAME\s*\n\s*Value: !Ref TursoAuthTokenParameterName/,
    );
  });

  it("should write the CDK_PARAM Turso lines into .env only for a non-dynamodb backend", () => {
    // Gated on the backend so a default (dynamodb) pipeline writes nothing new and
    // env-check-lite still enforces url + token-name for the turso/sql/mirror values.
    expect(template).toMatch(/if \[ "\$\{CONTROL_DATA_BACKEND\}" != "dynamodb" \]; then/);
    expect(template).toMatch(/CDK_PARAM_CONTROL_DATA_BACKEND=\$\{CONTROL_DATA_BACKEND\}/);
    expect(template).toMatch(/CDK_PARAM_TURSO_DATABASE_URL=\$\{TURSO_DATABASE_URL\}/);
    expect(template).toMatch(
      /CDK_PARAM_TURSO_AUTH_TOKEN_PARAMETER_NAME=\$\{TURSO_AUTH_TOKEN_PARAMETER_NAME\}/,
    );
  });
});
