import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDockerCatalog } from "../docker-catalog";

// Docker's shared scorer retains negative penalties. AWS problems with explicit
// score floors have a separate policy and are deliberately outside this check.
const falseZeroFloor = [
  /0\s*点(?:未満(?:になることは(?:ありません|ない)|にはならない|にならない|になりません)|を下回ることはない)/u,
  /never (?:goes|drops|falls) below (?:zero|0)|with (?:the total floored at zero|a floor of zero)/iu,
];

test("the pinned Docker instructions do not promise a zero floor absent from their scorer", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const catalog = loadDockerCatalog(root);
  expect(catalog).toHaveLength(106);
  const mismatches: string[] = [];
  for (const entry of catalog) {
    const definition = JSON.parse(entry.definition) as { problem: { problemDir: string } };
    const metadata = JSON.parse(
      readFileSync(join(definition.problem.problemDir, "metadata.json"), "utf8"),
    ) as { instructions: string; i18n: { en: { instructions: string } } };
    for (const [locale, text] of [
      ["ja", metadata.instructions],
      ["en", metadata.i18n.en.instructions],
    ] as const)
      if (falseZeroFloor.some((pattern) => pattern.test(text)))
        mismatches.push(`${entry.problemId}:${locale}`);
  }
  expect(mismatches).toEqual([]);
});
