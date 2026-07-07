import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "cleanup-always-on-sweeper.yml");
const workflowSource = fs.readFileSync(workflowPath, "utf-8");

describe("cleanup-always-on-sweeper workflow (#2406)", () => {
  it("should file a GitHub issue when the scheduled sweeper job fails", () => {
    expect(workflowSource).toContain("if: failure()");
    expect(workflowSource).toContain("gh issue create");
    expect(workflowSource).toContain("Always-On cleanup sweeper workflow failed");
  });
});
