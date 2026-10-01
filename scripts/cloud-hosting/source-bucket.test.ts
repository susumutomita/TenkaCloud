import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const tags = {
  TagSet: [
    { Key: "TenkaCloudProject", Value: "cloud-hosting" },
    { Key: "TenkaCloudPurpose", Value: "source-bundle" },
    { Key: "TenkaCloudAccount", Value: "123456789012" },
    { Key: "Environment", Value: "test" },
  ],
};
function check(mode: "exists" | "new" | "forbidden", ownership: unknown = tags, unrelated = false) {
  const directory = mkdtempSync(join(tmpdir(), "source-bucket-contract-"));
  directories.push(directory);
  const log = join(directory, "calls.log");
  const script = `set -euo pipefail
: > "$CALL_LOG"
aws() {
  printf '%s\\n' "$*" >> "$CALL_LOG"
  case "$2" in
    head-bucket)
      if [ "$MODE" = new ]; then echo '(404) Not Found' >&2; return 1; fi
      if [ "$MODE" = forbidden ]; then echo '(403) Forbidden' >&2; return 1; fi
      ;;
    get-bucket-tagging) printf '%s' "$OWNERSHIP" ;;
  esac
}
source "$SCRIPT_DIR/names.sh"
source "$SCRIPT_DIR/source-bucket.sh"
bucket="$(tc_source_bucket_name 123456789012 us-east-1 test)"
if [ "$UNRELATED" = 1 ]; then bucket=unrelated-fixture-bucket; fi
tc_ensure_source_bucket "$bucket" 123456789012 us-east-1 test "$SCRIPT_DIR"
aws s3api put-bucket-versioning --bucket "$bucket"
aws s3api put-bucket-lifecycle-configuration --bucket "$bucket"
`;
  const result = spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CALL_LOG: log,
      MODE: mode,
      OWNERSHIP: JSON.stringify(ownership),
      UNRELATED: unrelated ? "1" : "0",
      SCRIPT_DIR: import.meta.dirname,
    },
  });
  return { result, calls: readFileSync(log, "utf8") };
}

describe("source bucket ownership using a shell-function AWS mock, no network", () => {
  it("does not even query an unrelated env-supplied bucket", () => {
    const outcome = check("exists", tags, true);
    expect(outcome.result.status).not.toBe(0);
    expect(outcome.calls).toBe("");
  });
  it.each([
    { TagSet: [] },
    { TagSet: tags.TagSet.filter((tag) => tag.Key !== "TenkaCloudPurpose") },
    {
      TagSet: tags.TagSet.map((tag) =>
        tag.Key === "Environment" ? { ...tag, Value: "another" } : tag,
      ),
    },
  ])("refuses unowned or mismatched buckets without changing retention: %s", (ownership) => {
    const outcome = check("exists", ownership);
    expect(outcome.result.status).not.toBe(0);
    expect(outcome.calls).toContain("head-bucket");
    expect(outcome.calls).toContain("get-bucket-tagging");
    expect(outcome.calls).not.toContain("put-");
    expect(outcome.calls).not.toContain("create-bucket");
  });
  it("does not treat forbidden ownership checks as permission to recreate a bucket", () => {
    const outcome = check("forbidden");
    expect(outcome.result.status).not.toBe(0);
    expect(outcome.calls).not.toContain("create-bucket");
    expect(outcome.calls).not.toContain("put-");
  });
  it("allows retention changes only after matching existing installation and purpose tags", () => {
    const outcome = check("exists");
    expect(outcome.result.status).toBe(0);
    expect(outcome.calls.indexOf("get-bucket-tagging")).toBeLessThan(
      outcome.calls.indexOf("put-bucket-versioning"),
    );
    expect(outcome.calls).not.toContain("put-bucket-tagging");
  });
  it("tags a newly created canonical bucket before configuring versioning or lifecycle", () => {
    const outcome = check("new");
    expect(outcome.result.status).toBe(0);
    expect(outcome.calls.indexOf("create-bucket")).toBeLessThan(
      outcome.calls.indexOf("put-bucket-tagging"),
    );
    expect(outcome.calls.indexOf("put-bucket-tagging")).toBeLessThan(
      outcome.calls.indexOf("put-bucket-versioning"),
    );
    expect(outcome.calls).toContain("--expected-bucket-owner 123456789012");
  });
});
