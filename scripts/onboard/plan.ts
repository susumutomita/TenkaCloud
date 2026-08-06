/**
 * [Issue #2119] Turn a {@link Diagnosis} into an ordered remediation plan.
 *
 * Pure + platform-aware: each blocking check maps to a {@link RemediationStep}
 * carrying *why* it is needed, the copy-pasteable *commands* to fix it, any
 * caveats, and a {@link StepKind} that drives the consent policy. The decision of
 * whether a step may run automatically ({@link resolveStepAction}) is a separate
 * pure function so it can be unit-tested across interactive / `--yes` /
 * non-interactive (CI) modes.
 */

import type { CheckResult, Diagnosis } from "./diagnose";
import { blockingChecks } from "./diagnose";

/**
 * - `safe-auto`    : trusts a file / checks out a submodule the user already
 *                    cloned. No system-wide software install. May auto-run.
 * - `software-install`: installs software onto the machine. Requires explicit
 *                    consent (interactive prompt) or `--yes`; never in CI.
 * - `manual-only`  : the onboarder cannot safely automate it (e.g. starting a
 *                    daemon that needs a GUI app). Always shown as a command.
 */
export type StepKind = "safe-auto" | "software-install" | "manual-only";

export type Platform = "darwin" | "linux" | "other";

/**
 * Shown instead of a command on "other" platforms (native Windows win32, BSD,
 * anything not darwin/linux) — these never get a Linux install command, only a
 * redirect. Wording matches the README's "Supported environments" section.
 */
const UNSUPPORTED_PLATFORM_NOTE =
  "This platform is not supported for local install (see README's Supported " +
  "environments) — use GitHub Codespaces for a zero-install browser run, or " +
  "install WSL2 first and run TenkaCloud from there.";

export interface RemediationStep {
  readonly id: CheckResult["id"];
  readonly title: string;
  readonly why: string;
  readonly kind: StepKind;
  readonly commands: readonly string[];
  readonly notes?: string;
}

export type StepAction = "auto" | "prompt" | "manual";

export interface PlanOptions {
  readonly platform: Platform;
}

export interface ResolveOptions {
  /** A TTY / human is driving (can answer a prompt). */
  readonly interactive: boolean;
  /** `--yes` was passed (pre-approve software installs). */
  readonly autoYes: boolean;
}

/** The one canonical Bun install URL (mirrored by `make doctor` and the bootstrap). */
const BUN_OFFICIAL_INSTALL = "curl -fsSL https://bun.sh/install | bash";

function bunStep(platform: Platform): RemediationStep {
  if (platform === "other") {
    return {
      id: "bun",
      title: "Install Bun",
      why: "Bun runs every TenkaCloud script and installs workspace dependencies.",
      kind: "manual-only",
      commands: [],
      notes: UNSUPPORTED_PLATFORM_NOTE,
    };
  }
  const commands =
    platform === "darwin" ? ["brew install oven-sh/bun/bun"] : [BUN_OFFICIAL_INSTALL];
  return {
    id: "bun",
    title: "Install Bun",
    why: "Bun runs every TenkaCloud script and installs workspace dependencies.",
    kind: "software-install",
    commands,
    notes:
      platform === "darwin"
        ? "Installs the bun binary onto your machine (~40 MB). If Homebrew fails " +
          "(often an old Xcode / Command Line Tools, not a Bun problem), use the " +
          `official installer instead: ${BUN_OFFICIAL_INSTALL}`
        : "Installs the bun binary onto your machine (~40 MB).",
  };
}

function dockerInstallStep(platform: Platform): RemediationStep {
  if (platform === "darwin") {
    return {
      id: "docker-cli",
      title: "Install a Docker runtime",
      why: "Local play starts each challenge in a Docker container via Docker Compose.",
      kind: "software-install",
      commands: ["brew install colima docker docker-compose", "colima start"],
      notes:
        "Installs the Docker CLI + standalone docker-compose and creates a lightweight container VM (Colima). " +
        "Docker Desktop is an alternative — install it from docker.com and start the app instead.",
    };
  }
  if (platform === "other") {
    return {
      id: "docker-cli",
      title: "Install a Docker runtime",
      why: "Local play starts each challenge in a Docker container via Docker Compose.",
      kind: "manual-only",
      commands: [],
      notes: UNSUPPORTED_PLATFORM_NOTE,
    };
  }
  return {
    id: "docker-cli",
    title: "Install a Docker runtime",
    why: "Local play starts each challenge in a Docker container via Docker Compose.",
    kind: "software-install",
    commands: ["curl -fsSL https://get.docker.com | sh"],
    notes:
      "Installs Docker Engine + the Compose plugin via your distro. You may need to add your " +
      "user to the `docker` group and re-login, or run docker with sudo.",
  };
}

