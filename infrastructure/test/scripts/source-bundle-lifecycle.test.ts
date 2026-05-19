import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIFECYCLE_PATH = join(__dirname, "..", "..", "..", "scripts", "source-bundle-lifecycle.json");

type SourceBundleLifecycle = {
  Rules: Array<{
    Status: string;
    NoncurrentVersionExpiration?: {
      NoncurrentDays?: number;
      NewerNoncurrentVersions?: number;
    };
  }>;
};

describe("source-bundle lifecycle policy (#1056)", () => {
  const lifecycle = JSON.parse(readFileSync(LIFECYCLE_PATH, "utf8")) as SourceBundleLifecycle;
  const [rule] = lifecycle.Rules;

  it("source-bundle-lifecycle.json の NewerNoncurrentVersions は 5 であるべき", () => {
    expect(rule?.NoncurrentVersionExpiration?.NewerNoncurrentVersions).toBe(5);
  });

  it("source-bundle-lifecycle.json の NoncurrentDays は 1 であるべき", () => {
    expect(rule?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(1);
  });

  it("source-bundle-lifecycle.json の Status は Enabled であるべき", () => {
    expect(rule?.Status).toBe("Enabled");
  });
});
