import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [#2194] scripts/lib/names.sh is the single source of truth for the SaaS
 * source-bundle bucket name. This pins the exact strings the creator
 * (prepare-source-bundle.sh), the destroy path (cleanup.sh), and any future
 * consumer must agree on — so the "hashed vs no-hash" drift cannot reappear.
 */

const NAMES_SH = resolve(__dirname, "..", "..", "..", "scripts", "lib", "names.sh");

/** Source names.sh and evaluate one helper call, returning its trimmed stdout. */
function callHelper(call: string): string {
  const result = spawnSync("bash", ["-c", `source "${NAMES_SH}"; ${call}`], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("scripts/lib/names.sh source bucket name (#2194)", () => {
  const account = "111122223333";
  const region = "ap-northeast-1";

  it("should build the legacy account+region name without a hash", () => {
    expect(callHelper(`tc_source_bucket_legacy_name "${account}" "${region}"`)).toBe(
      "tenkacloud-source-111122223333-ap-northeast-1",
    );
  });

  it("should compute the 8-hex per-environment hash of account-env", () => {
    // sha256("111122223333-development") first 8 hex chars — the exact value the
    // deploy path (prepare-source-bundle.sh) produces for the default environment.
    expect(callHelper(`tc_source_bucket_env_hash "${account}" development`)).toBe("a4afa368");
  });

  it("should default the environment to development when omitted", () => {
    expect(callHelper(`tc_source_bucket_env_hash "${account}"`)).toBe("a4afa368");
  });

  it("should derive a different hash for a different environment", () => {
    const dev = callHelper(`tc_source_bucket_env_hash "${account}" development`);
    const prod = callHelper(`tc_source_bucket_env_hash "${account}" production`);
    expect(prod).toMatch(/^[0-9a-f]{8}$/);
    expect(prod).not.toBe(dev);
  });

  it("should build the canonical hashed name as legacy + 8-hex suffix", () => {
    expect(callHelper(`tc_source_bucket_name "${account}" "${region}" development`)).toBe(
      "tenkacloud-source-111122223333-ap-northeast-1-a4afa368",
    );
  });

  it("should keep the canonical name within the 63-char S3 limit", () => {
    const name = callHelper(`tc_source_bucket_name "${account}" "${region}" production`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^tenkacloud-source-111122223333-ap-northeast-1-[0-9a-f]{8}$/);
  });
});
