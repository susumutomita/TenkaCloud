import { afterEach, describe, expect, it, vi } from "vitest";
import { handler } from "../../lib/problem-deploy/handlers/system-audit-writer/index";
import { inspectRuntimeBundle } from "./runtime-bundle-inspection";

afterEach(() => vi.unstubAllEnvs());

describe("retired audit writer compatibility entrypoint", () => {
  it.each(["true", "false"])(
    "cannot resume collection with legacy AUDIT_LOG_ENABLED=%s",
    async (enabled) => {
      vi.stubEnv("AUDIT_LOG_ENABLED", enabled);
      vi.stubEnv("ADMIN_AUDIT_LOG_TABLE_NAME", "retained-history");
      const payload = new Proxy(
        {},
        {
          get() {
            throw new Error("Retired writer must not inspect queued payloads");
          },
        },
      );
      await expect(handler(payload)).resolves.toBeUndefined();
    },
  );

  it("keeps the compatibility bundle free of database writers and clients", async () => {
    const bundle = await inspectRuntimeBundle(
      "../../lib/problem-deploy/handlers/system-audit-writer/index.ts",
    );
    expect(
      bundle.inputs.some((input) => /control-data|audit-log|@aws-sdk|@libsql/u.test(input)),
    ).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
  });
});
