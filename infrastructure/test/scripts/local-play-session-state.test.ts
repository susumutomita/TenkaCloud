import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateText } from "../../../scripts/local-play/session-state";

describe("local-play private session state", () => {
  it("should create a private file with mode 0600", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const path = join(directory, "state.json");
    try {
      writePrivateText(path, "secret\n");

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("secret\n");
    } finally {
      unlinkSync(path);
      rmdirSync(directory);
    }
  });

  it("should reject a symbolic-link destination without modifying its target", () => {
    const directory = mkdtempSync(join(tmpdir(), "tenkacloud-private-state-"));
    const target = join(directory, "target.txt");
    const path = join(directory, "state.json");
    writeFileSync(target, "unchanged\n", "utf8");
    symlinkSync(target, path);
    try {
      expect(() => writePrivateText(path, "secret\n")).toThrow();
      expect(readFileSync(target, "utf8")).toBe("unchanged\n");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      unlinkSync(path);
      unlinkSync(target);
      rmdirSync(directory);
    }
  });
});
