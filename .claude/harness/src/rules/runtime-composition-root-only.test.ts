import { describe, expect, it } from "vitest";
import { runtimeCompositionRootOnly } from "./runtime-composition-root-only.ts";

const IMPORT_LINE =
  'import { createDefaultControlDataRuntime } from "../../control-data/runtime-repositories.js";';
const CALL_LINE = "const runtime = createDefaultControlDataRuntime();";

describe("runtime-composition-root-only", () => {
  it("should flag a self-composed runtime inside a handler service module as error", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/handlers/deploy-handler/deploy.ts"],
      readFile: () => `${IMPORT_LINE}\n${CALL_LINE}`,
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]?.ruleId).toBe("runtime-composition-root-only");
    expect(findings[0]?.severity).toBe("error");
  });

  it("should flag a shared util composing its own runtime", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/handlers/shared/competitor-account-lookup.ts"],
      readFile: () => CALL_LINE,
    });
    expect(findings).toHaveLength(1);
  });

  it("should allow a Lambda entrypoint (handlers/<name>/index.ts) composition root", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/handlers/event-handler/index.ts"],
      readFile: () => `${IMPORT_LINE}\n${CALL_LINE}`,
    });
    expect(findings).toHaveLength(0);
  });

  it("should allow the intent-ingress entrypoint (handler/index.ts, singular)", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/intent-ingress/handler/index.ts"],
      readFile: () => CALL_LINE,
    });
    expect(findings).toHaveLength(0);
  });

  it("should allow the documented audit-log side-channel default", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/handlers/shared/audit-log.ts"],
      readFile: () => CALL_LINE,
    });
    expect(findings).toHaveLength(0);
  });

  it("should allow the factory's own definition module", () => {
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/control-data/runtime-repositories.ts"],
      readFile: () => "export function createDefaultControlDataRuntime() {}",
    });
    expect(findings).toHaveLength(0);
  });

  it("should not flag JSDoc references to the factory (comment lines)", () => {
    const code = [
      "/**",
      " * The Lambda entrypoint (`index.ts`) creates it via `createDefaultControlDataRuntime()` and",
      " * injects it here.",
      " */",
      "export const x = 1;",
    ].join("\n");
    const findings = runtimeCompositionRootOnly.check({
      files: ["infrastructure/lib/problem-deploy/handlers/event-handler/shared.ts"],
      readFile: () => code,
    });
    expect(findings).toHaveLength(0);
  });
});
