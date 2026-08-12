/**
 * [Issue #2909] The machine-readable shape of a local-mode resource measurement.
 *
 * The published requirement tables must be traceable to a run that actually
 * happened, so every number in `docs/local-play-requirements.md` comes from a
 * record file under `docs/measurements/local-mode/` validated by this schema.
 *
 * The schema — not the numbers — is what CI gates. Measured values legitimately
 * differ per host and per release; pinning them would either force a doc edit on
 * every unrelated change or invite rounding a real reading to keep CI quiet.
 * What CI does guarantee is that a record parses, declares the environment it was
 * taken in, and states what it did NOT cover ({@link MeasurementRecordSchema.unmeasured}).
 *
 * `null` means "not captured in this run" and is never coerced to `0`.
 */

import { z } from "zod";

/** Bumped only on a breaking change to the record shape. */
export const MEASUREMENT_SCHEMA_VERSION = 1;

const NonEmpty = z.string().min(1);
const Bytes = z.number().int().nonnegative();

const ContainerSampleSchema = z.object({
  name: NonEmpty,
  memBytes: Bytes,
  /** `null` when the run recorded memory only. */
  cpuPercent: z.number().nonnegative().nullable(),
});

/**
 * One scenario observed inside a record — e.g. the control plane alone, or the
 * control plane plus two problems.
 */
const ObservationSchema = z.object({
  scenario: NonEmpty,
  /** The published profile this observation backs, or `null` for a sub-step. */
  profileId: z.enum(["minimum", "recommended", "full"]).nullable(),
  containerCount: z.number().int().nonnegative(),
  totalMemBytes: Bytes,
  totalCpuPercent: z.number().nonnegative().nullable(),
  containers: z.array(ContainerSampleSchema),
});

const TimingSchema = z.object({
  id: NonEmpty,
  /** `cold` = nothing cached; `warm` = images already present. */
  phase: z.enum(["cold", "warm"]),
  durationMs: z.number().int().nonnegative(),
});

const ImageSchema = z.object({ reference: NonEmpty, sizeBytes: Bytes });

const HostSchema = z.object({
  /** Logical CPUs the Docker daemon reports; `null` when unreadable. */
  cpus: z.number().int().positive().nullable(),
  /** Memory the Docker daemon reports, in bytes; `null` when unreadable. */
  memoryBytes: Bytes.nullable(),
  /** Free bytes on the Docker VM root filesystem; `null` when not probed. */
  freeDiskBytes: Bytes.nullable(),
  serverVersion: NonEmpty.nullable(),
  composeVersion: NonEmpty.nullable(),
  operatingSystem: NonEmpty.nullable(),
  architecture: NonEmpty.nullable(),
  /** Host machine as described by the measurer, e.g. "MacBook Air M5 / 32 GB". */
  description: NonEmpty.nullable(),
});

export const MeasurementRecordSchema = z.object({
  schemaVersion: z.literal(MEASUREMENT_SCHEMA_VERSION),
  /** Stable id; must equal the file's basename so a profile can cite it. */
  recordId: NonEmpty,
  capturedAt: NonEmpty,
  /** `measure-profile` = produced by the script; `manual` = transcribed by a human. */
  capturedBy: z.enum(["measure-profile", "manual"]),
  /** Platform bucket the requirements table groups by. */
  platformKey: z.enum(["macos-arm64", "macos-x86_64", "linux-x86_64", "wsl2", "codespaces"]),
  /** The TenkaCloud release the run was taken against. */
  release: NonEmpty,
  host: HostSchema,
  observations: z.array(ObservationSchema),
  timings: z.array(TimingSchema),
  images: z.array(ImageSchema),
  /** What this run did NOT measure. Required: an empty list is a claim of full coverage. */
  unmeasured: z.array(NonEmpty),
  notes: z.array(NonEmpty),
});

export type MeasurementRecord = z.infer<typeof MeasurementRecordSchema>;

/** Parse a record, throwing a message that names the offending field. */
export function parseMeasurementRecord(value: unknown): MeasurementRecord {
  const result = MeasurementRecordSchema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid measurement record: ${issues}`);
}
