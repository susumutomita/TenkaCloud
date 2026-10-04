import { describe, expect, it } from "vitest";
import {
  cloudStackLayout,
  cloudStackNames,
  cloudStackTags,
} from "../../lib/cloud-hosting/stack-names.js";

describe("physical cloud stack layouts", () => {
  it("defaults new installations to cloud names", () => {
    expect(cloudStackLayout({})).toBe("cloud");
    expect(cloudStackNames("development")).toEqual({
      app: "tenkacloud-cloud",
      backend: "tenkacloud-cloud-problem-deploy",
    });
    expect(cloudStackNames("staging")).toEqual({
      app: "tenkacloud-cloud-staging",
      backend: "tenkacloud-cloud-problem-deploy-staging",
    });
  });
  it("preserves the CLI's discovered or explicit Lite layout", () => {
    expect(cloudStackLayout({ TENKACLOUD_STACK_LAYOUT: "lite" })).toBe("lite");
    expect(cloudStackNames("development", "lite")).toEqual({
      app: "tenkacloud-lite",
      backend: "tenkacloud-lite-problem-deploy",
    });
    expect(cloudStackNames("staging", "lite")).toEqual({
      app: "tenkacloud-lite-staging",
      backend: "tenkacloud-lite-problem-deploy-staging",
    });
  });
  it("supports an explicit cloud selection and rejects unknown layouts", () => {
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
