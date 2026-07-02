import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LITE_STACK_BASE_NAMES,
  liteStackId,
  resolveLiteEnvironment,
  resolveLiteStackNames,
} from "../../lib/tenkacloud-lite/stack-names";

/**
 * Issue #2193: Lite の stack 名は CDK app (bin) と CLI runner (scripts) の両方が
 * 本 module から解決する。 旧実装は CLI 側が suffix なしの名前をハードコードしており、
 * development 以外の環境で status 誤報告 / teardown 不能になっていた。 suffix 規則と
 * CLI 側の解決経路を pin する。
 */
describe("lite stack names (issue #2193)", () => {
  it("should keep the legacy un-suffixed names for development (existing deploy compat)", () => {
    expect(resolveLiteStackNames("development")).toEqual({
      app: "tenkacloud-lite",
      problemDeploy: "tenkacloud-lite-problem-deploy",
    });
  });

  it("should suffix stack names for non-development environments (issue #992 rule)", () => {
    expect(resolveLiteStackNames("staging")).toEqual({
      app: "tenkacloud-lite-staging",
      problemDeploy: "tenkacloud-lite-problem-deploy-staging",
    });
    expect(liteStackId(LITE_STACK_BASE_NAMES.app, "production")).toBe("tenkacloud-lite-production");
  });

  it("should resolve the environment from CDK_PARAM_ENVIRONMENT with development default", () => {
    expect(resolveLiteEnvironment({})).toBe("development");
    expect(resolveLiteEnvironment({ CDK_PARAM_ENVIRONMENT: "staging" })).toBe("staging");
  });
});

describe("CLI runner resolves the same suffixed names as the CDK app (issue #2193)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("should expose suffixed LITE_STACK_NAMES when CDK_PARAM_ENVIRONMENT is set at startup", async () => {
    vi.stubEnv("CDK_PARAM_ENVIRONMENT", "staging");
    vi.resetModules();
    const cli = await import("../../../scripts/tenkacloud-lite");
    expect(cli.LITE_STACK_NAMES).toEqual({
      app: "tenkacloud-lite-staging",
      problemDeploy: "tenkacloud-lite-problem-deploy-staging",
    });
  });

  it("should expose un-suffixed LITE_STACK_NAMES for the default environment", async () => {
    vi.stubEnv("CDK_PARAM_ENVIRONMENT", "");
    vi.unstubAllEnvs();
    vi.resetModules();
    const cli = await import("../../../scripts/tenkacloud-lite");
    expect(cli.LITE_STACK_NAMES).toEqual({
      app: "tenkacloud-lite",
      problemDeploy: "tenkacloud-lite-problem-deploy",
    });
  });
});
