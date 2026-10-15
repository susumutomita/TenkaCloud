import { expect, test } from "bun:test";
import { assertAcceptanceEnvironment } from "./vpn-acceptance";

const approved = {
  TENKACLOUD_VPN_ACCEPTANCE: "github-ephemeral-v1",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
  ImageOS: "ubuntu24",
};
test("acceptance scope requires every explicit disposable VM attribute", () => {
  expect(() => assertAcceptanceEnvironment(approved, "linux", 0)).not.toThrow();
  for (const name of Object.keys(approved)) {
    const missing = Object.fromEntries(Object.entries(approved).filter(([key]) => key !== name));
    expect(() => assertAcceptanceEnvironment(missing, "linux", 0)).toThrow();
  }
});
test("acceptance refuses local, self-hosted, PR, non-root and Mac execution", () => {
  expect(() => assertAcceptanceEnvironment({}, "linux", 0)).toThrow();
  expect(() =>
    assertAcceptanceEnvironment({ ...approved, RUNNER_ENVIRONMENT: "self-hosted" }, "linux", 0),
  ).toThrow();
  expect(() =>
    assertAcceptanceEnvironment({ ...approved, GITHUB_EVENT_NAME: "pull_request" }, "linux", 0),
  ).toThrow();
  expect(() => assertAcceptanceEnvironment(approved, "linux", 1000)).toThrow();
  expect(() => assertAcceptanceEnvironment(approved, "darwin", 0)).toThrow();
});
