import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiBodyLimit, MAX_SUBMISSION_BODY } from "../submission-size";

test("only the participant scoring envelope permits sealed workbench expansion", () => {
  expect(apiBodyLimit("/portal/me/submit-flag", 65_536)).toBe(131_072);
  for (const path of ["/portal/me", "/events", "/portal/me/submit-flag/extra"])
    expect(apiBodyLimit(path, 65_536)).toBe(65_536);
});

test("large canonical code references fit a sealed scoring request", () => {
  const directory = mkdtempSync(join(tmpdir(), "tenka-submission-size-"));
  try {
    for (const [problemId, lines] of [
      ["reference-small", 300],
      ["reference-medium", 800],
      ["reference-large", 1_400],
    ] as const) {
      const path = join(directory, problemId, "local/reference/pipeline.py");
      mkdirSync(join(directory, problemId, "local/reference"), { recursive: true });
      writeFileSync(
        path,
        Array.from(
          { length: lines },
          (_, line) => `def step_${line}(state): return state["value"] + ${line}  # canonical`,
        ).join("\n"),
      );
      const source = readFileSync(path, "utf8");
      expect(source.length).toBeGreaterThan(16_384);
      const payload = JSON.stringify({ v: 1, checkpointId: "code", answer: source });
      const flag = `tcw1.${Buffer.from(payload).toString("base64url")}.synthetic`;
      expect(Buffer.byteLength(JSON.stringify({ problemId, flag }))).toBeLessThan(
        MAX_SUBMISSION_BODY,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
