/**
 * [Issue #2909] The published local-mode run profiles.
 *
 * A single "required memory" number is meaningless here: what local play costs
 * depends on which components you run and how many problems are up at once. So
 * the platform publishes three profiles, and each one states its components, its
 * concurrency, and — separately — what has actually been measured for it.
 *
 * The honesty rules this module enforces by construction:
 *
 *  - A profile's numbers live in `requirements`, and every entry there names the
 *    `recordId` it came from. `docs/measurements/local-mode/<recordId>.json` must
 *    exist and contain that value; a test asserts it. A number with no record
 *    cannot be added here, which is what keeps a plausible-sounding guess out of
 *    the published table.
 *  - `verifiedConfiguration` is the configuration the profile was OBSERVED to run
 *    in — not a minimum. Nothing here claims that less would fail; the preflight
 *    wording (`profile-preflight.ts`) says "not yet measured", not "too small".
 *  - `status` separates what is guaranteed today from what is a target. A profile
 *    whose components are not all implemented is `planned` and carries no numbers.
 */

import { LOCAL_CONTROL_PLANE_CONTAINER } from "./docker-metrics";

export const PROFILE_IDS = ["minimum", "recommended", "full"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const DEFAULT_PROFILE_ID: ProfileId = "recommended";

/**
 * - `measured`: every component is implemented and this profile's own scenario
 *   has a measurement record.
 * - `partially-measured`: implemented, but its own scenario is not measured yet
 *   (a smaller profile on the same platform is).
 * - `planned`: contains components that are not complete in local mode. No
 *   numbers are published for it.
 */
export type ProfileStatus = "measured" | "partially-measured" | "planned";

/** The configuration a profile was observed running in. Not a proven floor. */
export interface VerifiedConfiguration {
  readonly recordId: string;
  readonly platformKey: string;
  /** Logical CPUs the Docker daemon reported during that run. */
  readonly dockerCpus: number;
  /** Memory the Docker daemon reported during that run, in bytes. */
  readonly dockerMemoryBytes: number;
  /** Total memory the owned containers used, in bytes. */
  readonly observedMemBytes: number;
  readonly observedContainerCount: number;
}

/**
 * A measured lower bound on free disk: below it a required image cannot even be
 * materialised. Unlike memory this IS a hard floor, because it is the size of
 * artefacts that must land on the Docker VM disk before anything starts.
 */
export interface DiskFloor {
  readonly recordId: string;
  readonly bytes: number;
  /** What the floor covers, so a reader knows what it does NOT cover. */
  readonly covers: string;
}

export interface ProfileRequirements {
  readonly verifiedConfiguration?: VerifiedConfiguration;
  readonly diskFloor?: DiskFloor;
}

export interface LocalProfile {
  readonly id: ProfileId;
  readonly title: string;
  readonly audience: string;
  readonly status: ProfileStatus;
  /** Components that are running in this profile. */
  readonly includes: readonly string[];
  /** Components explicitly NOT running, so the profile boundary is unambiguous. */
  readonly excludes: readonly string[];
  /** Problems running at the same time. `DEFAULT_MAX_RUNNING` caps this at 3. */
  readonly concurrentProblems: number;
  readonly requirements: ProfileRequirements;
  /** Aspects of this profile with no measurement yet. Shown as "unverified". */
  readonly unverified: readonly string[];
}

/**
 * The one record transcribed so far — Issue #2909's measurement comment,
 * macOS arm64 under Colima. Kept as a named constant because two profiles cite
 * it and a test resolves it against the on-disk record file.
 */
const MACOS_ARM64_RECORD = "2026-08-08-macos-arm64-colima";

/**
 * 3.81 GiB, as `docker info` reported it during {@link MACOS_ARM64_RECORD}.
 * Transcribed at the precision the run was reported at (2 decimal places of a
 * GiB), so the byte count is exact for 3.81 GiB rather than to-the-byte accurate.
 */
const COLIMA_DEFAULT_MEMORY_BYTES = 4_090_956_349;

/** 755 MB — the `tenkacloud-local:dev` image measured in {@link MACOS_ARM64_RECORD}. */
const CONTROL_PLANE_IMAGE_BYTES = 755_000_000;

export const LOCAL_PROFILES: readonly LocalProfile[] = [
  {
    id: "minimum",
    title: "Minimum — solve one problem",
    audience: "A participant working through a single drill.",
    status: "measured",
    includes: [
      `local-play API + Participant Portal (one \`${LOCAL_CONTROL_PLANE_CONTAINER}\` container)`,
      "SQLite state store (inside the control-plane container's volume)",
      "one lightweight single-container problem",
    ],
    excludes: ["TenkaCloud Simulator", "AI agent runner", "event management UI"],
    concurrentProblems: 1,
    requirements: {
      verifiedConfiguration: {
        recordId: MACOS_ARM64_RECORD,
        platformKey: "macos-arm64",
        dockerCpus: 4,
        dockerMemoryBytes: COLIMA_DEFAULT_MEMORY_BYTES,
        observedMemBytes: 142_606_336,
        observedContainerCount: 2,
      },
      diskFloor: {
        recordId: MACOS_ARM64_RECORD,
        bytes: CONTROL_PLANE_IMAGE_BYTES,
        covers:
          "the tenkacloud-local:dev control-plane image only — problem images and BuildKit cache are on top of this",
      },
    },
    unverified: [
      "multi-container problems",
      "cold / warm start times",
      "platforms other than macOS arm64",
    ],
  },
  {
    id: "recommended",
    title: "Recommended — several problems at once",
    audience: "Anyone trying multiple drills, or an author play-testing.",
    status: "partially-measured",
    includes: [
      `local-play API + Participant Portal (one \`${LOCAL_CONTROL_PLANE_CONTAINER}\` container)`,
      "SQLite state store",
      "up to 3 problems running at once (the `DEFAULT_MAX_RUNNING` default)",
      "terminal, scoring, hints and writeups used in parallel",
    ],
    excludes: ["TenkaCloud Simulator", "AI agent runner", "event management UI"],
    concurrentProblems: 3,
    requirements: {
      diskFloor: {
        recordId: MACOS_ARM64_RECORD,
        bytes: CONTROL_PLANE_IMAGE_BYTES,
        covers:
          "the tenkacloud-local:dev control-plane image only — three problems' images and BuildKit cache are on top of this",
      },
    },
    unverified: [
      "3 concurrent problems (2 lightweight problems is the largest scenario measured)",
      "multi-container problems",
      "30-60 minutes of continuous use",
      "resource reclaim across repeated start / stop / reset",
      "platforms other than macOS arm64",
    ],
  },
  {
    id: "full",
    title: "Full — a whole event locally",
    audience: "An organizer rehearsing an event on one machine.",
    status: "planned",
    includes: [
      "everything in the recommended profile",
      "TenkaCloud Simulator and composite problems (experimental)",
      "event management UI (planned)",
      "AI agent runner with full prompt / tool-call / action history (planned)",
    ],
    excludes: [],
    concurrentProblems: 3,
    // Deliberately empty: components of this profile are not complete in local
    // mode, so publishing any number for it would describe something that does
    // not exist yet.
    requirements: {},
    unverified: [
      "every resource figure — this profile is a target, not a guarantee",
      "which components are runnable locally at all",
    ],
  },
];

export function findProfile(id: string): LocalProfile | undefined {
  return LOCAL_PROFILES.find((profile) => profile.id === id);
}

/** True when `id` names a published profile (argument validation). */
export function isProfileId(id: string): id is ProfileId {
  return PROFILE_IDS.some((candidate) => candidate === id);
}

/** Every record id cited by a published number, for the traceability test. */
export function citedRecordIds(): readonly string[] {
  const ids = new Set<string>();
  for (const profile of LOCAL_PROFILES) {
    const { verifiedConfiguration, diskFloor } = profile.requirements;
    if (verifiedConfiguration) ids.add(verifiedConfiguration.recordId);
    if (diskFloor) ids.add(diskFloor.recordId);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
