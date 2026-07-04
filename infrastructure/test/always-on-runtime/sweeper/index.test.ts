import { describe, expect, it } from "vitest";
import {
  ENV_AWS_REGION,
  ENV_GITHUB_REPOSITORY,
  ENV_GITHUB_TOKEN,
  formatSummaryLog,
  resolveSweeperConfig,
} from "../../../lib/always-on-runtime/sweeper/index";

const FULL_ENV: NodeJS.ProcessEnv = {
  [ENV_AWS_REGION]: "ap-northeast-1",
  [ENV_GITHUB_REPOSITORY]: "susumutomita/TenkaCloud",
  [ENV_GITHUB_TOKEN]: "gh-token",
};

describe("resolveSweeperConfig", () => {
  it("should resolve region / repo / token from the environment", () => {
    expect(resolveSweeperConfig(FULL_ENV)).toEqual({
      region: "ap-northeast-1",
      repo: "susumutomita/TenkaCloud",
      token: "gh-token",
    });
  });

  it("should fail loud when a required env var is missing", () => {
    expect(() => resolveSweeperConfig({ ...FULL_ENV, [ENV_GITHUB_TOKEN]: undefined })).toThrow(
      new RegExp(ENV_GITHUB_TOKEN),
    );
  });

  it("should fail loud when a required env var is blank", () => {
    expect(() => resolveSweeperConfig({ ...FULL_ENV, [ENV_AWS_REGION]: "   " })).toThrow(
      new RegExp(ENV_AWS_REGION),
    );
  });
});

describe("formatSummaryLog", () => {
  it("should render count-only summary with no account identifiers", () => {
    const line = formatSummaryLog({ scanned: 9, expired: 2, deleted: 1, failed: 1 });
    expect(line).toBe("always-on-runtime cleanup sweep: scanned=9 expired=2 deleted=1 failed=1");
  });
});
