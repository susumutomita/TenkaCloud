import { describe, expect, it } from "vitest";
import {
  type ApplicationStatus,
  type AttackProbeResult,
  type ParticipantProblemView,
  PortalScoringGateError,
  PortalValidationError,
  type SubmitFlagOutcome,
} from "../api/portal-client";
import {
  describeApplicationStatus,
  describeAttackProbe,
  formatProblemPanelActionError,
  localizeProblem,
  shouldRefreshAfterFlagSubmit,
  summarizeAttackProbes,
} from "./ProblemPanel.helpers";

// `t` echoes the key (+ params) so each branch is identifiable by its returned key.
const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const VKEY = "problem_panel.validation_error" as const;
const fmt = (err: unknown) => formatProblemPanelActionError(t, err, VKEY);

describe("formatProblemPanelActionError — scoring gate", () => {
  it("should describe scoring_not_started without an ETA", () => {
    expect(fmt(new PortalScoringGateError("scoring_not_started"))).toBe(
      "problem_panel.scoring_gate_not_started_no_eta",
    );
  });

  it("should describe scoring_not_started with an unparseable startsAt", () => {
    expect(fmt(new PortalScoringGateError("scoring_not_started", "not-a-date"))).toBe(
      "problem_panel.scoring_gate_not_started_unknown",
    );
  });

  it("should describe scoring_not_started whose startsAt has already passed", () => {
    expect(
      fmt(new PortalScoringGateError("scoring_not_started", "2020-01-01T00:00:00.000Z")),
    ).toContain("problem_panel.scoring_gate_not_started_passed");
  });

  it("should describe scoring_not_started with remaining minutes when startsAt is in the future", () => {
    const out = fmt(new PortalScoringGateError("scoring_not_started", "2999-01-01T00:00:00.000Z"));
    expect(out).toContain("problem_panel.scoring_gate_not_started_remaining");
    expect(out).toContain("minutes");
  });

  it("should describe scoring_ended (no / invalid / valid endsAt)", () => {
    expect(fmt(new PortalScoringGateError("scoring_ended"))).toBe(
      "problem_panel.scoring_gate_ended_no_eta",
    );
    expect(fmt(new PortalScoringGateError("scoring_ended", undefined, "nope"))).toBe(
      "problem_panel.scoring_gate_ended_unknown",
    );
    expect(
      fmt(new PortalScoringGateError("scoring_ended", undefined, "2026-05-15T00:00:00.000Z")),
    ).toContain("problem_panel.scoring_gate_ended_at");
  });

  it("should describe a locked gate as paused", () => {
    expect(fmt(new PortalScoringGateError("scoring_locked"))).toBe(
      "problem_panel.scoring_gate_paused",
    );
  });
});

describe("formatProblemPanelActionError — non-gate errors", () => {
  it("should map a PortalValidationError to the validation key with its errorCode", () => {
    expect(fmt(new PortalValidationError("flag_too_long"))).toContain(VKEY);
  });

  it("should map challenge_prerequisite_not_met to the gate guidance message (Issue #2283)", () => {
    // locked 問題への flag 提出 / hint reveal は backend 409 → PortalValidationError。
    // UI は通常先回り lock するが、 polling 反映前の隙間に届いたら親切文言を出す。
    expect(
      fmt(new PortalValidationError("challenge_prerequisite_not_met", { gateProblemId: "gate-1" })),
    ).toBe("problem_panel.prerequisite_locked_error");
  });

  it("should describe an emulated-host refusal with both architectures (#3008)", () => {
    // The case #3008 exists for: an amd64 benchmark asked to run on Apple Silicon. The
    // portal renders from the structured fields, not the server's prose, so the message
    // follows the participant's locale switch.
    expect(
      fmt(
        new PortalValidationError("incompatible_host", {
          code: "unsupported_architecture",
          requiredArchitectures: ["amd64"],
          hostArchitecture: "arm64",
        }),
      ),
    ).toBe(
      `problem_panel.incompatible_host_unsupported_architecture|${JSON.stringify({
        required: "amd64",
        host: "arm64",
      })}`,
    );
  });

  it("should name only the missing CPU flags (#3008)", () => {
    expect(
      fmt(
        new PortalValidationError("incompatible_host", {
          code: "missing_cpu_flags",
          missingCpuFlags: ["constant_tsc", "nonstop_tsc"],
        }),
      ),
    ).toBe(
      `problem_panel.incompatible_host_missing_cpu_flags|${JSON.stringify({
        flags: "constant_tsc, nonstop_tsc",
      })}`,
    );
  });

  it.each([
    ["unknown_host_architecture", "problem_panel.incompatible_host_unknown_architecture"],
    ["unknown_cpu_flags", "problem_panel.incompatible_host_unknown_cpu_flags"],
  ])("should describe the fail-closed %s refusal (#3008)", (code, expected) => {
    expect(fmt(new PortalValidationError("incompatible_host", { code }))).toContain(expected);
  });

  it("should still explain a refusal whose code it does not recognize (#3008)", () => {
    // A refusal must never degrade into a generic "invalid input" — the participant would
    // have no idea their machine is the reason.
    expect(fmt(new PortalValidationError("incompatible_host", { code: "future_reason" }))).toBe(
      "problem_panel.incompatible_host_generic",
    );
    expect(fmt(new PortalValidationError("incompatible_host"))).toBe(
      "problem_panel.incompatible_host_generic",
    );
  });

  it("should fall back to the Error message, then String() for unknowns", () => {
    expect(fmt(new Error("boom"))).toBe("boom");
    expect(fmt("weird")).toBe("weird");
  });
});

