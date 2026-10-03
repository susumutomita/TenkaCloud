import { describe, expect, it } from "vitest";
import {
  BattleAttacksQuerySchema,
  CastEventBodySchema,
  DeployLogsQuerySchema,
  EventInboxQuerySchema,
  NotificationsQuerySchema,
  PatchMeBodySchema,
  ProblemHintParamSchema,
  ProblemIdParamSchema,
  ProblemSlotParamSchema,
  SsoQuerySchema,
  SubmitFlagBodySchema,
  UpsertEndpointBodySchema,
} from "../../lib/problem-deploy/handlers/participant-handler/schemas";

/**
 * Issue #1242: participant-handler route 境界 schema の挙動を pin する。
 *
 * 各 schema で:
 *   - happy path: 正常な input を accept する
 *   - missing required: 必須 field 欠落を reject する
 *   - wrong type: 型違いを reject する
 */

const VALID_JOB_ID = "01H8XGJWBWBAQ4N6RZHM4S2KMV";
const VALID_PROBLEM_ID = "ddos-uptime";
const VALID_SLOT = "frontend";
const VALID_HINT_ID = "hint-1";

describe("PatchMeBodySchema", () => {
  it("should accept { teamName: string }", () => {
    expect(PatchMeBodySchema.safeParse({ teamName: "Alpha" }).success).toBe(true);
  });

  it("should reject missing teamName", () => {
    expect(PatchMeBodySchema.safeParse({}).success).toBe(false);
  });

  it("should reject wrong-type teamName (number)", () => {
    expect(PatchMeBodySchema.safeParse({ teamName: 42 }).success).toBe(false);
  });
});

describe("SubmitFlagBodySchema", () => {
  it("should accept { problemId, flag } with valid problemId regex + flag length", () => {
    const r = SubmitFlagBodySchema.safeParse({ problemId: VALID_PROBLEM_ID, flag: "FLAG{xyz}" });
    expect(r.success).toBe(true);
  });

  it("should reject missing flag", () => {
    expect(SubmitFlagBodySchema.safeParse({ problemId: VALID_PROBLEM_ID }).success).toBe(false);
  });

  it("should reject flag longer than 200 chars", () => {
    const r = SubmitFlagBodySchema.safeParse({
      problemId: VALID_PROBLEM_ID,
      flag: "x".repeat(201),
    });
    expect(r.success).toBe(false);
  });

  it("should reject empty flag", () => {
    expect(SubmitFlagBodySchema.safeParse({ problemId: VALID_PROBLEM_ID, flag: "" }).success).toBe(
      false,
    );
  });

  it("should reject malformed problemId (uppercase)", () => {
    expect(SubmitFlagBodySchema.safeParse({ problemId: "BadProblem", flag: "x" }).success).toBe(
      false,
    );
  });

  it("should reject wrong-type problemId (number)", () => {
    expect(SubmitFlagBodySchema.safeParse({ problemId: 1, flag: "x" }).success).toBe(false);
  });
});

