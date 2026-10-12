import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { runBuildCommand } from "../build";

const SYNTHETIC_BUILD =
  "console.log('synthetic build report'); console.error('synthetic build warning');";

test("summary output captures a successful build report instead of streaming it", async () => {
  const result = await runBuildCommand(["-e", SYNTHETIC_BUILD], tmpdir(), "summary");
  expect(result.code).toBe(0);
  expect(result.report).toContain("synthetic build report");
  expect(result.report).toContain("synthetic build warning");
});

test("summary output keeps the failed build report and exit code", async () => {
  const result = await runBuildCommand(
    ["-e", `${SYNTHETIC_BUILD} process.exit(3);`],
    tmpdir(),
    "summary",
  );
  expect(result.code).toBe(3);
  expect(result.report).toContain("synthetic build warning");
});
