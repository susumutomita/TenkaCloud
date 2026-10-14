import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerDefinitionOf, loadDockerCatalog } from "../docker-catalog";
import type { Job } from "../model";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function fixture(run: (root: string, directory: string) => void) {
  const copied = mkdtempSync(join(tmpdir(), "tenka-pinned-catalog-"));
  const directory = join(copied, "problems", "challenges", "sqli-demo");
  mkdirSync(join(copied, "problems", "challenges"), { recursive: true });
  cpSync(join(root, "problems", "challenges", "sqli-demo"), directory, { recursive: true });
  try {
    run(copied, directory);
  } finally {
    rmSync(copied, { recursive: true, force: true });
  }
}

test("catalog pins the full source tree and refuses edits, additions and deletions before start or resume", () => {
  for (const action of ["edit", "add", "delete"] as const)
    fixture((copied, directory) => {
      const problem = loadDockerCatalog(copied, [join(copied, "problems")])[0];
      expect(problem?.problemId).toBe("sqli-demo");
      if (!problem) throw new Error("Expected sqli-demo fixture");
      const job: Job = {
        jobId: "job",
        eventId: "event",
        teamId: "team",
        problemId: problem.problemId,
        definition: problem.definition,
        offset: 1000,
        status: "PENDING",
        unit: null,
      };
      expect(dockerDefinitionOf(job, true).problem.problemId).toBe("sqli-demo");
      if (action === "edit") writeFileSync(join(directory, "metadata.json"), "{}");
      else if (action === "add")
        writeFileSync(join(directory, "new-source.txt"), "changed build context");
      else rmSync(join(directory, "metadata.json"));
      expect(() => dockerDefinitionOf(job, true)).toThrow("pinned problem files changed");
      expect(dockerDefinitionOf(job, false).problem.problemId).toBe("sqli-demo");
    });
});

test("catalog rejects symbolic links and duplicate IDs instead of adopting ambiguous runtime ownership", () => {
  fixture((copied, directory) => {
    symlinkSync("metadata.json", join(directory, "unexpected-link"));
    expect(() => loadDockerCatalog(copied, [join(copied, "problems")])).toThrow("symbolic link");
  });
  fixture((copied, directory) => {
    mkdirSync(join(copied, "problems", "battles"));
    cpSync(directory, join(copied, "problems", "battles", "sqli-demo"), { recursive: true });
    expect(() => loadDockerCatalog(copied, [join(copied, "problems")])).toThrow(
      "Duplicate local problem ID",
    );
  });
});

test("runtime discovery ignores unvalidated shared directories", () => {
  fixture((copied, directory) => {
    mkdirSync(join(copied, "problems", "shared"));
    cpSync(directory, join(copied, "problems", "shared", "extra"), { recursive: true });
    expect(
      loadDockerCatalog(copied, [join(copied, "problems")]).map((problem) => problem.problemId),
    ).toEqual(["sqli-demo"]);
  });
});

test("SDK titles are normalized consistently without changing immutable source metadata", () => {
  fixture((copied, directory) => {
    const path = join(directory, "metadata.json");
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    delete metadata.name;
    metadata.title = "Authored SQL title";
    metadata.category = "challenge";
    const raw = JSON.stringify(metadata);
    writeFileSync(path, raw);
    const problem = loadDockerCatalog(copied, [join(copied, "problems")])[0];
    expect(problem?.name).toBe("Authored SQL title");
    expect(problem?.publicCatalog?.name).toBe("Authored SQL title");
    expect(JSON.parse(problem?.definition ?? "{}").problem.name).toBe("Authored SQL title");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
});

test("optional organizer text does not make an existing runtime problem unsupported", () => {
  for (const omitDescription of [false, true])
    fixture((copied, directory) => {
      const path = join(directory, "metadata.json");
      const metadata = JSON.parse(readFileSync(path, "utf8"));
      delete metadata.learningGoals;
      if (omitDescription) delete metadata.description;
      writeFileSync(path, JSON.stringify(metadata));
      const problem = loadDockerCatalog(copied, [join(copied, "problems")])[0];
      expect(problem?.problemId).toBe("sqli-demo");
      expect(problem?.organizerContent).toEqual(
        omitDescription
          ? undefined
          : {
              description: metadata.description,
              learningGoals: [],
              i18n: {
                en: {
                  description: metadata.i18n.en.description,
                  learningGoals: metadata.i18n.en.learningGoals,
                },
              },
            },
      );
      if (!problem) throw new Error("Expected the existing runtime problem.");
      expect(JSON.parse(problem.definition).problem.description).toBe(metadata.description ?? "");
    });
});
