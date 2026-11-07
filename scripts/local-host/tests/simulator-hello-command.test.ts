import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../integration/simulator-hello.ts", import.meta.url));

function invoke(args: string[]) {
  const result = Bun.spawnSync([process.execPath, command, ...args], {
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("optional simulator command explains its explicit prerequisites without starting a fixture", () => {
  const result = invoke(["--help"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("--simulator-binary");
  expect(result.output).toContain("--aws-cli");
  expect(result.output).toContain("No downloads or real AWS");
});

test("missing integration inputs fail rather than silently skipping the rehearsal", () => {
  const result = invoke([]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Both --simulator-binary and --aws-cli are required");
});

test("argument parsing errors never echo private argument values", () => {
  const syntheticSecret = "synthetic-secret-must-not-appear";
  const result = invoke([`--unknown-${syntheticSecret}`]);
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain(syntheticSecret);
  expect(result.output).toContain("private output was withheld");
});
