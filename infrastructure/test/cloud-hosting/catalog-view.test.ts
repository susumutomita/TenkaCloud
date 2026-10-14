import { expect, test } from "vitest";
import { savedProblemCatalog } from "../../lib/problem-deploy/handlers/participant-handler/catalog-view.js";
import { parseExecutionCatalog } from "../../lib/problem-deploy/handlers/shared/execution-catalog.js";

const digest = "a".repeat(64);
function catalog(metadata?: Record<string, unknown>) {
  return parseExecutionCatalog(
    JSON.stringify({
      version: 1,
      catalog: { example: "pack-problems/selected/version/challenges/example" },
      sources: {
        example: { "metadata.json": { key: `sources/${digest}`, digest } },
      },
      ...(metadata ? { publicMetadata: { example: metadata } } : {}),
      scoring: {},
      hints: {},
      skills: {},
      endpoints: {},
      phases: {},
      visibility: {},
      runtimes: {},
      disruptions: {},
      writeups: {},
      provenance: { example: { contentDigest: digest } },
      coordination: {},
      plugins: {},
      sourceArchive: { bucket: "source", key: "source.zip", versionId: "pinned" },
    }),
  );
}
test("participant metadata comes from the event's saved source and excludes instructions and answers", async () => {
  const metadata = {
    id: "example",
    name: "Original edition",
    category: "Challenge",
    status: "ready",
    difficulty: 1,
    tags: [],
    learningGoals: [],
    estimatedDuration: "5m",
    shortDescription: "Saved description",
    instructions: "SECRET-INSTRUCTIONS",
    writeup: "SECRET-ANSWER",
    hints: [{ content: "SECRET-HINT" }],
  };
  const projection = await savedProblemCatalog(catalog(metadata), ["example"]);
  expect(projection[0]?.name).toBe("Original edition");
  expect(JSON.stringify(projection)).not.toContain("SECRET-");
  expect(await savedProblemCatalog(catalog(), ["example"])).toEqual([]);
  await expect(
    savedProblemCatalog(catalog({ ...metadata, id: "different" }), ["example"]),
  ).rejects.toThrow("identity mismatch");
});
