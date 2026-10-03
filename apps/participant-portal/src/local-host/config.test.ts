import { describe, expect, it } from "vitest";
import { localCompetitionConfig } from "./config";

const origin = "http://localhost:8080";
const runtime = {
  mode: "local-host",
  role: "participant",
  apiBaseUrl: `${origin}/api`,
};

describe("localCompetitionConfig", () => {
  it("uses authenticated competition mode without learning or automatic-login capabilities", () => {
    const unexpectedCapabilities = {
      ...runtime,
      localTeamLoginKey: "not-for-competition",
      courseTracksEnabled: true,
    };
    const config = localCompetitionConfig(unexpectedCapabilities, origin);
    expect(config).toMatchObject({
      apiBaseUrl: `${origin}/api`,
      coordinationApiUrl: `${origin}/api`,
      mode: "backend",
      cloudMode: "real",
      hasAws: false,
    });
    expect(config.courseTracksEnabled).not.toBe(true);
    expect(config.localTeamLoginKey).toBeUndefined();
  });

  it.each([
    { mode: "dev-mock" },
    { mode: "backend" },
    { role: "organizer" },
    { apiBaseUrl: "http://other-host.test/api" },
    { apiBaseUrl: undefined },
  ])("rejects a mismatched runtime instead of falling back: %j", (override) => {
    expect(() => localCompetitionConfig({ ...runtime, ...override }, origin)).toThrow(
      "Invalid competition configuration",
    );
  });

  it.each([undefined, false, true])("preserves the runtime AWS capability: %s", (hasAws) => {
    expect(localCompetitionConfig({ ...runtime, hasAws }, origin).hasAws).toBe(hasAws === true);
  });
});
