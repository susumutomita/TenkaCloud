import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertHistoricalLiteTemplate } from "../../lib/cloud-hosting/historical-lite.js";

interface Signature {
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
}
const baseline = JSON.parse(
  readFileSync(new URL("./fixtures/historical-lite-signatures.json", import.meta.url), "utf8"),
) as {
  templates: Record<"dynamodb" | "turso", Record<"app" | "backend", Signature>>;
};
function fixture(provider: "dynamodb" | "turso", kind: "app" | "backend"): Signature {
  return structuredClone(baseline.templates[provider][kind]);
}

describe("historical Lite template adoption proof", () => {
  it("recognizes both original stack signatures and exact persisted provider configuration", () => {
    for (const kind of ["app", "backend"] as const) {
      expect(assertHistoricalLiteTemplate(fixture("dynamodb", kind), kind)).toEqual({
        kind: "dynamodb",
      });
      expect(assertHistoricalLiteTemplate(fixture("turso", kind), kind)).toEqual({
        kind: "turso",
        databaseUrl: "https://synthetic.turso.io",
        authTokenParameterName: "/test/turso/token",
      });
    }
  });
  it("refuses missing, published-cloud or unrelated layouts without an identity fallback", () => {
    expect(() => assertHistoricalLiteTemplate({}, "app")).toThrow(/Refusing resource adoption/u);
    const changed = fixture("dynamodb", "app");
    const pool = changed.Resources.IdentityProvidertenantUserPoolC77ED8F6;
    delete changed.Resources.IdentityProvidertenantUserPoolC77ED8F6;
    changed.Resources.OrganizerUserPool5795A39C = pool as NonNullable<typeof pool>;
    expect(() => assertHistoricalLiteTemplate(changed, "app")).toThrow(/missing IdentityProvider/u);
  });
  it("rejects schema changes, new identity resources and inconsistent Turso destinations", () => {
    const changed = fixture("dynamodb", "backend");
    const events = changed.Resources.EventsTable4B7491D3;
    if (!events) throw new Error("Missing baseline table");
    events.Properties.KeySchema = [{ AttributeName: "tenant", KeyType: "HASH" }];
    expect(() => assertHistoricalLiteTemplate(changed, "backend")).toThrow(/primary key schema/u);
    const hybrid = fixture("dynamodb", "app");
    hybrid.Resources.NewPool = { Type: "AWS::Cognito::UserPool", Properties: {} };
    expect(() => assertHistoricalLiteTemplate(hybrid, "app")).toThrow(
      /unexpected provisioning or identity/u,
    );
    const inconsistent = fixture("turso", "backend");
    const fn = inconsistent.Resources.EventApiFunction801117B3;
    if (!fn) throw new Error("Missing baseline Lambda");
    const environment = fn.Properties.Environment as { Variables: Record<string, string> };
    environment.Variables.TURSO_DATABASE_URL = "https://different.turso.io";
    expect(() => assertHistoricalLiteTemplate(inconsistent, "backend")).toThrow(
      /inconsistent repository providers/u,
    );
  });
});
