import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUptimeMultiKind } from "../../lib/problem-deploy/handlers/generic-scoring-handler/kinds/uptime-multi";
import type {
  KindHandlerInput,
  PhaseEntry,
} from "../../lib/problem-deploy/handlers/generic-scoring-handler/shared";
import type { UptimeMultiScoringMetadata } from "../../lib/utils/scoring-metadata";

/**
 * `uptime-multi` kind (= N slot AND probe で全 ok のとき pointsAllOk 加点、 1 fail で
 * failurePenalty 適用)。security-battle-royale 想定。
 */

const NOW_ISO = "2026-05-12T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function buildInput(
  overrides: Partial<KindHandlerInput<UptimeMultiScoringMetadata>> = {},
): KindHandlerInput<UptimeMultiScoringMetadata> {
  return {
    deployment: {
      PK: "DEPLOYMENT#JOB1",
      jobId: "JOB1",
      problemId: "security-battle-royale",
      tenantId: "tenant-acme",
      teamId: "team-1",
      eventId: "event-1",
      stackOutputs: JSON.stringify({
        FrontendUrl: "https://frontend.example.com",
        ApiUrl: "https://api.example.com",
      }),
      expiresAt: 9_999_999_999,
    },
    scoring: {
      kind: "uptime-multi",
      probedSlots: [
        { slot: "frontend", path: "/", expectStatus: [200] },
        { slot: "api", path: "/healthz", expectStatus: [200] },
      ],
      pointsAllOk: 100,
      failurePenalty: -50,
    },
    slots: [
      { slot: "frontend", default: { from: "cfn-output", key: "FrontendUrl" }, overridable: true },
      { slot: "api", default: { from: "cfn-output", key: "ApiUrl" }, overridable: true },
    ],
    overrides: [],
    phases: [] as readonly PhaseEntry[],
    nowMs: NOW_MS,
    nowIso: NOW_ISO,
    prevState: {},
    ...overrides,
  };
}

