import { describe, expect, it } from "vitest";
import { enabledNonAwsProviders } from "../../../src/data/problems";
import { buildProblemOptions } from "../../../src/pages/event-create/helpers";

/**
 * #1414 / #2167 (runtime provider/engine and feature-flag rules), tightened by #2757: event の problem
 * picker option 組立。 aws/cloudformation 問題は常に選択可。 予約 provider の中でも
 * **executable** な provider (今日時点は sakura のみ) は multi-cloud
 * (`features.nonAwsRuntime`) ON のとき選択可、 OFF なら disabled + 「近日対応」 tag。
 * adapter-wired だが executable ではない provider (azure/gcp) は flag の ON/OFF に
 * かかわらず disabled のまま (= deploy 不可な問題を event に組み込めないようにする)。
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

  it("should make only the executable reserved provider (sakura) selectable when multi-cloud is ON", () => {
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
    // azure/bicep and gcp/infra-manager are adapter-wired previews (executable: false)
    // and must stay disabled even with the flag ON (#2757 regression coverage).
    expect(opts.map((o) => Boolean(o.disabled))).toEqual([false, false, true, true]);
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

  it("should make a composite option selectable only when every target is executable and enabled", () => {
    const composite = {
      id: "multi",
      name: "Problem multi",
      runtime: {
        kind: "composite" as const,
        targets: [
          { id: "aws", provider: "aws", engine: "cloudformation" },
          { id: "sakura", provider: "sakura", engine: "apprun" },
        ],
      },
    };

    expect(buildProblemOptions([composite], "近日対応", FLAG_OFF)[0]?.disabled).toBe(true);
    expect(buildProblemOptions([composite], "近日対応", FLAG_ON)[0]?.disabled).toBeUndefined();
  });

  it("should keep a composite option disabled when a target is only an adapter-wired preview (#2757)", () => {
    const composite = {
      id: "multi-preview",
      name: "Problem multi preview",
      runtime: {
        kind: "composite" as const,
        targets: [
          { id: "aws", provider: "aws", engine: "cloudformation" },
          { id: "gcp", provider: "gcp", engine: "infra-manager" },
          { id: "azure", provider: "azure", engine: "bicep" },
        ],
      },
    };

    // gcp/infra-manager and azure/bicep are adapter-wired but not executable, so this
    // composite must stay disabled even with the multi-cloud flag ON.
    expect(buildProblemOptions([composite], "近日対応", FLAG_OFF)[0]?.disabled).toBe(true);
    expect(buildProblemOptions([composite], "近日対応", FLAG_ON)[0]?.disabled).toBe(true);
  });
});
