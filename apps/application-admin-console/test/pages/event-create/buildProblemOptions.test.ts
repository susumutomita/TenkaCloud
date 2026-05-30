import { describe, expect, it } from "vitest";
import { buildProblemOptions } from "../../../src/pages/event-create/helpers";

/**
 * #1414 (ADR-026 / ADR-027): event の problem picker option 組立。 deploy 可能な
 * aws/cloudformation 問題は通常 option、 予約済み (sakura/azure/gcp) は disabled +
 * 「近日対応」 tag にして event に組み込めないようにする (= deployable-but-failing 防止)。
 */
const problem = (id: string, provider: string, engine: string) => ({
  id,
  name: `Problem ${id}`,
  runtime: { provider, engine },
});

describe("buildProblemOptions", () => {
  it("should make an executable aws/cloudformation problem a normal selectable option", () => {
    const [opt] = buildProblemOptions([problem("p1", "aws", "cloudformation")], "近日対応");
    expect(opt).toEqual({ value: "p1", label: "Problem p1 (p1)" });
    expect(opt.disabled).toBeUndefined();
  });

  it("should disable a reserved (non-executable) problem with the coming-soon tag", () => {
    const [opt] = buildProblemOptions([problem("a1", "azure", "bicep")], "近日対応");
    expect(opt).toMatchObject({
      value: "a1",
      label: "Problem a1 (a1)",
      disabled: true,
      labelTag: "近日対応",
    });
  });

  it("should map a mixed catalog, disabling only the reserved entries", () => {
    const opts = buildProblemOptions(
      [
        problem("aws-x", "aws", "cloudformation"),
        problem("sakura-x", "sakura", "apprun"),
        problem("gcp-x", "gcp", "infra-manager"),
      ],
      "近日対応",
    );
    expect(opts.map((o) => Boolean(o.disabled))).toEqual([false, true, true]);
  });
});