describe("uptime-multi kind", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should award pointsAllOk when all slots return 200", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.scoreEvents).toEqual([{ source: "uptime", points: 100, occurredAt: NOW_ISO }]);
    expect(result.lastResult).toBe("ok");
  });

  it("should add failurePenalty when 1 slot fails (negative value = deduction)", async () => {
    fetchMock
      .mockResolvedValueOnce({ status: 200, text: async () => "" })
      .mockResolvedValueOnce({ status: 500, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(-50);
    expect(result.lastResult).toBe("fail");
  });

  it("should default failurePenalty to 0 and not award anything when omitted", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [
          { slot: "frontend", path: "/", expectStatus: [200] },
          { slot: "api", path: "/healthz", expectStatus: [200] },
        ],
        pointsAllOk: 100,
      },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.lastResult).toBe("fail");
  });

  it("should noop when no slot can be resolved (deploy not yet complete / stack output absent)", async () => {
    const input = buildInput({
      deployment: { ...buildInput().deployment, stackOutputs: JSON.stringify({}) },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(0);
    expect(result.scoreEvents).toEqual([]);
  });

  it("should probe the override URL for slots with an override", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      overrides: [{ slot: "frontend", overrideUrl: "https://override.example.com/" }],
    });
    await runUptimeMultiKind(input);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://override.example.com/");
  });

  it("should emit attack-detected on ok→fail transition (compat)", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [{ slot: "frontend", path: "/", expectStatus: [200] }],
        pointsAllOk: 100,
      },
      deployment: { ...buildInput().deployment, lastResult: "ok" },
    });
    const result = await runUptimeMultiKind(input);
    expect(result.attackDetected).toBe(true);
    expect(result.scoreEvents).toContainEqual({
      source: "attack-detected",
      points: 0,
      occurredAt: NOW_ISO,
    });
  });

  it("should build the slot default URL including appendPath and probe it", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const input = buildInput({
      scoring: {
        kind: "uptime-multi",
        probedSlots: [{ slot: "users", path: "/score", expectStatus: [200] }],
        pointsAllOk: 100,
      },
      slots: [
        {
          slot: "users",
          default: { from: "cfn-output", key: "BaseUrl", appendPath: "/users" },
          overridable: true,
        },
      ],
      deployment: {
        ...buildInput().deployment,
        stackOutputs: JSON.stringify({ BaseUrl: "https://api.example.com/" }),
      },
    });
    await runUptimeMultiKind(input);
    // joinUrl は appendPath (/users) と probe path (/score) を path-style concat する。
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/users/score");
  });

  // [#1666] optional attack-blocked bonus: アプリの counter endpoint を live probe して防御加点。
  function withAttackBonus(
    prevAttackCount: number | undefined,
  ): KindHandlerInput<UptimeMultiScoringMetadata> {
    const base = buildInput();
    return {
      ...base,
      scoring: {
        kind: "uptime-multi",
        probedSlots: base.scoring.probedSlots,
        pointsAllOk: 100,
        attackBlocked: { slot: "api", path: "/attack-stats", pointsPerBlock: 25 },
      },
      prevState: prevAttackCount === undefined ? {} : { attackCount: prevAttackCount },
    };
  }

  /** slot probe は 200/空、 counter endpoint (/attack-stats) は body にブロック回数を返す fetch mock。 */
  function mockProbesWithCounter(blockedCount: string): void {
    fetchMock.mockImplementation(async (url: string) => ({
      status: 200,
      url,
      text: async () => (url.includes("/attack-stats") ? blockedCount : ""),
    }));
  }

  it("should add an attack-blocked bonus on counter increment (defense held)", async () => {
    mockProbesWithCounter("5");
    const result = await runUptimeMultiKind(withAttackBonus(2)); // delta 3 × 25 = 75
    expect(result.scoreDelta).toBe(175); // pointsAllOk 100 + bonus 75
    expect(result.newState).toEqual({ attackCount: 5 });
    expect(result.scoreEvents).toEqual([
      { source: "uptime", points: 100, occurredAt: NOW_ISO },
      { source: "uptime", points: 75, occurredAt: NOW_ISO },
    ]);
  });

  it("should only record the baseline on the first tick (no bonus yet)", async () => {
    mockProbesWithCounter("5");
    const result = await runUptimeMultiKind(withAttackBonus(undefined));
    expect(result.scoreDelta).toBe(100); // availability only; bonus 0 on baseline
    expect(result.newState).toEqual({ attackCount: 5 });
  });

  it("should award no bonus when the counter endpoint is unreachable", async () => {
    // slot probes ok, but the counter endpoint 500s → no bonus, no state.
    fetchMock.mockImplementation(async (url: string) => ({
      status: url.includes("/attack-stats") ? 500 : 200,
      url,
      text: async () => "",
    }));
    const result = await runUptimeMultiKind(withAttackBonus(2));
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });

  it("should not set newState or a bonus when attackBlocked is absent (backward compat)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });

  // [#1666] attack-probes: scorer が攻撃 payload を送り、 防御が破れていれば減点 (= SQLi 防御テスト)。
  function withAttackProbe(): KindHandlerInput<UptimeMultiScoringMetadata> {
    const base = buildInput();
    return {
      ...base,
      scoring: {
        kind: "uptime-multi",
        probedSlots: base.scoring.probedSlots,
        pointsAllOk: 100,
        attackProbes: [
          {
            slot: "api",
            path: "/api/v1/auth",
            method: "POST",
            body: JSON.stringify({ username: "' OR '1'='1", password: "x" }),
            vulnerableStatus: [200], // 認証 bypass で 200 = 脆弱
            penalty: 60,
          },
        ],
      },
    };
  }

  it("should penalize when the SQLi attack-probe bypasses auth (defense failed)", async () => {
    // slot probes ok (200) AND the attack POST returns 200 (bypassed) → vulnerable → -60.
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(withAttackProbe());
    expect(result.scoreDelta).toBe(40); // 100 availability − 60 vulnerability
    expect(result.attackDetected).toBe(true);
    expect(result.scoreEvents).toContainEqual({
      source: "attack-detected",
      points: -60,
      occurredAt: NOW_ISO,
    });
    // the attack probe was a POST carrying the injection payload.
    const authCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/api/v1/auth"),
    );
    expect((authCall?.[1] as { method?: string })?.method).toBe("POST");
  });

  it("should use an injected provider command for attack probes while health stays on HTTP", async () => {
    fetchMock.mockResolvedValue({ status: StatusCodes.OK, text: async () => "" });
    const attackProbe = vi.fn(async () => ({
      ok: false,
      status: StatusCodes.FORBIDDEN,
      responseTimeMs: 1,
    }));

    const result = await runUptimeMultiKind({ ...withAttackProbe(), attackProbe });

    expect(result.scoreDelta).toBe(100);
    expect(attackProbe).toHaveBeenCalledWith({
      slot: "api",
      path: "/api/v1/auth",
      method: "POST",
      body: JSON.stringify({ username: "' OR '1'='1", password: "x" }),
    });
    expect(
      fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).includes("/api/v1/auth")),
    ).toBe(false);
  });

  it("should NOT penalize when the SQLi attack is rejected (defense held)", async () => {
    // slot probes ok, but the attack POST returns 403 (rejected) → defended → no penalty.
    fetchMock.mockImplementation(async (url: string) => ({
      status: url.includes("/api/v1/auth") ? 403 : 200,
      url,
      text: async () => "",
    }));
    const result = await runUptimeMultiKind(withAttackProbe());
    expect(result.scoreDelta).toBe(100); // full availability, no vulnerability penalty
    expect(result.attackDetected).toBeUndefined();
  });

  it("should not penalize when the attack-probe endpoint is unreachable", async () => {
    // can't conclude vulnerability from an unreachable app (availability is probedSlots' job).
    fetchMock.mockImplementation(async (url: string) => {
      if ((url as string).includes("/api/v1/auth")) throw new TypeError("network");
      return { status: 200, url, text: async () => "" };
    });
    const result = await runUptimeMultiKind(withAttackProbe());
    expect(result.scoreDelta).toBe(100);
  });

  it("should award no bonus when the attackBlocked slot cannot be resolved", async () => {
    // counter slot が outputs にも overrides にも無い → probe 自体を打たず bonus 0 / state なし。
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withAttackBonus(2);
    const input = {
      ...base,
      scoring: {
        ...base.scoring,
        attackBlocked: { slot: "missing", path: "/attack-stats", pointsPerBlock: 25 },
      },
    };
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
    expect(
      fetchMock.mock.calls.every((c: unknown[]) => !String(c[0]).includes("/attack-stats")),
    ).toBe(true);
  });

  it("should award no bonus when the counter body is not a number", async () => {
    // 競技者 stack が壊れた body を返したら baseline を汚さず加点もしない。
    mockProbesWithCounter("not-a-number");
    const result = await runUptimeMultiKind(withAttackBonus(2));
    expect(result.scoreDelta).toBe(100);
    expect(result.newState).toBeUndefined();
  });

  it("should not penalize when the attack-probe slot cannot be resolved", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withAttackProbe();
    const input = {
      ...base,
      scoring: {
        ...base.scoring,
        attackProbes: [
          { slot: "missing", path: "/api/v1/auth", vulnerableStatus: [200], penalty: 60 },
        ],
      },
    };
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(100);
    expect(result.attackDetected).toBeUndefined();
  });

  it("should send a default GET attack-probe when method and body are omitted", async () => {
    // method/body 省略時は素の GET probe になる (= fetch options に method/body を渡さない)。
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withAttackProbe();
    const input = {
      ...base,
      scoring: {
        ...base.scoring,
        attackProbes: [
          { slot: "api", path: "/api/v1/debug", vulnerableStatus: [200], penalty: 30 },
        ],
      },
    };
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(70); // 100 availability − 30 (debug endpoint exposed = 200)
    const debugCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/api/v1/debug"),
    );
    const options = debugCall?.[1] as { method?: string; body?: string } | undefined;
    expect(options?.method).toBe("GET"); // probeUrl の既定 method にフォールバック
    expect(options?.body).toBeUndefined();
  });

  it("should not penalize when attackProbes is an empty array", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withAttackProbe();
    const input = { ...base, scoring: { ...base.scoring, attackProbes: [] } };
    const result = await runUptimeMultiKind(input);
    expect(result.scoreDelta).toBe(100);
    expect(result.attackDetected).toBeUndefined();
  });

  // [#2422] per-cycle attack-probe snapshot for the participant portal (fired / landed / blocked).
  function withLabeledAttackProbe(): KindHandlerInput<UptimeMultiScoringMetadata> {
    const base = withAttackProbe();
    return {
      ...base,
      scoring: {
        ...base.scoring,
        attackProbes: [
          {
            slot: "api",
            path: "/api/v1/auth",
            method: "POST",
            body: JSON.stringify({ username: "' OR '1'='1", password: "x" }),
            vulnerableStatus: [200],
            penalty: 60,
            label: "Auth bypass probe",
            symptom: "still accepts a crafted login",
          },
        ],
      },
    };
  }

  it("should emit an attackProbesJson snapshot marking a landed probe (defense failed)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(withLabeledAttackProbe());
    expect(result.scoreDelta).toBe(40); // 100 − 60 landed
    const snapshot = JSON.parse(result.attackProbesJson ?? "{}");
    expect(snapshot.checkedAt).toBe(NOW_ISO);
    expect(snapshot.probes).toEqual([
      {
        outcome: "landed",
        penalty: 60,
        label: "Auth bypass probe",
        symptom: "still accepts a crafted login",
      },
    ]);
  });

  it("should mark a defended probe as blocked with no penalty in the snapshot", async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      status: url.includes("/api/v1/auth") ? 403 : 200,
      url,
      text: async () => "",
    }));
    const result = await runUptimeMultiKind(withLabeledAttackProbe());
    expect(result.scoreDelta).toBe(100);
    const snapshot = JSON.parse(result.attackProbesJson ?? "{}");
    expect(snapshot.probes[0].outcome).toBe("blocked");
    expect(result.attackDetected).toBeUndefined();
  });

  it("should mark an unreachable probe as skipped (availability judged separately)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if ((url as string).includes("/api/v1/auth")) throw new TypeError("network");
      return { status: 200, url, text: async () => "" };
    });
    const result = await runUptimeMultiKind(withLabeledAttackProbe());
    expect(result.scoreDelta).toBe(100);
    const snapshot = JSON.parse(result.attackProbesJson ?? "{}");
    expect(snapshot.probes[0].outcome).toBe("skipped");
  });

  it("should mark a probe whose slot cannot be resolved as skipped", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withLabeledAttackProbe();
    const input = {
      ...base,
      scoring: {
        ...base.scoring,
        attackProbes: [
          { slot: "missing", path: "/x", vulnerableStatus: [200], penalty: 30, label: "Ghost" },
        ],
      },
    };
    const snapshot = JSON.parse((await runUptimeMultiKind(input)).attackProbesJson ?? "{}");
    expect(snapshot.probes).toEqual([{ outcome: "skipped", penalty: 30, label: "Ghost" }]);
  });

  it("should omit label/symptom from the snapshot when the probe declares none", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(withAttackProbe()); // no label/symptom
    const snapshot = JSON.parse(result.attackProbesJson ?? "{}");
    expect(snapshot.probes[0]).toEqual({ outcome: "landed", penalty: 60 });
  });

  it("should never leak the probe slot/path into the snapshot (non-spoiler guard)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(withLabeledAttackProbe());
    expect(result.attackProbesJson).not.toContain("/api/v1/auth");
    expect(result.attackProbesJson).not.toContain("api"); // slot name excluded too
  });

  it("should not emit attackProbesJson when attackProbes is absent (backward compat)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const result = await runUptimeMultiKind(buildInput());
    expect(result.attackProbesJson).toBeUndefined();
  });

  it("should not emit attackProbesJson when attackProbes is an empty array", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => "" });
    const base = withAttackProbe();
    const input = { ...base, scoring: { ...base.scoring, attackProbes: [] } };
    const result = await runUptimeMultiKind(input);
    expect(result.attackProbesJson).toBeUndefined();
  });
});
