import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #2948 / ADR-0005 Phase 1: 実行時には観測できない 3 つの invariant を source level で pin する。
 *
 * - **T-20** `machine-scopes.ts` は CDK を import しない。この module は Lambda bundle (esbuild) と
 *   CDK synth の両方から読まれるため、CDK 依存が入ると handler bundle が壊れる。
 * - **T-21** `TENANT_MACHINE_ROLE` を `requireRole` の allowlist に足すのは 1 箇所だけ。増えれば
 *   machine の write surface が広がったということなので、レビューを強制する。
 * - **T-19** machine 用 construct を instantiate するのは `tenant-template-stack.ts` だけ。Lite
 *   stack は `buildAppPlaneCore` を直接呼ぶため、machine 経路を構造的に持たない。
 */

function readRepoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
}

describe("#2948 T-20: machine-scopes.ts stays CDK-free", () => {
  it("should not import aws-cdk-lib or constructs", () => {
    const source = readRepoFile("lib/problem-deploy/handlers/shared/machine-scopes.ts");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1] as string,
    );
    expect(imports.filter((specifier) => /aws-cdk-lib|^constructs$/.test(specifier))).toEqual([]);
  });
});

describe("#2948 T-21: TenantMachine appears in exactly one requireRole allowlist", () => {
  it("should only widen POST /problems/:problemId/deploy", () => {
    const source = readRepoFile("lib/problem-deploy/handlers/deploy-handler/index.ts");
    const callSites = [...source.matchAll(/requireRole\(\s*c,\s*\[([^\]]*)\]/g)].filter((match) =>
      (match[1] as string).includes("TENANT_MACHINE_ROLE"),
    );
    expect(callSites.length).toBe(1);

    // その 1 箇所が deploy route の直下であることも確認する (= 別 route に付け替えられていない)。
    const index = source.indexOf('app.post("/problems/:problemId/deploy"');
    expect(index).toBeGreaterThan(-1);
    const machineIndex = source.indexOf("TENANT_MACHINE_ROLE]", index);
    expect(machineIndex).toBeGreaterThan(index);
    expect(machineIndex - index).toBeLessThan(600);
  });

  it("should never widen a requireRole allowlist in the event or competitor-accounts handlers", () => {
    for (const relativePath of [
      "lib/problem-deploy/handlers/event-handler/index.ts",
      "lib/problem-deploy/handlers/competitor-accounts-handler/index.ts",
    ]) {
      const source = readRepoFile(relativePath);
      const callSites = [...source.matchAll(/requireRole\(\s*c,\s*\[([^\]]*)\]/g)].filter((match) =>
        (match[1] as string).includes("TENANT_MACHINE_ROLE"),
      );
      expect(callSites, relativePath).toEqual([]);
    }
  });
});

describe("#2948 T-19: only the tenant template stack builds the machine surface", () => {
  it("should not instantiate MachineIdentity or MachineApiGateway in the Lite stack", () => {
    const liteSource = readRepoFile("lib/tenkacloud-lite/tenkacloud-lite-stack.ts");
    expect(liteSource).not.toContain("MachineIdentity");
    expect(liteSource).not.toContain("MachineApiGateway");
  });

  it("should not instantiate the machine surface inside buildAppPlaneCore (shared by Lite)", () => {
    const coreSource = readRepoFile("lib/app-plane-core/app-plane-core.ts");
    expect(coreSource).not.toContain("MachineIdentity");
    expect(coreSource).not.toContain("MachineApiGateway");
  });
});
