import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatedLocalRecording } from "./onboarding-videos/local-ui-validation";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function recording() {
  const raw = realpathSync(mkdtempSync(join(tmpdir(), "local-ui-validation-")));
  directories.push(raw);
  const roles = {
    "local-catalog.png": join(raw, "organizer.webm"),
    "participant-scoreboard.png": join(raw, "participant.webm"),
  };
  writeFileSync(join(raw, "role-paths.json"), JSON.stringify(roles));
  writeFileSync(
    join(raw, "edit-points.json"),
    JSON.stringify({ openingEnd: 10, teardownStart: 20 }),
  );
  for (const path of Object.values(roles)) writeFileSync(path, "synthetic recording");
  const proof = {
    uiErrors: 0,
    descriptionAndLearningGoals: true,
    sha256: Object.fromEntries(
      [join(raw, "role-paths.json"), join(raw, "edit-points.json"), ...Object.values(roles)].map(
        (path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")],
      ),
    ),
  };
  const save = () => writeFileSync(join(raw, "ui-validation.json"), JSON.stringify(proof));
  save();
  return { raw, roles, proof, save };
}
describe("Local UI recording success proof", () => {
  it("accepts only matching successful recordings", () => {
    const fixture = recording();
    expect(validatedLocalRecording(fixture.raw)).toEqual(fixture.roles);
  });
  it("rejects missing proof, errors, and missing required display validation", () => {
    const fixture = recording();
    rmSync(join(fixture.raw, "ui-validation.json"));
    expect(() => validatedLocalRecording(fixture.raw)).toThrow();
    fixture.proof.uiErrors = 1;
    fixture.save();
    expect(() => validatedLocalRecording(fixture.raw)).toThrow();
    fixture.proof.uiErrors = 0;
    fixture.proof.descriptionAndLearningGoals = false;
    fixture.save();
    expect(() => validatedLocalRecording(fixture.raw)).toThrow();
  });
  for (const name of [
    "organizer.webm",
    "participant.webm",
    "edit-points.json",
    "role-paths.json",
  ]) {
    it(`rejects changed ${name} with an older success proof`, () => {
      const fixture = recording();
      writeFileSync(join(fixture.raw, name), name.endsWith(".json") ? "{}" : "failed retry");
      expect(() => validatedLocalRecording(fixture.raw)).toThrow();
    });
  }
  it("stops the renderer before creating output when validation failed", () => {
    const fixture = recording();
    fixture.proof.uiErrors = 1;
    fixture.save();
    const output = join(fixture.raw, "rejected.mp4");
    const result = spawnSync(
      process.execPath,
      ["scripts/landing/onboarding-videos/render-local-ui.ts", fixture.raw, output],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no successful UI validation");
    expect(existsSync(output)).toBe(false);
  });
  it("rejects a success proof copied from another recording", () => {
    const first = recording(),
      second = recording();
    writeFileSync(
      join(second.raw, "ui-validation.json"),
      readFileSync(join(first.raw, "ui-validation.json")),
    );
    expect(() => validatedLocalRecording(second.raw)).toThrow();
  });
});