describe("shouldRefreshAfterFlagSubmit", () => {
  it("should refresh on ok / already_scored and not otherwise", () => {
    expect(shouldRefreshAfterFlagSubmit({ kind: "ok" } as SubmitFlagOutcome)).toBe(true);
    expect(shouldRefreshAfterFlagSubmit({ kind: "already_scored" } as SubmitFlagOutcome)).toBe(
      true,
    );
    expect(shouldRefreshAfterFlagSubmit({ kind: "wrong" } as SubmitFlagOutcome)).toBe(false);
  });
});

describe("describeApplicationStatus (#1917)", () => {
  const status = (over: Partial<ApplicationStatus>): ApplicationStatus => ({
    overall: "healthy",
    healthyCount: 1,
    totalCount: 1,
    ...over,
  });

  it("should map each overall to its StatusIndicator type", () => {
    expect(describeApplicationStatus(status({ overall: "healthy" }), t).type).toBe("success");
    expect(describeApplicationStatus(status({ overall: "degraded" }), t).type).toBe("warning");
    expect(describeApplicationStatus(status({ overall: "down" }), t).type).toBe("error");
    expect(describeApplicationStatus(status({ overall: "unknown" }), t).type).toBe("pending");
  });

  it("should label the health with the passing/total counts", () => {
    const out = describeApplicationStatus(
      status({ overall: "degraded", healthyCount: 2, totalCount: 5 }),
      t,
    );
    expect(out.label).toContain("problem_panel.health_degraded");
    expect(out.label).toContain('"healthy":2');
    expect(out.label).toContain('"total":5');
  });
});

describe("describeAttackProbe (#2422)", () => {
  const probe = (over: Partial<AttackProbeResult>): AttackProbeResult => ({
    outcome: "landed",
    penalty: 60,
    ...over,
  });

  it("should map landed to an error indicator with the negative delta this cycle", () => {
    const row = describeAttackProbe(probe({ outcome: "landed", penalty: 60 }), 0, t);
    expect(row.type).toBe("error");
    expect(row.outcomeLabel).toContain("problem_panel.attack_probe_landed");
    expect(row.outcomeLabel).toContain('"delta":-60');
    expect(row.outcomeLabel).toContain('"penalty":60');
  });

  it("should map blocked to success and skipped to pending with a zero delta", () => {
    expect(describeAttackProbe(probe({ outcome: "blocked" }), 0, t).type).toBe("success");
    const skipped = describeAttackProbe(probe({ outcome: "skipped" }), 0, t);
    expect(skipped.type).toBe("pending");
    expect(skipped.outcomeLabel).toContain('"delta":0');
  });

  it("should use the author label when present and index-number it otherwise", () => {
    expect(describeAttackProbe(probe({ label: "Auth bypass" }), 0, t).name).toBe("Auth bypass");
    const unnamed = describeAttackProbe(probe({ label: "   " }), 2, t);
    expect(unnamed.name).toContain("problem_panel.attack_probe_default_name");
    expect(unnamed.name).toContain('"index":3'); // index + 1
  });

  it("should include a non-blank symptom and drop a blank one", () => {
    expect(describeAttackProbe(probe({ symptom: "accepts login" }), 0, t).symptom).toBe(
      "accepts login",
    );
    expect(describeAttackProbe(probe({ symptom: "   " }), 0, t).symptom).toBeUndefined();
    expect(describeAttackProbe(probe({}), 0, t).symptom).toBeUndefined();
  });
});

describe("summarizeAttackProbes (#2422)", () => {
  const p = (outcome: AttackProbeResult["outcome"]): AttackProbeResult => ({
    outcome,
    penalty: 10,
  });

  it("should warn when at least one probe is still landing", () => {
    const out = summarizeAttackProbes([p("landed"), p("blocked")], t);
    expect(out.type).toBe("warning");
    expect(out.label).toContain("problem_panel.attack_probe_summary_landed");
    expect(out.label).toContain('"landed":1');
    expect(out.label).toContain('"total":2');
  });

  it("should report success when every probe is blocked or skipped", () => {
    const out = summarizeAttackProbes([p("blocked"), p("skipped")], t);
    expect(out.type).toBe("success");
    expect(out.label).toContain("problem_panel.attack_probe_summary_clear");
    expect(out.label).toContain('"total":2');
  });
});

