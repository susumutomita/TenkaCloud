import { describe, expect, it } from "vitest";
import { enabledNonAwsProviders } from "../../../src/data/problems";
import { buildProblemOptions } from "../../../src/pages/event-create/helpers";

/**
 * #1414 / #2167 (ADR-026 / ADR-027 / ADR-035): event の problem picker option 組立。
 * aws/cloudformation 問題は常に選択可。 予約 provider (sakura/azure/gcp) は
 * multi-cloud (`features.nonAwsRuntime`) ON のとき選択可、 OFF なら disabled +
 * 「近日対応」 tag (= deploy 不可な問題を event に組み込めないようにする)。
 */
const problem = (id: string, provider: string, engine: string) => ({
  id,
  name: `Problem ${id}`,
  runtime: { provider, engine },
});

const FLAG_OFF = enabledNonAwsProviders(false);
const FLAG_ON = enabledNonAwsProviders(true);

describe("buildProblemOptions", () => {
  it("should make an executable aws/cloudformation problem a normal selectable option", () => {
    const [opt] = buildProblemOptions(
      [problem("p1", "aws", "cloudformation")],
      "近日対応",
      FLAG_OFF,
    );
    expect(opt).toEqual({ value: "p1", label: "Problem p1 (p1)" });
    expect(opt.disabled).toBeUndefined();
  });

  it("should disable a reserved problem with the coming-soon tag when multi-cloud is OFF", () => {
    const [opt] = buildProblemOptions([problem("a1", "azure", "bicep")], "近日対応", FLAG_OFF);
    expect(opt).toMatchObject({
      value: "a1",
      label: "Problem a1 (a1)",
      disabled: true,
      labelTag: "近日対応",
    });
  });

  it("should make reserved-provider problems selectable when multi-cloud is ON", () => {
    const opts = buildProblemOptions(
      [
        problem("aws-x", "aws", "cloudformation"),
        problem("sakura-x", "sakura", "apprun"),
        problem("azure-x", "azure", "bicep"),
        problem("gcp-x", "gcp", "infra-manager"),
      ],
      "近日対応",
      FLAG_ON,
    );
    expect(opts.map((o) => Boolean(o.disabled))).toEqual([false, false, false, false]);
  });

  it("should still disable an unknown (typo) runtime even when multi-cloud is ON", () => {
    const [opt] = buildProblemOptions([problem("typo", "gcp", "cdktf")], "近日対応", FLAG_ON);
    expect(opt).toMatchObject({ disabled: true, labelTag: "近日対応" });
  });

  it("should map a mixed catalog, disabling only the reserved entries when OFF", () => {
    const opts = buildProblemOptions(
      [
        problem("aws-x", "aws", "cloudformation"),
        problem("sakura-x", "sakura", "apprun"),
        problem("gcp-x", "gcp", "infra-manager"),
      ],
      "近日対応",
      FLAG_OFF,
    );
    expect(opts.map((o) => Boolean(o.disabled))).toEqual([false, true, true]);
  });
});
