import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

/** Require success proof for these exact finalized recordings and edit metadata. */
export function validatedLocalRecording(raw: string): Record<string, string> {
  const root = realpathSync(raw);
  const proof = JSON.parse(readFileSync(join(root, "ui-validation.json"), "utf8")) as {
    uiErrors: number;
    descriptionAndLearningGoals: boolean;
    sha256?: Record<string, string>;
  };
  if (proof.uiErrors !== 0 || proof.descriptionAndLearningGoals !== true || !proof.sha256)
    throw new Error("Recording has no successful UI validation.");
  const roles = JSON.parse(readFileSync(join(root, "role-paths.json"), "utf8")) as Record<
    string,
    string
  >;
  if (!roles["local-catalog.png"] || !roles["participant-scoreboard.png"])
    throw new Error("Recording is missing required roles.");
  for (const path of [
    join(root, "role-paths.json"),
    join(root, "edit-points.json"),
    ...Object.values(roles),
  ]) {
    const actual = realpathSync(path);
    const within = relative(root, actual);
    if (
      within.startsWith("..") ||
      createHash("sha256").update(readFileSync(actual)).digest("hex") !== proof.sha256[actual]
    )
      throw new Error("Recording does not match its successful UI validation.");
  }
  return roles;
}
