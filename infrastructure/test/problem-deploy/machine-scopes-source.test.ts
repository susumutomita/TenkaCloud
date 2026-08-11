import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_MACHINE_REACHABILITY,
  MACHINE_ROUTE_SCOPES,
} from "../../lib/problem-deploy/handlers/shared/machine-scopes";

/**
 * Issue #2948: 実行時には観測できない 3 つの invariant を source level で pin する。
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

describe("#2948 T-21 / #2955: TenantMachine is only widened on the declared mutating routes", () => {
  it("should widen exactly the two routes the allowlist declares as mutating", () => {
    // machine が到達できる mutating route は `MACHINE_ROUTE_SCOPES` の POST 2 本だけである。
    // `requireRole` に `TENANT_MACHINE_ROLE` を足した箇所がそれより増えたら、allowlist に無い
    // route が role の上では通るようになったということなので、ここで落とす。
    const source = readRepoFile("lib/problem-deploy/handlers/deploy-handler/index.ts");
    const callSites = [...source.matchAll(/requireRole\(\s*c,\s*\[([^\]]*)\]/g)].filter((match) =>
      (match[1] as string).includes("TENANT_MACHINE_ROLE"),
    );
    const mutatingRoutes = MACHINE_ROUTE_SCOPES.filter((route) => route.method === "POST");
    expect(callSites.length).toBe(mutatingRoutes.length);
  });

  it.each([
    ["/problems/:problemId/deploy"],
    ["/deployments/retry"],
  ])("should attach the widened allowlist directly to %s", (honoPath) => {
    const source = readRepoFile("lib/problem-deploy/handlers/deploy-handler/index.ts");
    const index = source.indexOf(`app.post("${honoPath}"`);
    expect(index).toBeGreaterThan(-1);
    const machineIndex = source.indexOf("TENANT_MACHINE_ROLE]", index);
    expect(machineIndex).toBeGreaterThan(index);
    expect(machineIndex - index).toBeLessThan(900);
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

describe("#2955: every machine route declares what asynchronous work it can reach", () => {
  it("should never open a route that reaches the scheduler or a reconciler", () => {
    // design C は `PATCH /events/{id}/schedule` でここを踏んだ。同期的には 1 field の書き込みに
    // 見えて、実際には競技進行そのものを動かす経路だった。宣言を必須 field にしてあるので、
    // route を足す人は必ずこの問いに答える。
    for (const route of MACHINE_ROUTE_SCOPES) {
      expect(ALLOWED_MACHINE_REACHABILITY, `${route.method} ${route.apigwPath}`).toContain(
        route.reachability,
      );
    }
  });

  it("should carry repo evidence for the claim on every route", () => {
    for (const route of MACHINE_ROUTE_SCOPES) {
      expect(
        route.reachabilityEvidence.length,
        `${route.method} ${route.apigwPath}`,
      ).toBeGreaterThan(20);
      // 「どのファイルを読めば確かめられるか」が書いてあること。
      expect(route.reachabilityEvidence, `${route.method} ${route.apigwPath}`).toMatch(/\.ts/);
    }
  });

  it("should only mark a route deploy-pipeline when it is a POST", () => {
    for (const route of MACHINE_ROUTE_SCOPES) {
      if (route.reachability === "deploy-pipeline") expect(route.method).toBe("POST");
      if (route.method === "GET") expect(route.reachability).toBe("none");
    }
  });
});

describe("#2955: the retry route is wired on both gateways", () => {
  it("should expose POST /deployments/retry on the human TenantAPI too", () => {
    // handler 側 (#911) には最初からあったのに gateway resource が無く、human からも到達でき
    // なかった。machine 側にだけ開くと、経路によって surface が食い違う状態が残る。
    const source = readRepoFile("lib/tenant-template/api-gateway.ts");
    expect(source).toContain('addResource("retry").addMethod("POST"');
  });
});
