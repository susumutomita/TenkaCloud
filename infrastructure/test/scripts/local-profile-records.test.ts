import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MeasurementRecord,
  parseMeasurementRecord,
} from "../../../scripts/local/measurement-report";
import { citedRecordIds, LOCAL_PROFILES, PROFILE_IDS } from "../../../scripts/local/profiles";

/**
 * [Issue #2909] CI gates the SHAPE of a measurement, never its values.
 *
 * Pinning measured numbers would be self-defeating: they legitimately differ per
 * host and per release, so a pinned assertion either forces a doc edit on every
 * unrelated change or pressures whoever re-measures into rounding a real reading
 * to keep CI quiet. What CI does enforce is that every record parses, and — the
 * point of the whole exercise — that every number the platform PUBLISHES can be
 * traced back to a record that actually contains it. A requirement figure with
 * no record behind it is exactly the guess Issue #2909 lists as a non-goal, and
 * this file is what makes adding one fail.
 */

const RECORDS_DIR = join(__dirname, "..", "..", "..", "docs", "measurements", "local-mode");
const DOC_PATH = join(__dirname, "..", "..", "..", "docs", "local-play-requirements.md");

function recordFiles(): readonly string[] {
  return readdirSync(RECORDS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function loadRecord(file: string): MeasurementRecord {
  return parseMeasurementRecord(JSON.parse(readFileSync(join(RECORDS_DIR, file), "utf8")));
}

describe("measurement records", () => {
  const files = recordFiles();

  it("should ship at least one record, so the profiles have something to cite", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("should validate %s against the record schema", (file) => {
    expect(() => loadRecord(file)).not.toThrow();
  });

  it.each(files)("should name %s after its own recordId so a profile can cite it", (file) => {
    expect(loadRecord(file).recordId).toBe(basename(file, ".json"));
  });

  it.each(files)("should state what %s did not cover", (file) => {
    // An empty list is a claim of total coverage. No local-mode run has ever had
    // it, so an empty list here means the author forgot rather than measured all.
    expect(loadRecord(file).unmeasured.length).toBeGreaterThan(0);
  });

  it.each(files)("should never record an unread value in %s as a zero", (file) => {
    const { host } = loadRecord(file);

    for (const value of [host.cpus, host.memoryBytes, host.freeDiskBytes]) {
      expect(value).not.toBe(0);
    }
  });
});

describe("profile numbers are traceable to a record", () => {
  it("should resolve every cited record id to a record file on disk", () => {
    const available = new Set(recordFiles().map((file) => basename(file, ".json")));

    for (const id of citedRecordIds()) expect(available).toContain(id);
  });

  it("should back each verified configuration with the same observation in its record", () => {
    for (const profile of LOCAL_PROFILES) {
      const verified = profile.requirements.verifiedConfiguration;
      if (!verified) continue;
      const record = loadRecord(`${verified.recordId}.json`);
      const observation = record.observations.find((o) => o.profileId === profile.id);

      expect(observation, `${profile.id} cites a record with no observation for it`).toBeDefined();
      expect(record.platformKey).toBe(verified.platformKey);
      expect(record.host.cpus).toBe(verified.dockerCpus);
      expect(record.host.memoryBytes).toBe(verified.dockerMemoryBytes);
      expect(observation?.totalMemBytes).toBe(verified.observedMemBytes);
      expect(observation?.containerCount).toBe(verified.observedContainerCount);
    }
  });

  it("should back each disk floor with an image size in its record", () => {
    for (const profile of LOCAL_PROFILES) {
      const floor = profile.requirements.diskFloor;
      if (!floor) continue;
      const sizes = loadRecord(`${floor.recordId}.json`).images.map((image) => image.sizeBytes);

      expect(sizes, `${profile.id}'s disk floor is not an image size in its record`).toContain(
        floor.bytes,
      );
    }
  });

  it("should publish no numbers for a planned profile", () => {
    for (const profile of LOCAL_PROFILES) {
      if (profile.status !== "planned") continue;
      expect(profile.requirements.verifiedConfiguration).toBeUndefined();
      expect(profile.requirements.diskFloor).toBeUndefined();
    }
  });

  it("should mark a profile without its own observation as not fully measured", () => {
    for (const profile of LOCAL_PROFILES) {
      if (profile.requirements.verifiedConfiguration) continue;
      expect(profile.status).not.toBe("measured");
      expect(profile.unverified.length).toBeGreaterThan(0);
    }
  });
});

describe("docs/local-play-requirements.md", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  it.each(PROFILE_IDS)("should document the %s profile", (id) => {
    expect(doc).toContain(id);
  });

  it("should reference every record the profiles cite, so a reader can check the source", () => {
    for (const id of citedRecordIds()) expect(doc).toContain(id);
  });

  it("should cover every platform the requirements table groups by, measured or not", () => {
    for (const platform of ["macOS arm64", "macOS x86_64", "Linux x86_64", "WSL2", "Codespaces"]) {
      expect(doc).toContain(platform);
    }
  });

  it("should point at the re-runnable benchmark rather than only at prose", () => {
    expect(doc).toContain("make local-measure");
  });
});
