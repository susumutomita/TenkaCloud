import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apiBodyLimit, MAX_SUBMISSION_BODY } from "../submission-size";

test("only the participant scoring envelope permits sealed workbench expansion", () => {
  expect(apiBodyLimit("/portal/me/submit-flag", 65_536)).toBe(131_072);
  for (const path of ["/portal/me", "/events", "/portal/me/submit-flag/extra"])
    expect(apiBodyLimit(path, 65_536)).toBe(65_536);
});

test("large canonical code references fit a sealed scoring request", () => {
  for (const path of [
    "ac26-w5-pbs-homnand/local/reference/pipeline.py",
    "ac26-w6-zkvm-witness-binding/local/reference/guest.py",
    "ac26-w7-capstone-design/local/reference/design.py",
  ]) {
    const source = readFileSync(
      new URL(`../../../problems/challenges/${path}`, import.meta.url),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(16_384);
    const payload = JSON.stringify({ v: 1, checkpointId: "code", answer: source });
    const flag = `tcw1.${Buffer.from(payload).toString("base64url")}.synthetic`;
    expect(Buffer.byteLength(JSON.stringify({ problemId: path.split("/")[0], flag }))).toBeLessThan(
      MAX_SUBMISSION_BODY,
    );
  }
});
