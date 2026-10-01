import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { runLocalHost } from "../main";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("the production local engine offers every local exercise and no AWS runtime", () => {
  const engine = new CompetitionEngine(root, join(root, ".cache", "unused-matrix-state"));
  const catalog = engine.catalog();
  expect(catalog.filter((item) => item.runtime === "docker")).toHaveLength(106);
  expect(catalog.some((item) => item.runtime === "coordination")).toBe(true);
  expect(catalog.some((item) => item.runtime === "cloudformation")).toBe(false);
});
test("local help advertises the hosting boundary without offering an AWS startup flag", async () => {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runLocalHost(["--help"]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("AWS service problems are available only with cloud hosting");
    expect(output).not.toContain("--aws-region <region>");
    await expect(runLocalHost(["--aws-region", "ap-northeast-1"])).rejects.toThrow(
      "AWS problems require cloud hosting",
    );
  } finally {
    log.mockRestore();
  }
});
