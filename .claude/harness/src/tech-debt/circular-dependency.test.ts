import { describe, expect, it } from "vitest";
import {
  buildGraph,
  buildWorkspaceMap,
  circularDependency,
  extractImportSpecifiers,
  findCycles,
  resolveSpecifier,
} from "./circular-dependency.ts";

/**
 * Helper: build a RuleContext from a virtual file map.
 *
 * The map keys are repo-relative POSIX paths exactly as `git ls-files` would
 * produce them. `readFile` returns the string verbatim; missing paths throw
 * (matching node fs ENOENT behaviour the production code is tolerant of).
 */
function ctx(fs: Record<string, string>) {
  return {
    files: Object.keys(fs),
    readFile: (path: string): string => {
      const v = fs[path];
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
  };
}

describe("circular-dependency", () => {
  describe("extractImportSpecifiers", () => {
    it("should extract default + named imports", () => {
      const src = [
        `import foo from "./foo";`,
        `import { bar, baz } from "./bar";`,
        `import * as q from "../q";`,
      ].join("\n");
      expect(extractImportSpecifiers(src).sort()).toEqual(["../q", "./bar", "./foo"]);
    });

    it("should extract side-effect imports", () => {
      const src = `import "./register-globals";`;
      expect(extractImportSpecifiers(src)).toEqual(["./register-globals"]);
    });

    it("should extract `export ... from` re-exports", () => {
      const src = [
        `export { a } from "./a";`,
        `export * from "./b";`,
        `export type { T } from "./types";`,
      ].join("\n");
      expect(extractImportSpecifiers(src).sort()).toEqual(["./a", "./b", "./types"]);
    });

    it("should ignore dynamic import()", () => {
      const src = [
        `const m = await import("./dynamic");`,
        `const fn = () => import("./lazy");`,
      ].join("\n");
      expect(extractImportSpecifiers(src)).toEqual([]);
    });

    it("should ignore imports inside block comments", () => {
      const src = [`/*`, `import { fake } from "./not-real";`, `*/`, `const x = 1;`].join("\n");
      expect(extractImportSpecifiers(src)).toEqual([]);
    });

    it("should ignore imports inside line comments", () => {
      const src = `// import { fake } from "./not-real";\nconst x = 1;`;
      expect(extractImportSpecifiers(src)).toEqual([]);
    });
  });

  describe("resolveSpecifier", () => {
    const fileSet = new Set([
      "infrastructure/lib/a/index.ts",
      "infrastructure/lib/a/util.ts",
      "infrastructure/lib/b/helper.tsx",
      "packages/portal-plugin-sdk/src/index.ts",
    ]);
    const workspaces = {
      byName: new Map([
        ["@tenkacloud/portal-plugin-sdk", "packages/portal-plugin-sdk/src/index.ts"],
      ]),
    };

    it("should resolve relative `./foo` to `foo.ts`", () => {
      const r = resolveSpecifier("infrastructure/lib/a/index.ts", "./util", fileSet, workspaces);
      expect(r).toBe("infrastructure/lib/a/util.ts");
    });

    it("should resolve relative `./foo` to `foo/index.ts`", () => {
      const r = resolveSpecifier(
        "infrastructure/lib/x.ts",
        "./a",
        new Set([...fileSet]),
        workspaces,
      );
      expect(r).toBe("infrastructure/lib/a/index.ts");
    });

    it("should resolve `.tsx` extension", () => {
      const r = resolveSpecifier("infrastructure/lib/b/index.ts", "./helper", fileSet, workspaces);
      expect(r).toBe("infrastructure/lib/b/helper.tsx");
    });

    it("should resolve workspace package specifier", () => {
      const r = resolveSpecifier(
        "infrastructure/lib/a/index.ts",
        "@tenkacloud/portal-plugin-sdk",
        fileSet,
        workspaces,
      );
      expect(r).toBe("packages/portal-plugin-sdk/src/index.ts");
    });

    it("should ignore external bare specifiers", () => {
      const r = resolveSpecifier("infrastructure/lib/a/index.ts", "hono", fileSet, workspaces);
      expect(r).toBeUndefined();
    });

    it("should ignore scoped externals that aren't workspace packages", () => {
      const r = resolveSpecifier(
        "infrastructure/lib/a/index.ts",
        "@aws-sdk/client-s3",
        fileSet,
        workspaces,
      );
      expect(r).toBeUndefined();
    });
  });

  describe("buildWorkspaceMap", () => {
    it("should read workspace package names + entry points", () => {
      const fs = {
        "packages/portal-plugin-sdk/package.json": JSON.stringify({
          name: "@tenkacloud/portal-plugin-sdk",
          main: "src/index.ts",
        }),
        "packages/trust-bridge/package.json": JSON.stringify({
          name: "@TenkaCloud/trust-bridge",
          main: "./src/index.ts",
        }),
      };
      const map = buildWorkspaceMap(ctx(fs));
      expect(map.byName.get("@tenkacloud/portal-plugin-sdk")).toBe(
        "packages/portal-plugin-sdk/src/index.ts",
      );
      // case-insensitive registration so `@TenkaCloud/trust-bridge` resolves whether
      // source uses upper or lower case scope.
      expect(map.byName.get("@tenkacloud/trust-bridge")).toBe("packages/trust-bridge/src/index.ts");
    });

    it("should tolerate missing package.json (ENOENT)", () => {
      const map = buildWorkspaceMap(ctx({}));
      expect(map.byName.size).toBe(0);
    });
  });

  describe("findCycles", () => {
    it("should return no SCCs for an acyclic graph", () => {
      // a -> b -> c, no cycle
      const fs = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.ts": `import "./c";`,
        "infrastructure/lib/c.ts": `export const x = 1;`,
      };
      const graph = buildGraph(ctx(fs));
      const sccs = findCycles(graph);
      expect(sccs).toEqual([]);
    });

    it("should report a 2-file cycle (a <-> b)", () => {
      const fs = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("warning");
      expect(findings[0]?.match).toBe("cycle:infrastructure/lib/a.ts|infrastructure/lib/b.ts");
      expect(findings[0]?.filePath).toBe("infrastructure/lib/a.ts");
    });

    it("should report a 3-file cycle and name all 3 files", () => {
      const fs = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.ts": `import "./c";`,
        "infrastructure/lib/c.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("3 files");
      expect(findings[0]?.message).toContain("a.ts");
      expect(findings[0]?.message).toContain("b.ts");
      expect(findings[0]?.message).toContain("c.ts");
      expect(findings[0]?.severity).toBe("warning");
    });

    it("should NOT report a self-loop (= 1-node SCC) by design", () => {
      // Even a self-import shouldn't yield a finding because SCC size is 1.
      // (TypeScript also forbids this at the language layer.)
      const fs = {
        "infrastructure/lib/a.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toEqual([]);
    });

    it("should ignore external bare specifiers", () => {
      const fs = {
        "infrastructure/lib/a.ts": `import { something } from "hono";\nimport "./b";`,
        "infrastructure/lib/b.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
    });

    it("should resolve `.tsx` and `/index.ts` extensions when building the graph", () => {
      const fs = {
        "apps/admin-console/src/a.tsx": `import "./b";`,
        "apps/admin-console/src/b/index.ts": `import "../a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain("apps/admin-console/src/a.tsx");
      expect(findings[0]?.message).toContain("apps/admin-console/src/b/index.ts");
    });

    it("should follow workspace-package edges through buildWorkspaceMap", () => {
      const fs = {
        "packages/trust-bridge/package.json": JSON.stringify({
          name: "@TenkaCloud/trust-bridge",
          main: "src/index.ts",
        }),
        "packages/trust-bridge/src/index.ts": `import "../../../infrastructure/lib/consumer.ts";`,
        "infrastructure/lib/consumer.ts": `import "@TenkaCloud/trust-bridge";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.match).toBe(
        "cycle:infrastructure/lib/consumer.ts|packages/trust-bridge/src/index.ts",
      );
    });

    it("should escalate severity to error when SCC size >= 4", () => {
      const fs = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.ts": `import "./c";`,
        "infrastructure/lib/c.ts": `import "./d";`,
        "infrastructure/lib/d.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe("error");
    });

    it("should produce a stable `match` regardless of file order in the input", () => {
      const fs1 = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.ts": `import "./a";`,
      };
      const fs2 = {
        "infrastructure/lib/b.ts": `import "./a";`,
        "infrastructure/lib/a.ts": `import "./b";`,
      };
      const m1 = circularDependency.check(ctx(fs1))[0]?.match;
      const m2 = circularDependency.check(ctx(fs2))[0]?.match;
      expect(m1).toBe(m2);
    });

    it("should not inspect *.test.ts files when forming the graph", () => {
      const fs = {
        "infrastructure/lib/a.ts": `import "./b";`,
        "infrastructure/lib/b.test.ts": `import "./a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      // b is a test, so it's excluded — no cycle.
      expect(findings).toEqual([]);
    });

    it("should not inspect files outside the production prefixes", () => {
      const fs = {
        "references/legacy-a.ts": `import "./legacy-b";`,
        "references/legacy-b.ts": `import "./legacy-a";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toEqual([]);
    });

    it("should report multiple independent cycles in stable order", () => {
      const fs = {
        "infrastructure/lib/x.ts": `import "./y";`,
        "infrastructure/lib/y.ts": `import "./x";`,
        "infrastructure/lib/p.ts": `import "./q";`,
        "infrastructure/lib/q.ts": `import "./p";`,
      };
      const findings = circularDependency.check(ctx(fs));
      expect(findings).toHaveLength(2);
      // sorted by filePath
      expect(findings[0]?.filePath).toBe("infrastructure/lib/p.ts");
      expect(findings[1]?.filePath).toBe("infrastructure/lib/x.ts");
    });
  });
});
