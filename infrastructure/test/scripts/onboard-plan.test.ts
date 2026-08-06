import { describe, expect, it } from "vitest";
import type { CheckResult, Diagnosis } from "../../../scripts/onboard/diagnose";
import {
  planRemediation,
  type RemediationStep,
  resolveStepAction,
  stepFor,
} from "../../../scripts/onboard/plan";

function check(id: CheckResult["id"], status: CheckResult["status"]): CheckResult {
  return { id, status, title: id, detail: "" };
}

describe("stepFor", () => {
  it("should give the macOS Docker step the Colima install + a Docker Desktop note", () => {
    const step = stepFor(check("docker-cli", "missing"), "darwin");
    expect(step.kind).toBe("software-install");
    expect(step.commands.join(" ")).toContain("colima");
    expect(step.notes).toMatch(/Docker Desktop/);
  });

  it("should give the Linux Docker step the get.docker.com installer", () => {
    const step = stepFor(check("docker-cli", "missing"), "linux");
    expect(step.commands.join(" ")).toContain("get.docker.com");
  });

  it("should classify mise trust and submodule init as safe-auto (no install)", () => {
    expect(stepFor(check("mise-trust", "action-needed"), "darwin").kind).toBe("safe-auto");
    expect(stepFor(check("submodule", "action-needed"), "linux").kind).toBe("safe-auto");
    expect(stepFor(check("submodule", "action-needed"), "linux").commands[0]).toContain(
      "git submodule update --init",
    );
  });

  it("should make starting the daemon a manual-only step", () => {
    expect(stepFor(check("docker-daemon", "action-needed"), "darwin").kind).toBe("manual-only");
  });

  it("should install bun via brew on macOS and the official installer elsewhere", () => {
    expect(stepFor(check("bun", "missing"), "darwin").commands[0]).toContain("brew install");
    expect(stepFor(check("bun", "missing"), "linux").commands[0]).toContain("bun.sh/install");
  });

  // Issue #2907: on a mac with an old Xcode / CLT the brew route fails for reasons
  // that are not Bun's; the step must surface the official-installer escape hatch.
  it("should give the macOS bun step an official-installer fallback note (#2907)", () => {
    expect(stepFor(check("bun", "missing"), "darwin").notes).toContain("bun.sh/install");
  });
});

describe("stepFor on unsupported platforms (win32 / BSD / anything not darwin or linux)", () => {
  const LINUX_ONLY_MARKERS = ["curl", "systemctl", "brew", "get.docker.com"];

  /** No branch may leak a macOS/Linux command; every branch must redirect instead. */
  function expectRedirectNotLinuxCommand(step: RemediationStep): void {
    const rendered = JSON.stringify(step);
    for (const marker of LINUX_ONLY_MARKERS) {
      expect(rendered).not.toContain(marker);
    }
    expect(rendered).toContain("Codespaces");
    expect(rendered).toContain("WSL2");
    expect(step.commands).toHaveLength(0);
    expect(step.kind).toBe("manual-only");
  }

  it("should redirect the Bun install step to Codespaces/WSL2 instead of the Linux installer", () => {
    expectRedirectNotLinuxCommand(stepFor(check("bun", "missing"), "other"));
  });

  it("should redirect the Docker install step to Codespaces/WSL2 instead of get.docker.com", () => {
    expectRedirectNotLinuxCommand(stepFor(check("docker-cli", "missing"), "other"));
  });

  it("should redirect the Docker Compose install step to Codespaces/WSL2 instead of get.docker.com", () => {
    expectRedirectNotLinuxCommand(stepFor(check("docker-compose", "missing"), "other"));
  });

  it("should redirect the Docker daemon step to Codespaces/WSL2 instead of systemctl", () => {
    expectRedirectNotLinuxCommand(stepFor(check("docker-daemon", "action-needed"), "other"));
  });
});

describe("planRemediation", () => {
  it("should only produce steps for blocking checks, in order", () => {
    const diagnosis: Diagnosis = {
      checks: [
        check("mise-trust", "ok"),
        check("submodule", "action-needed"),
        check("bun", "ok"),
        check("docker-cli", "missing"),
        check("docker-compose", "skipped"),
        check("docker-daemon", "skipped"),
      ],
    };
    const steps = planRemediation(diagnosis, { platform: "darwin" });
    expect(steps.map((s) => s.id)).toEqual(["submodule", "docker-cli"]);
  });
});

describe("resolveStepAction", () => {
  const safeAuto: RemediationStep = {
    id: "submodule",
    title: "",
    why: "",
    kind: "safe-auto",
    commands: [],
  };
  const install: RemediationStep = {
    id: "bun",
    title: "",
    why: "",
    kind: "software-install",
    commands: [],
  };
  const manual: RemediationStep = {
    id: "docker-daemon",
    title: "",
    why: "",
    kind: "manual-only",
    commands: [],
  };

  it("should auto-run safe steps interactively or with --yes, else show them", () => {
    expect(resolveStepAction(safeAuto, { interactive: true, autoYes: false })).toBe("auto");
    expect(resolveStepAction(safeAuto, { interactive: false, autoYes: true })).toBe("auto");
    expect(resolveStepAction(safeAuto, { interactive: false, autoYes: false })).toBe("manual");
  });

  it("should prompt for installs interactively, auto with --yes, manual in CI", () => {
    expect(resolveStepAction(install, { interactive: true, autoYes: false })).toBe("prompt");
    expect(resolveStepAction(install, { interactive: false, autoYes: true })).toBe("auto");
    // non-interactive (CI) without --yes must never install
    expect(resolveStepAction(install, { interactive: false, autoYes: false })).toBe("manual");
  });

  it("should always leave manual-only steps to the user", () => {
    expect(resolveStepAction(manual, { interactive: true, autoYes: true })).toBe("manual");
  });
});
