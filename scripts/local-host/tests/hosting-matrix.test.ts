import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { runLocalHost } from "../main";
import { dockerProblemIds } from "./problem-tree";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("the production local engine offers the selected supported local exercises and no AWS runtime", () => {
  const engine = new CompetitionEngine(root, join(root, ".cache", "unused-matrix-state"));
  const catalog = engine.catalog();
  expect(
    catalog
      .filter((item) => item.runtime === "docker")
      .map((item) => item.problemId)
      .sort(),
  ).toEqual(dockerProblemIds(root).sort());
  expect(catalog.some((item) => item.runtime === "coordination")).toBe(true);
  expect(catalog.some((item) => item.runtime === "cloudformation")).toBe(false);
});
test("local help offers managed and explicit simulator configuration without the legacy AWS flag", async () => {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runLocalHost(["--help"]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(
      "AWS service problems require cloud hosting or local simulator configuration",
    );
    expect(output).toContain(
      "Same-machine loopback hosting starts a locally locked native Simulator automatically",
    );
    for (const flag of [
      "--no-simulator",
      "--simulator-binary",
      "--simulator-endpoint",
      "--simulator-token-file",
      "--simulator-region",
      "--simulator-bootstrap",
    ])
      expect(output).toContain(flag);
    expect(output).not.toContain("--aws-region <region>");
    await expect(runLocalHost(["--aws-region", "ap-northeast-1"])).rejects.toThrow(
      "AWS problems require cloud hosting",
    );
  } finally {
    log.mockRestore();
  }
});
