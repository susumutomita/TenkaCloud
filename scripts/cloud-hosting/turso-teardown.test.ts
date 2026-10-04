import { describe, expect, it } from "bun:test";
import { planDeployedTursoTeardown } from "./turso-teardown";

const outputs = {
  CloudControlDataBackend: "turso",
  TursoDatabaseUrl: "https://owned.turso.io",
  TursoAuthTokenParameterName: "/TenkaCloud/test/turso/auth-token",
};
describe("original Turso purge-or-warn contract", () => {
  it("warns that normal destroy leaves external rows and never resolves credentials", () => {
    expect(planDeployedTursoTeardown(outputs, false)).toMatchObject({ kind: "warn" });
  });
  it("purges only an explicit deployed Turso target", () => {
    expect(planDeployedTursoTeardown(outputs, true)).toEqual({
      kind: "purge",
      target: {
        databaseUrl: outputs.TursoDatabaseUrl,
        parameterName: outputs.TursoAuthTokenParameterName,
        schema: "cloud-v1",
      },
    });
  });
  it("recognizes current DynamoDB and the legacy three-table output contract", () => {
    expect(planDeployedTursoTeardown({ CloudControlDataBackend: "dynamodb" }, true)).toEqual({
      kind: "not-turso",
    });
    expect(
      planDeployedTursoTeardown(
        { EventsTableName: "events", TeamsTableName: "teams", DeploymentsTableName: "deployments" },
        true,
      ),
    ).toEqual({ kind: "not-turso" });
  });
  it("does not infer an absent deployed provider from local configuration", () => {
    expect(planDeployedTursoTeardown({}, true)).toMatchObject({ kind: "unverified" });
  });
  it.each([
    ["http:", "", "owned.turso.io"].join("/"),
    "https://user:secret@owned.turso.io",
    "invalid",
  ])("rejects invalid or credential-bearing target %s", (url) => {
    expect(() => planDeployedTursoTeardown({ ...outputs, TursoDatabaseUrl: url }, true)).toThrow();
  });
});
