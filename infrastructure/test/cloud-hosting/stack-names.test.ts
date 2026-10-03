import { describe, expect, it } from "vitest";
import {
  cloudStackLayout,
  cloudStackNames,
  cloudStackTags,
} from "../../lib/cloud-hosting/stack-names.js";

describe("physical cloud stack layouts", () => {
  it("defaults to exact original Lite names without renaming resources for product terminology", () => {
    expect(cloudStackLayout({})).toBe("lite");
    expect(cloudStackNames("development")).toEqual({
      app: "tenkacloud-lite",
      backend: "tenkacloud-lite-problem-deploy",
    });
    expect(cloudStackNames("staging")).toEqual({
      app: "tenkacloud-lite-staging",
      backend: "tenkacloud-lite-problem-deploy-staging",
    });
  });
  it("supports the CLI's explicit published-cloud selection and rejects unknown layouts", () => {
    expect(cloudStackLayout({ TENKACLOUD_STACK_LAYOUT: "cloud" })).toBe("cloud");
    expect(cloudStackNames("production", "cloud")).toEqual({
      app: "tenkacloud-cloud-production",
      backend: "tenkacloud-cloud-problem-deploy-production",
    });
    expect(() => cloudStackLayout({ TENKACLOUD_STACK_LAYOUT: "custom" })).toThrow(
      /must be lite or cloud/u,
    );
  });
  it("preserves original ownership tags while adding the current marker", () => {
    expect(cloudStackTags("staging")).toEqual({
      Project: "TenkaCloud",
      Environment: "staging",
      TenkaCloudProject: "cloud-hosting",
    });
  });
});