function dockerComposeStep(platform: Platform): RemediationStep {
  return {
    ...dockerInstallStep(platform),
    id: "docker-compose",
    title: "Install Docker Compose",
    why: "Local play accepts either `docker compose` or standalone `docker-compose`.",
  };
}

function dockerDaemonStep(platform: Platform): RemediationStep {
  if (platform === "other") {
    return {
      id: "docker-daemon",
      title: "Start the Docker daemon",
      why: "The Docker CLI is installed but the daemon must be running to start containers.",
      kind: "manual-only",
      commands: [],
      notes: UNSUPPORTED_PLATFORM_NOTE,
    };
  }
  const commands =
    platform === "darwin"
      ? ["colima start  # or launch Docker Desktop"]
      : ["sudo systemctl start docker"];
  return {
    id: "docker-daemon",
    title: "Start the Docker daemon",
    why: "The Docker CLI is installed but the daemon must be running to start containers.",
    kind: "manual-only",
    commands,
    notes:
      platform === "darwin"
        ? "If you use Docker Desktop, open the app; if you use Colima, run `colima start`."
        : undefined,
  };
}

const STATIC_STEPS: Partial<Record<CheckResult["id"], RemediationStep>> = {
  "mise-trust": {
    id: "mise-trust",
    title: "Trust the mise config",
    why: "mise will not activate the pinned tool versions until mise.toml is trusted.",
    kind: "safe-auto",
    commands: ["mise trust"],
    notes: "Trusting only marks this repo's mise.toml as approved; it installs nothing.",
  },
  submodule: {
    id: "submodule",
    title: "Initialize the problems/ submodule",
    why: "The problem catalog (TenkaCloudChallenge) is a git submodule; a plain clone leaves it empty.",
    kind: "safe-auto",
    commands: ["git submodule update --init --recursive problems"],
    notes: "If this fails on network/permissions, check your access to the catalog repo and retry.",
  },
};

/** Map one blocking check to its remediation step (platform-aware). */
export function stepFor(check: CheckResult, platform: Platform): RemediationStep {
  switch (check.id) {
    case "bun":
      return bunStep(platform);
    case "docker-cli":
      return dockerInstallStep(platform);
    case "docker-compose":
      return dockerComposeStep(platform);
    case "docker-daemon":
      return dockerDaemonStep(platform);
    default: {
      const step = STATIC_STEPS[check.id];
      if (!step) {
        // Defensive: an unmapped blocking check should still surface, not crash.
        return {
          id: check.id,
          title: check.title,
          why: check.detail,
          kind: "manual-only",
          commands: [],
        };
      }
      return step;
    }
  }
}

/** Ordered remediation plan for everything that blocks local play. */
export function planRemediation(
  diagnosis: Diagnosis,
  options: PlanOptions,
): readonly RemediationStep[] {
  return blockingChecks(diagnosis).map((check) => stepFor(check, options.platform));
}

/**
 * Consent policy (UX principles from #2119):
 *   - `safe-auto`: auto-run (no software install). [§ "already-cloned config"]
 *   - `software-install`: `auto` only when pre-approved (`--yes`) or after an
 *     interactive prompt; `manual` in non-interactive runs without `--yes` (CI
 *     must never install without an explicit flag).
 *   - `manual-only`: always shown as a command, never auto-run.
 */
export function resolveStepAction(step: RemediationStep, options: ResolveOptions): StepAction {
  if (step.kind === "manual-only") return "manual";
  if (step.kind === "safe-auto") return options.autoYes || options.interactive ? "auto" : "manual";
  // software-install
  if (options.autoYes) return "auto";
  if (options.interactive) return "prompt";
  return "manual";
}
