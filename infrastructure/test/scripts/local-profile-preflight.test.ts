import { describe, expect, it } from "vitest";
import {
  evaluateProfile,
  formatPreflight,
  type PreflightFacts,
  worstStatus,
} from "../../../scripts/local/profile-preflight";
import { findProfile, type LocalProfile } from "../../../scripts/local/profiles";

/**
 * [Issue #2909] The preflight's value is in what it refuses to claim: a value it
 * could not read must stay `unknown` rather than becoming a pass, and a machine
 * below every measured CPU/memory configuration must be reported as untested,
 * while a measured hard disk floor remains a real failure. Both distinctions
 * are asserted here.
 */

function profile(id: string): LocalProfile {
  const found = findProfile(id);
  if (!found) throw new Error(`missing profile ${id}`);
  return found;
}

const MINIMUM = profile("minimum");
const RECOMMENDED = profile("recommended");
const FULL = profile("full");

/** Comfortably above the recorded macOS arm64 configuration. */
const ROOMY: PreflightFacts = {
  dockerCpus: 8,
  dockerMemoryBytes: 8 * 1024 ** 3,
  freeDiskBytes: 20 * 1024 ** 3,
};

describe("evaluateProfile — minimum (has a measured configuration)", () => {
  it("should pass every item on a machine at or above the measured configuration", () => {
    const result = evaluateProfile(MINIMUM, ROOMY);

    expect(result.status).toBe("pass");
    expect(result.items.map((item) => item.status)).toEqual(["pass", "pass", "pass"]);
    expect(result.items.every((item) => item.nextAction === undefined)).toBe(true);
  });

  it("should pass on an exact match with the measured configuration", () => {
    const verified = MINIMUM.requirements.verifiedConfiguration;
    const floor = MINIMUM.requirements.diskFloor;
    if (!verified || !floor) throw new Error("the minimum profile must carry measured numbers");

    const result = evaluateProfile(MINIMUM, {
      dockerCpus: verified.dockerCpus,
      dockerMemoryBytes: verified.dockerMemoryBytes,
      freeDiskBytes: floor.bytes,
    });

    expect(result.status).toBe("pass");
  });

  it("should warn — not fail — below the measured memory, and say the size is untested", () => {
    const result = evaluateProfile(MINIMUM, { ...ROOMY, dockerMemoryBytes: 1024 ** 3 });
    const memory = result.items.find((item) => item.id === "docker-memory");

    expect(memory?.status).toBe("warn");
    expect(memory?.detail).toContain("untested rather than known to fail");
    expect(memory?.nextAction).toContain("Docker allocation");
    expect(result.status).toBe("warn");
  });

  it("should warn below the measured CPU count", () => {
    const result = evaluateProfile(MINIMUM, { ...ROOMY, dockerCpus: 1 });

    expect(result.items.find((item) => item.id === "docker-cpus")?.status).toBe("warn");
  });

  it("should fail below the disk floor, because the image cannot materialise", () => {
    const result = evaluateProfile(MINIMUM, { ...ROOMY, freeDiskBytes: 1024 });
    const disk = result.items.find((item) => item.id === "free-disk");

    expect(disk?.status).toBe("fail");
    expect(disk?.nextAction).toContain("docker builder prune");
    expect(result.status).toBe("fail");
  });

  it("should report unknown — never pass — when Docker's resources cannot be read", () => {
    const result = evaluateProfile(MINIMUM, {});

    expect(result.status).toBe("unknown");
    expect(result.items.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown"]);
    for (const item of result.items) expect(item.nextAction).toBeTruthy();
  });

  it("should report unknown for disk alone when only the disk probe was skipped", () => {
    const result = evaluateProfile(MINIMUM, {
      dockerCpus: ROOMY.dockerCpus,
      dockerMemoryBytes: ROOMY.dockerMemoryBytes,
    });

    expect(result.items.find((item) => item.id === "free-disk")?.status).toBe("unknown");
    expect(result.status).toBe("unknown");
  });
});

describe("evaluateProfile — profiles without their own measurement", () => {
  it("should report CPU and memory as unknown for the recommended profile and point at the benchmark", () => {
    const result = evaluateProfile(RECOMMENDED, ROOMY);
    const memory = result.items.find((item) => item.id === "docker-memory");

    expect(memory?.status).toBe("unknown");
    expect(memory?.detail).toContain("no measurement recorded");
    expect(memory?.nextAction).toContain("#not-measured-yet");
    expect(memory?.nextAction).not.toContain("make local-measure");
  });

  it("should still check the recommended profile's disk floor, which is measured", () => {
    const result = evaluateProfile(RECOMMENDED, ROOMY);

    expect(result.items.find((item) => item.id === "free-disk")?.status).toBe("pass");
  });

  it("should report every item as unknown for the planned full profile", () => {
    const result = evaluateProfile(FULL, ROOMY);

    expect(result.items.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown"]);
    expect(result.status).toBe("unknown");
  });
});

describe("worstStatus", () => {
  it("should rank fail above warn above unknown above pass", () => {
    const item = (status: "pass" | "warn" | "unknown" | "fail") =>
      ({ id: "docker-cpus", title: "t", status, detail: "d" }) as const;

    expect(worstStatus([item("fail"), item("warn"), item("unknown")])).toBe("fail");
    expect(worstStatus([item("pass"), item("unknown"), item("warn")])).toBe("warn");
    expect(worstStatus([item("pass"), item("unknown")])).toBe("unknown");
    expect(worstStatus([item("pass")])).toBe("pass");
    expect(worstStatus([])).toBe("pass");
  });
});

describe("formatPreflight", () => {
  it("should name the profile, its concurrency, each item and the overall verdict", () => {
    const text = formatPreflight(evaluateProfile(MINIMUM, ROOMY));

    expect(text).toContain("Selected profile: minimum");
    expect(text).toContain("Concurrent problems: 1");
    expect(text).toContain("Docker memory");
    expect(text).toContain("Result: PASS");
  });

  it("should print the next action under any item that did not pass", () => {
    const text = formatPreflight(evaluateProfile(MINIMUM, { ...ROOMY, dockerCpus: 1 }));

    expect(text).toContain("Next: ");
    expect(text).toContain("Result: WARN");
  });

  it("should render a measured hard-floor violation as FAIL", () => {
    const text = formatPreflight(evaluateProfile(MINIMUM, { ...ROOMY, freeDiskBytes: 1 }));

    expect(text).toContain("✗ Docker VM free disk");
    expect(text).toContain("Result: FAIL");
  });

  it("should list what the profile has not measured yet", () => {
    const text = formatPreflight(evaluateProfile(RECOMMENDED, ROOMY));

    expect(text).toContain("Not measured yet:");
    expect(text).toContain("3 concurrent problems");
  });
});
