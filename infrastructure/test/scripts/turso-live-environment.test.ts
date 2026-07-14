import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTursoLiveEnvironment,
  mergeSamlSsoFeature,
  writeTursoLiveEnvironment,
} from "../../../scripts/cli/turso-live-environment";

describe("Turso live environment file (#2617)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function environmentRoot(content: string): { root: string; path: string } {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-turso-env-"));
    roots.push(root);
    const directory = join(root, "infrastructure", "environments", "development");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, ".env");
    writeFileSync(path, content, { mode: 0o600 });
    return { root, path };
  }

  it("should load the selected file while preserving explicit process overrides", () => {
    const { root } = environmentRoot("AWS_REGION=ap-northeast-1\nAWS_ACCOUNT_ID=111111111111\n");

    const loaded = loadTursoLiveEnvironment(root, "development", {
      AWS_ACCOUNT_ID: "222222222222",
    });

    expect(loaded.env.AWS_REGION).toBe("ap-northeast-1");
    expect(loaded.env.AWS_ACCOUNT_ID).toBe("222222222222");
    expect(loaded.env.ENV).toBe("development");
  });

  it("should merge the SAML flag without discarding unrelated feature flags", () => {
    expect(mergeSamlSsoFeature('{"problemPacks":true}')).toBe(
      '{"problemPacks":true,"samlSso":true}',
    );
    expect(() => mergeSamlSsoFeature("not-json")).toThrow("CDK_PARAM_FEATURES");
  });

  it("should atomically update only public values and restrict the file to its owner", () => {
    const { root, path } = environmentRoot(
      [
        "# keep this comment",
        "AWS_REGION=us-west-2",
        "PRIVATE_VALUE=do-not-touch",
        "AWS_REGION=us-east-1",
        "",
      ].join("\n"),
    );

    writeTursoLiveEnvironment(root, "development", {
      AWS_REGION: "ap-northeast-1",
      CDK_PARAM_CONTROL_DATA_BACKEND: "turso",
    });

    const content = readFileSync(path, "utf8");
    expect(content).toContain("# keep this comment");
    expect(content).toContain("PRIVATE_VALUE=do-not-touch");
    expect(content).toContain("AWS_REGION=ap-northeast-1");
    expect(content).not.toContain("AWS_REGION=us-");
    expect(content).toContain("CDK_PARAM_CONTROL_DATA_BACKEND=turso");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("should reject a symbolic link instead of following it", () => {
    const root = mkdtempSync(join(tmpdir(), "tenkacloud-turso-env-link-"));
    roots.push(root);
    const directory = join(root, "infrastructure", "environments", "development");
    mkdirSync(directory, { recursive: true });
    const target = join(directory, "target");
    writeFileSync(target, "owner data", { mode: 0o600 });
    symlinkSync(target, join(directory, ".env"));

    expect(() =>
      writeTursoLiveEnvironment(root, "development", { AWS_REGION: "ap-northeast-1" }),
    ).toThrow("symbolic link");
    expect(readFileSync(target, "utf8")).toBe("owner data");
  });
});
