import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCloudEnvironment } from "./environment";

const roots: string[] = [];
function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "tenkacloud-env-"));
  roots.push(root);
  for (const [environment, contents] of Object.entries(files)) {
    const directory = join(root, "infrastructure", "environments", environment);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".env"), contents);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selected cloud environment files", () => {
  it("defaults to development and preserves exported overrides without rewriting the file", () => {
    const source =
      "ENV=development\nTENKACLOUD_ADMIN_EMAIL=file@example.test\nAWS_REGION=us-east-1\n";
    const root = fixture({ development: source, staging: "INVALID FILE" });
    const inherited = { TENKACLOUD_ADMIN_EMAIL: "exported@example.test", AWS_REGION: undefined };
    expect(loadCloudEnvironment(root, inherited)).toEqual({
      ENV: "development",
      CDK_PARAM_ENVIRONMENT: "development",
      TENKACLOUD_ADMIN_EMAIL: "exported@example.test",
      AWS_REGION: "us-east-1",
    });
    expect(inherited.AWS_REGION).toBeUndefined();
    expect(readFileSync(join(root, "infrastructure/environments/development/.env"), "utf8")).toBe(
      source,
    );
    expect(loadCloudEnvironment(root, { TENKACLOUD_ADMIN_EMAIL: "" }).TENKACLOUD_ADMIN_EMAIL).toBe(
      "",
    );
  });

  it.each(["staging", "production"])(
    "loads only the selected %s file through either selector",
    (environment) => {
      const root = fixture({
        development: "INVALID FILE",
        [environment]: `ENV=${environment}\nACCOUNT_ID=123456789012`,
      });
      for (const selector of ["ENV", "CDK_PARAM_ENVIRONMENT"]) {
        const loaded = loadCloudEnvironment(root, { [selector]: environment });
        expect(loaded.ACCOUNT_ID).toBe("123456789012");
        expect(loaded.ENV).toBe(environment);
        expect(loaded.CDK_PARAM_ENVIRONMENT).toBe(environment);
      }
    },
  );

  it.each(["", "../production", "/production", "Production", "staging "])(
    "rejects unsafe or ambiguous selector %j",
    (environment) => {
      expect(() => loadCloudEnvironment(fixture(), { ENV: environment })).toThrow(
        "Invalid cloud environment",
      );
    },
  );

  it("rejects conflicting process selectors and copied files from another environment", () => {
    const root = fixture({ staging: "ENV=production" });
    expect(() =>
      loadCloudEnvironment(root, { ENV: "staging", CDK_PARAM_ENVIRONMENT: "production" }),
    ).toThrow("same cloud environment");
    expect(() => loadCloudEnvironment(root, { ENV: "staging" })).toThrow("must match staging");
    const cdkRoot = fixture({ staging: "ENV=staging\nCDK_PARAM_ENVIRONMENT=development" });
    expect(() => loadCloudEnvironment(cdkRoot, { ENV: "staging" })).toThrow("must match staging");
  });

  it("keeps custom environment and CI-only configuration without creating a file", () => {
    const root = fixture();
    expect(loadCloudEnvironment(root, { ENV: "preview-42", ACCOUNT_ID: "123456789012" })).toEqual({
      ENV: "preview-42",
      CDK_PARAM_ENVIRONMENT: "preview-42",
      ACCOUNT_ID: "123456789012",
    });
    expect(existsSync(join(root, "infrastructure"))).toBe(false);
  });

  it("parses comments, export and single-line quotes as literal data without shell expansion", () => {
    const root = fixture();
    const canary = join(root, "must-not-exist");
    const directory = join(root, "infrastructure/environments/development");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, ".env"),
      [
        "# comment",
        "export ENV = development # selected environment",
        'TENKACLOUD_ADMIN_EMAIL="organizer@example.test" # address',
        'TENKACLOUD_RUNNER_BINDINGS=\'[{"value":"#literal"}]\'',
        `LITERAL=$(touch ${canary})`,
        `REFERENCE=\${AWS_REGION}`,
        "EMPTY= # leave blank",
      ].join("\r\n"),
    );
    const loaded = loadCloudEnvironment(root, {});
    expect(loaded.TENKACLOUD_ADMIN_EMAIL).toBe("organizer@example.test");
    expect(loaded.TENKACLOUD_RUNNER_BINDINGS).toBe('[{"value":"#literal"}]');
    expect(loaded.LITERAL).toBe(`$(touch ${canary})`);
    expect(loaded.REFERENCE).toBe(`\${AWS_REGION}`);
    expect(loaded.EMPTY).toBe("");
    expect(existsSync(canary)).toBe(false);
  });

  it.each([
    "AWS_REGION=one\nAWS_REGION=two",
    "not an assignment",
    'SECRET="unterminated',
    "ENV=development\nENV=",
  ])("rejects malformed or duplicate assignments without printing values", (contents) => {
    expect(() => loadCloudEnvironment(fixture({ development: contents }), {})).toThrow(
      /environment assignment|single-line quoted value/u,
    );
  });

  it("does not treat an unreadable file as missing configuration", () => {
    const root = fixture();
    mkdirSync(join(root, "infrastructure/environments/development/.env"), { recursive: true });
    expect(() => loadCloudEnvironment(root, {})).toThrow();
  });

  it.each(["development", "staging", "production"])(
    "ships a safe, selectable %s example at the historical path",
    (environment) => {
      const source = readFileSync(
        resolve(
          import.meta.dirname,
          `../../infrastructure/environments/${environment}/.env.example`,
        ),
        "utf8",
      );
      const loaded = loadCloudEnvironment(fixture({ [environment]: source }), { ENV: environment });
      expect(loaded.ENV).toBe(environment);
      expect(loaded.TENKACLOUD_ADMIN_EMAIL).toBe("");
      expect(loaded.ACCOUNT_ID).toBe("");
      expect(loaded.AWS_REGION).toBe("ap-northeast-1");
      expect(loaded.TENKACLOUD_CFN_EXECUTION_POLICY_ARN).toBeUndefined();
    },
  );
});
