import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeTenantScript,
  FETCH_SOURCE_BUNDLE_MARKER,
} from "../../lib/bootstrap-template/compose-tenant-script";

const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * [#2217] composeTenantScript inlines the shared source-bundle fetch snippet into
 * the provision/deprovision ScriptJob scripts at the marker line. Assert the real
 * checked-in scripts still carry the marker and that the composed output contains
 * the fetch commands with the marker gone (a stale marker would ship a script that
 * never downloads the bundle).
 */
describe("composeTenantScript (#2217)", () => {
  for (const script of ["scripts/provision-tenant.sh", "scripts/deprovision-tenant.sh"]) {
    describe(script, () => {
      const composed = composeTenantScript(resolve(REPO_ROOT, script));

      it("should replace the injection marker with the fetch snippet", () => {
        expect(composed).not.toContain(FETCH_SOURCE_BUNDLE_MARKER);
        expect(composed).toContain(
          'aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME"',
        );
        expect(composed).toContain('unzip -o "$CDK_SOURCE_NAME"');
      });

      it("should keep the injected-bucket fail-loud guard from #2194", () => {
        expect(composed).toContain("CDK_PARAM_S3_BUCKET_NAME is not set");
      });

      it("should preserve the script's own tail (install-node)", () => {
        expect(composed).toContain("install_node_from_nvmrc");
      });
    });
  }

  it("should throw (fail-loud) when the marker is absent", () => {
    const fakeRead = (path: string) =>
      path.endsWith("fetch-source-bundle.sh") ? "echo fetch" : "#!/bin/bash\necho no-marker\n";
    expect(() => composeTenantScript("../scripts/provision-tenant.sh", fakeRead)).toThrow(
      /marker .* not found/,
    );
  });
});