describe("CastEventBodySchema", () => {
  it("should accept { targetJobId, kind, payload: object }", () => {
    const r = CastEventBodySchema.safeParse({
      targetJobId: VALID_JOB_ID,
      kind: "attack-launch",
      payload: { damage: 10 },
    });
    expect(r.success).toBe(true);
  });

  it("should accept payload null / omitted", () => {
    expect(
      CastEventBodySchema.safeParse({ targetJobId: VALID_JOB_ID, kind: "attack", payload: null })
        .success,
    ).toBe(true);
    expect(
      CastEventBodySchema.safeParse({ targetJobId: VALID_JOB_ID, kind: "attack" }).success,
    ).toBe(true);
  });

  it("should reject missing targetJobId", () => {
    expect(CastEventBodySchema.safeParse({ kind: "attack", payload: {} }).success).toBe(false);
  });

  it("should reject non-ULID targetJobId", () => {
    expect(
      CastEventBodySchema.safeParse({
        targetJobId: "not-ulid",
        kind: "attack",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("should reject UPPERCASE kind (route-level kebab regex)", () => {
    expect(
      CastEventBodySchema.safeParse({
        targetJobId: VALID_JOB_ID,
        kind: "Attack-Launch",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("should reject primitive payload (string)", () => {
    expect(
      CastEventBodySchema.safeParse({
        targetJobId: VALID_JOB_ID,
        kind: "attack",
        payload: "string",
      }).success,
    ).toBe(false);
  });
});

describe("UpsertEndpointBodySchema", () => {
  it("should accept { url: string }", () => {
    expect(UpsertEndpointBodySchema.safeParse({ url: "https://team-a.example" }).success).toBe(
      true,
    );
  });

  it("should reject missing url", () => {
    expect(UpsertEndpointBodySchema.safeParse({}).success).toBe(false);
  });

  it("should reject wrong-type url (number)", () => {
    expect(UpsertEndpointBodySchema.safeParse({ url: 42 }).success).toBe(false);
  });
});

describe("SsoQuerySchema", () => {
  it("should accept ?jobId=<ULID>", () => {
    expect(SsoQuerySchema.safeParse({ jobId: VALID_JOB_ID }).success).toBe(true);
  });

  it("should reject missing jobId", () => {
    expect(SsoQuerySchema.safeParse({}).success).toBe(false);
  });

  it("should reject non-ULID jobId", () => {
    expect(SsoQuerySchema.safeParse({ jobId: "abc" }).success).toBe(false);
  });
});

describe("NotificationsQuerySchema", () => {
  it("should accept ?limit=<digits> and coerce to number", () => {
    const r = NotificationsQuerySchema.safeParse({ limit: "50" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(50);
  });

  it("should accept omitted limit", () => {
    const r = NotificationsQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBeUndefined();
  });

  it("should reject non-numeric limit", () => {
    expect(NotificationsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });
});

describe("EventInboxQuerySchema", () => {
  it("should accept ?jobId=<ULID>&sinceMs=<digits>", () => {
    const r = EventInboxQuerySchema.safeParse({ jobId: VALID_JOB_ID, sinceMs: "1700000000000" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sinceMs).toBe(1_700_000_000_000);
  });

  it("should reject missing jobId", () => {
    expect(EventInboxQuerySchema.safeParse({ sinceMs: "0" }).success).toBe(false);
  });

  it("should reject non-numeric sinceMs", () => {
    expect(EventInboxQuerySchema.safeParse({ jobId: VALID_JOB_ID, sinceMs: "abc" }).success).toBe(
      false,
    );
  });
});

describe("BattleAttacksQuerySchema", () => {
  it("should accept ?jobId=<ULID>&sinceMin=<digits>", () => {
    const r = BattleAttacksQuerySchema.safeParse({ jobId: VALID_JOB_ID, sinceMin: "30" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sinceMin).toBe(30);
  });

  it("should reject missing jobId", () => {
    expect(BattleAttacksQuerySchema.safeParse({ sinceMin: "30" }).success).toBe(false);
  });

  it("should reject non-numeric sinceMin", () => {
    expect(
      BattleAttacksQuerySchema.safeParse({ jobId: VALID_JOB_ID, sinceMin: "abc" }).success,
    ).toBe(false);
  });
});

describe("DeployLogsQuerySchema", () => {
  it("should accept ?jobId=<ULID>&limit=<str>&nextToken=<str>", () => {
    expect(
      DeployLogsQuerySchema.safeParse({
        jobId: VALID_JOB_ID,
        limit: "10",
        nextToken: "tok",
      }).success,
    ).toBe(true);
  });

  it("should accept ?jobId only (limit + nextToken optional)", () => {
    expect(DeployLogsQuerySchema.safeParse({ jobId: VALID_JOB_ID }).success).toBe(true);
  });

  it("should reject missing jobId", () => {
    expect(DeployLogsQuerySchema.safeParse({ limit: "10" }).success).toBe(false);
  });

  it("should reject non-ULID jobId", () => {
    expect(DeployLogsQuerySchema.safeParse({ jobId: "bad" }).success).toBe(false);
  });
});

describe("ProblemIdParamSchema", () => {
  it("should accept valid problemId", () => {
    expect(ProblemIdParamSchema.safeParse({ problemId: VALID_PROBLEM_ID }).success).toBe(true);
  });

  it("should reject missing problemId", () => {
    expect(ProblemIdParamSchema.safeParse({}).success).toBe(false);
  });

  it("should reject UPPERCASE problemId", () => {
    expect(ProblemIdParamSchema.safeParse({ problemId: "BAD" }).success).toBe(false);
  });
});

describe("ProblemSlotParamSchema", () => {
  it("should accept { problemId, slot }", () => {
    expect(
      ProblemSlotParamSchema.safeParse({ problemId: VALID_PROBLEM_ID, slot: VALID_SLOT }).success,
    ).toBe(true);
  });

  it("should reject missing slot", () => {
    expect(ProblemSlotParamSchema.safeParse({ problemId: VALID_PROBLEM_ID }).success).toBe(false);
  });

  it("should reject UPPERCASE slot", () => {
    expect(
      ProblemSlotParamSchema.safeParse({ problemId: VALID_PROBLEM_ID, slot: "Frontend" }).success,
    ).toBe(false);
  });
});

describe("ProblemHintParamSchema", () => {
  it("should accept { problemId, hintId }", () => {
    expect(
      ProblemHintParamSchema.safeParse({ problemId: VALID_PROBLEM_ID, hintId: VALID_HINT_ID })
        .success,
    ).toBe(true);
  });

  it("should reject missing hintId", () => {
    expect(ProblemHintParamSchema.safeParse({ problemId: VALID_PROBLEM_ID }).success).toBe(false);
  });

  it("should reject hintId longer than 64 chars", () => {
    expect(
      ProblemHintParamSchema.safeParse({
        problemId: VALID_PROBLEM_ID,
        hintId: "x".repeat(65),
      }).success,
    ).toBe(false);
  });

  it("should reject wrong-type hintId (number)", () => {
    expect(
      ProblemHintParamSchema.safeParse({ problemId: VALID_PROBLEM_ID, hintId: 1 }).success,
    ).toBe(false);
  });
});
