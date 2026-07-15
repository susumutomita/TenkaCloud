import { describe, expect, it } from "vitest";
import type { RuleContext } from "../types.ts";
import { handlerNoTransitiveCdkImport } from "./handler-no-transitive-cdk-import.ts";

const HANDLER = "infrastructure/lib/problem-deploy/handlers/example-handler/index.ts";

function contextOf(
  files: Record<string, string>,
  stagedFiles: readonly string[] = Object.keys(files),
): RuleContext {
  return {
    files: stagedFiles,
    allFiles: Object.keys(files),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`missing virtual file: ${path}`);
      return content;
    },
  };
}

describe("handler-no-transitive-cdk-import", () => {
  it("should report the full value-import chain from a handler to aws-cdk-lib", () => {
    const findings = handlerNoTransitiveCdkImport.check(
      contextOf({
        [HANDLER]: 'import { createRuntime } from "../../control-data/runtime.js";',
        "infrastructure/lib/problem-deploy/control-data/runtime.ts":
          'export { buildKey } from "../problem-endpoints-table.js";',
        "infrastructure/lib/problem-deploy/problem-endpoints-table.ts":
          'import { RemovalPolicy } from "aws-cdk-lib";',
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "handler-no-transitive-cdk-import",
      severity: "error",
      filePath: HANDLER,
      match: "aws-cdk-lib",
    });
    expect(findings[0]?.message).toContain(
      `${HANDLER} -> infrastructure/lib/problem-deploy/control-data/runtime.ts`,
    );
    expect(findings[0]?.message).toContain(
      "infrastructure/lib/problem-deploy/problem-endpoints-table.ts -> aws-cdk-lib",
    );
  });

  it("should scan every tracked handler even when only a transitive leaf is staged", () => {
    const leaf = "infrastructure/lib/problem-deploy/runtime-leaf.ts";
    const findings = handlerNoTransitiveCdkImport.check(
      contextOf(
        {
          [HANDLER]: 'import "../../runtime-leaf.js";',
          [leaf]: 'import { Stack } from "aws-cdk-lib";',
        },
        [leaf],
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.filePath).toBe(HANDLER);
  });

  it("should ignore type-only CDK imports because esbuild erases them", () => {
    const findings = handlerNoTransitiveCdkImport.check(
      contextOf({
        [HANDLER]: 'import { useRuntime } from "../../runtime.js";',
        "infrastructure/lib/problem-deploy/runtime.ts": [
          'import type { Stack } from "aws-cdk-lib";',
          'import { type Table } from "aws-cdk-lib/aws-dynamodb";',
          "export const useRuntime = () => true;",
        ].join("\n"),
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("should allow pure runtime graphs and terminate on cycles", () => {
    const findings = handlerNoTransitiveCdkImport.check(
      contextOf({
        [HANDLER]: 'import { a } from "./a.js";',
        "infrastructure/lib/problem-deploy/handlers/example-handler/a.ts":
          'import { b } from "./b.js"; export const a = b;',
        "infrastructure/lib/problem-deploy/handlers/example-handler/b.ts":
          'import { a } from "./a.js"; export const b = () => a;',
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("should ignore commented imports and files outside handlers as roots", () => {
    const findings = handlerNoTransitiveCdkImport.check(
      contextOf({
        [HANDLER]: [
          '// import { Stack } from "aws-cdk-lib";',
          '/* import { App } from "aws-cdk-lib"; */',
          "export const handler = () => undefined;",
        ].join("\n"),
        "infrastructure/lib/problem-deploy/construct-only.ts":
          'import { Stack } from "aws-cdk-lib";',
      }),
    );
    expect(findings).toHaveLength(0);
  });
});
