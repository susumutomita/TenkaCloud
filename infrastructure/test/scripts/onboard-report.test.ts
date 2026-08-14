import { describe, expect, it } from "vitest";
import type { CheckResult, Diagnosis } from "../../../scripts/onboard/diagnose";
import type { RemediationStep } from "../../../scripts/onboard/plan";
import {
  formatCheckLine,
  formatDiagnosis,
  formatManualGuidance,
  formatStep,
} from "../../../scripts/onboard/report";

const check = (over: Partial<CheckResult>): CheckResult => ({
  id: "bun",
  title: "Bun",
  status: "ok",
  detail: "bun 1.3.11",
  ...over,
});

describe("formatCheckLine", () => {
  it("should prefix each status with its icon", () => {
    expect(formatCheckLine(check({ status: "ok" }))).toContain("✓");
    expect(formatCheckLine(check({ status: "missing" }))).toContain("✗");
    expect(formatCheckLine(check({ status: "action-needed" }))).toContain("!");
    expect(formatCheckLine(check({ status: "skipped" }))).toContain("·");
  });
});

describe("formatDiagnosis", () => {
  it("should render a header plus one line per check", () => {
    const diagnosis: Diagnosis = {
      checks: [
        check({ id: "bun" }),
        check({
          id: "docker-cli",
          title: "Docker CLI",
          status: "missing",
          detail: "not installed",
        }),
      ],
    };
    const out = formatDiagnosis(diagnosis);
    expect(out).toContain("TenkaCloud developer prerequisites:");
    expect(out).toContain("Bun");
    expect(out).toContain("Docker CLI");
  });
});

describe("formatStep", () => {
  it("should show the index, why, the commands, and any note", () => {
    const step: RemediationStep = {
      id: "docker-cli",
      title: "Install a Docker runtime",
      why: "Local play uses Docker.",
      kind: "software-install",
      commands: ["brew install colima docker docker-compose", "colima start"],
      notes: "Creates a container VM.",
    };
    const out = formatStep(step, 0, 2);
    expect(out).toContain("[1/2] Install a Docker runtime");
    expect(out).toContain("Why: Local play uses Docker.");
    expect(out).toContain("brew install colima docker docker-compose");
    expect(out).toContain("colima start");
    expect(out).toContain("Note: Creates a container VM.");
  });

  it("should omit the Run: block for a manual step with no commands (e.g. an unsupported-platform redirect)", () => {
    const step: RemediationStep = {
      id: "bun",
      title: "Install Bun",
      why: "Bun runs every TenkaCloud script and installs workspace dependencies.",
      kind: "manual-only",
      commands: [],
      notes: "Use GitHub Codespaces, or install WSL2 first.",
    };
    const out = formatStep(step, 0, 1);
    expect(out).toContain("[1/1] Install Bun");
    expect(out).not.toContain("Run:");
    expect(out).toContain("Note: Use GitHub Codespaces, or install WSL2 first.");
  });
});

describe("formatManualGuidance", () => {
  it("should list the remaining steps and the resume command", () => {
    const steps: RemediationStep[] = [
      {
        id: "submodule",
        title: "Initialize the problems/ submodule",
        why: "needed",
        kind: "safe-auto",
        commands: ["git submodule update --init --recursive problems"],
      },
    ];
    const out = formatManualGuidance(steps, "make local");
    expect(out).toContain("still need your action");
    expect(out).toContain("git submodule update --init --recursive problems");
    expect(out).toContain("re-run:  make local");
  });
});
