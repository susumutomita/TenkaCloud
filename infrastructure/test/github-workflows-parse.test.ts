import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

describe("GitHub workflow YAML parsing (#2457 invalid YAML regression)", () => {
  it("should parse every workflow YAML file so #2457 cannot poison all pushes again", () => {
    const workflowFiles = readdirSync(workflowsDir)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .sort();
    const failures: string[] = [];

    for (const file of workflowFiles) {
      try {
        parse(readFileSync(join(workflowsDir, file), "utf8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${file}: ${message}`);
      }
    }

    expect(workflowFiles).toContain("detect-suspicious-comments.yml");
    expect(failures).toEqual([]);
  });
});