describe("localizeProblem", () => {
  const base: ParticipantProblemView = {
    jobId: "local-sqli-demo",
    problemId: "sqli-demo",
    name: "SQL インジェクション",
    description: "脆弱なログイン。",
    instructions: "ログインを突破。",
    writeup: "日本語の解説",
    videoUrl: "/videos/onboarding/demo-ja.mp4",
    region: "local",
    awsAccountId: "local",
    status: "COMPLETE",
    stackOutputs: {},
    expiresAt: 0,
    score: 0,
    deployLog: { cursor: "", entries: [] },
    i18n: {
      en: {
        name: "SQL Injection",
        description: "Vuln login.",
        instructions: "Bypass it.",
        writeup: "English explanation",
        videoUrl: "/videos/onboarding/demo-en.mp4",
      },
    },
    scoring: {
      kind: "flag",
      points: 200,
      hints: [
        {
          id: "hint-1",
          penalty: 0,
          revealed: true,
          content: "クオート。",
          i18n: { en: { content: "Try a quote." } },
        },
        { id: "hint-2", penalty: 25, revealed: false },
      ],
    },
  };

  it("should return the problem unchanged for the ja (canonical) locale", () => {
    expect(localizeProblem(base, "ja")).toBe(base);
  });

  it("should overlay name/description/instructions and revealed hint content for en", () => {
    const out = localizeProblem(base, "en");
    expect(out.name).toBe("SQL Injection");
    expect(out.description).toBe("Vuln login.");
    expect(out.instructions).toBe("Bypass it.");
    expect(out.writeup).toBe("English explanation");
    expect(out.videoUrl).toBe("/videos/onboarding/demo-en.mp4");
    expect(out.scoring?.hints?.[0].content).toBe("Try a quote.");
    // a hint without a translation keeps its canonical (here: absent) content
    expect(out.scoring?.hints?.[1].content).toBeUndefined();
  });

  it("should fall back to canonical fields when the en overlay is missing or blank", () => {
    const out = localizeProblem(
      {
        ...base,
        i18n: { en: { name: "  ", description: "Only desc EN." } },
        scoring: {
          kind: "flag",
          points: 200,
          hints: [{ id: "hint-1", penalty: 0, revealed: true, content: "ja content" }],
        },
      },
      "en",
    );
    expect(out.name).toBe("SQL インジェクション"); // blank en.name → canonical ja
    expect(out.description).toBe("Only desc EN.");
    expect(out.instructions).toBe("ログインを突破。"); // no en.instructions → canonical ja
    expect(out.videoUrl).toBe("/videos/onboarding/demo-ja.mp4");
    expect(out.scoring?.hints?.[0].content).toBe("ja content"); // hint has no i18n → canonical
  });

  it("should handle a problem with no i18n and no scoring for en", () => {
    const out = localizeProblem(
      {
        ...base,
        i18n: undefined,
        scoring: undefined,
      },
      "en",
    );
    expect(out.name).toBe("SQL インジェクション");
    expect(out.scoring).toBeUndefined();
  });

  it("should keep scoring intact when it declares no hints", () => {
    const out = localizeProblem(
      { ...base, i18n: undefined, scoring: { kind: "uptime-flat" } },
      "en",
    );
    expect(out.scoring).toEqual({ kind: "uptime-flat" });
  });

  it("should localize per-flag hints for multi-flag scoring (#2711 follow-up)", () => {
    const out = localizeProblem(
      {
        ...base,
        scoring: {
          kind: "multi-flag",
          flags: [
            {
              id: "sub-1",
              label: "ステップ 1",
              points: 100,
              solved: false,
              hints: [
                {
                  id: "hint-1",
                  penalty: 0,
                  revealed: true,
                  content: "日本語ヒント。",
                  i18n: { en: { content: "English hint." } },
                },
                { id: "hint-2", penalty: 0, revealed: true, content: "訳なし。" },
              ],
            },
            // hints を持たない flag はそのまま通す (multi-flag AWS 問題の既定形)。
            { id: "sub-2", label: "ステップ 2", points: 100, solved: false },
          ],
        },
      },
      "en",
    );
    const flags = out.scoring?.flags;
    expect(flags?.[0].hints?.[0].content).toBe("English hint.");
    expect(flags?.[0].hints?.[1].content).toBe("訳なし。"); // 訳が無い hint は canonical のまま
    expect(flags?.[1].hints).toBeUndefined();
  });
});
