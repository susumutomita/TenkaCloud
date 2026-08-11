import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../../src/api/client";
import {
  useEventOperations,
  validateDeployAtInput,
  validateEndsAtInput,
  validateTeardownAtInput,
} from "../../src/hooks/useEventOperations";

/**
 * Event operations hook (#536/#555/#558/#708/#1038…)。 events-client の各 mutation を mock し、
 * bulk deploy/teardown・schedule(now/scheduled/end/endNow)・freeze・scoring lock/unlock・
 * force-archive・end-event の success / error / guard / 入力 validation を pin する。 ApiError は
 * 実物 (instanceof 判定に必要)。
 */
const ops = vi.hoisted(() => ({
  archiveEvent: vi.fn(),
  bulkDeployEvent: vi.fn(),
  bulkTeardownEvent: vi.fn(),
  endEvent: vi.fn(),
  lockEventScoring: vi.fn(),
  setEventSchedule: vi.fn(),
  unlockEventScoring: vi.fn(),
}));
vi.mock("../../src/api/events-client", () => ops);

const CLIENT = {} as ApiClient;
const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

function setup(over: Partial<Parameters<typeof useEventOperations>[0]> = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const { result } = renderHook(() =>
    useEventOperations({
      apiClient: CLIENT,
      canMutateTenant: true,
      detail: null,
      eventId: "evt-1",
      refresh,
      setError,
      t,
      ...over,
    }),
  );
  return { result, refresh, setError };
}

afterEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(ops)) fn.mockReset();
});

describe("validateEndsAtInput", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();
  it("should reject empty / invalid / past / before-start inputs and accept a valid future end", () => {
    expect(validateEndsAtInput("", "", undefined, NOW)).toEqual({ canSubmit: false });
    expect(validateEndsAtInput("2026-13-40", "99:99", undefined, NOW).errorKey).toBe(
      "event_detail.error_endsat_format",
    );
    expect(validateEndsAtInput("2020-01-01", "00:00", undefined, NOW).errorKey).toBe(
      "event_detail.error_endsat_past",
    );
    // value は未来 (= not past) かつ startsAt より前 → before_start。 TZ 非依存にするため
    // value を far-future 早朝、 startsAt を同年末に置く。
    expect(
      validateEndsAtInput("2999-01-01", "10:00", "2999-12-31T23:59:59.000Z", NOW).errorKey,
    ).toBe("event_detail.error_endsat_before_start");
    expect(validateEndsAtInput("2999-01-01", "10:00", undefined, NOW).canSubmit).toBe(true);
  });
});

describe("validateTeardownAtInput (ADR-047)", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();
  it("should reject empty / invalid / past / before-ends and accept a valid future teardown", () => {
    expect(validateTeardownAtInput("", "", undefined, NOW)).toEqual({ canSubmit: false });
    expect(validateTeardownAtInput("2026-13-40", "99:99", undefined, NOW).errorKey).toBe(
      "event_detail.error_teardown_format",
    );
    expect(validateTeardownAtInput("2020-01-01", "00:00", undefined, NOW).errorKey).toBe(
      "event_detail.error_teardown_past",
    );
    // 未来だが endsAt より前 → before_ends。
    expect(
      validateTeardownAtInput("2999-01-01", "10:00", "2999-12-31T23:59:59.000Z", NOW).errorKey,
    ).toBe("event_detail.error_teardown_before_ends");
    // endsAt 不在なら下限制約なし → 通る。
    expect(validateTeardownAtInput("2999-01-01", "10:00", undefined, NOW).canSubmit).toBe(true);
    // endsAt が unparseable なら before-ends チェックを skip → 通る。
    expect(validateTeardownAtInput("2999-01-01", "10:00", "garbage", NOW).canSubmit).toBe(true);
  });
});

describe("validateDeployAtInput (ADR-047 follow-up)", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();
  it("should reject empty / invalid / past / after-ends and accept a valid future deploy", () => {
    expect(validateDeployAtInput("", "", undefined, NOW)).toEqual({ canSubmit: false });
    expect(validateDeployAtInput("2026-13-40", "99:99", undefined, NOW).errorKey).toBe(
      "event_detail.error_deploy_format",
    );
    expect(validateDeployAtInput("2020-01-01", "00:00", undefined, NOW).errorKey).toBe(
      "event_detail.error_deploy_past",
    );
    // 未来だが endsAt より後 → after_ends (deploy は終了より前)。
    expect(
      validateDeployAtInput("2999-12-31", "23:59", "2999-01-01T00:00:00.000Z", NOW).errorKey,
    ).toBe("event_detail.error_deploy_after_ends");
    // endsAt 不在なら上限制約なし → 通る。
    expect(validateDeployAtInput("2999-01-01", "10:00", undefined, NOW).canSubmit).toBe(true);
    // endsAt が unparseable なら after-ends チェックを skip → 通る。
    expect(validateDeployAtInput("2999-01-01", "10:00", "garbage", NOW).canSubmit).toBe(true);
    // 未来かつ endsAt 以前 → 通る。
    expect(
      validateDeployAtInput("2999-01-01", "10:00", "2999-12-31T23:59:59.000Z", NOW).canSubmit,
    ).toBe(true);
  });
});

describe("useEventOperations — bulk deploy / teardown", () => {
  it("should set the in-flight label by body and refresh on bulk deploy success", async () => {
    ops.bulkDeployEvent.mockResolvedValue({ ok: 1 });
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.handleBulkDeploy({ retryFailedOnly: true });
    });
    expect(ops.bulkDeployEvent).toHaveBeenCalledWith(CLIENT, "evt-1", { retryFailedOnly: true });
    expect(result.current.bulkResult).toEqual({ ok: 1 });
    expect(refresh).toHaveBeenCalled();
    // redeploy / default ラベルも通る。
    await act(async () => {
      await result.current.handleBulkDeploy({ forceRedeploy: true });
    });
    await act(async () => {
      await result.current.handleBulkDeploy();
    });
    expect(ops.bulkDeployEvent).toHaveBeenCalledTimes(3);
  });

  it("should surface errors from bulk deploy / teardown", async () => {
    ops.bulkDeployEvent.mockRejectedValue(new Error("deploy boom"));
    ops.bulkTeardownEvent.mockRejectedValue("teardown-str");
    const { result, setError } = setup();
    await act(async () => {
      await result.current.handleBulkDeploy();
    });
    expect(setError).toHaveBeenCalledWith("deploy boom");
    await act(async () => {
      await result.current.handleBulkTeardown();
    });
    expect(setError).toHaveBeenCalledWith("teardown-str");
  });

  it("should teardown and refresh on success", async () => {
    ops.bulkTeardownEvent.mockResolvedValue({ ok: 2 });
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.handleBulkTeardown();
    });
    expect(result.current.bulkResult).toEqual({ ok: 2 });
    expect(refresh).toHaveBeenCalled();
  });
});

describe("useEventOperations — scheduling", () => {
  it("should start now and surface errors", async () => {
    ops.setEventSchedule.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("x"));
    const { result, refresh, setError } = setup();
    await act(async () => {
      await result.current.handleStartNow();
    });
    expect(ops.setEventSchedule).toHaveBeenCalledWith(CLIENT, "evt-1", { startNow: true });
    expect(refresh).toHaveBeenCalled();
    await act(async () => {
      await result.current.handleStartNow();
    });
    expect(setError).toHaveBeenCalledWith("x");
  });

  it("should reject an invalid scheduled-start input before calling the API", async () => {
    const { result, setError } = setup();
    act(() => {
      result.current.setScheduleDate("");
      result.current.setScheduleTime("");
    });
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(ops.setEventSchedule).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalled();
  });

  it("should schedule a future start and clear the modal on success", async () => {
    ops.setEventSchedule.mockResolvedValue(undefined);
    const { result } = setup();
    act(() => {
      result.current.setScheduleDate("2999-01-01");
      result.current.setScheduleTime("10:00");
      result.current.setScheduleModalOpen(true);
    });
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(ops.setEventSchedule).toHaveBeenCalled();
    expect(result.current.scheduleModalOpen).toBe(false);
  });

  it("should validate the end-time input (with and without an errorKey) before scheduling", async () => {
    const { result, setError } = setup();
    // 空入力 → canSubmit:false かつ errorKey 無し → required key。
    await act(async () => {
      await result.current.handleScheduleEnd();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_endsat_required");
    // 不正 ISO (= 範囲外で NaN) → errorKey 付き。
    act(() => {
      result.current.setEndsAtDate("2026-13-40");
      result.current.setEndsAtTime("99:99");
    });
    await act(async () => {
      await result.current.handleScheduleEnd();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_endsat_format");
    expect(ops.setEventSchedule).not.toHaveBeenCalled();
  });

  it("should schedule a valid end time and clear its modal on success", async () => {
    ops.setEventSchedule.mockResolvedValue(undefined);
    const { result } = setup();
    act(() => {
      result.current.setEndsAtDate("2999-01-01");
      result.current.setEndsAtTime("10:00");
      result.current.setEndsAtModalOpen(true);
    });
    await act(async () => {
      await result.current.handleScheduleEnd();
    });
    expect(result.current.endsAtModalOpen).toBe(false);
  });

  it("should end-now schedule and surface its error", async () => {
    ops.setEventSchedule
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("end-now"));
    const { result, setError } = setup();
    await act(async () => {
      await result.current.handleEndNowSchedule();
    });
    expect(ops.setEventSchedule).toHaveBeenCalled();
    await act(async () => {
      await result.current.handleEndNowSchedule();
    });
    expect(setError).toHaveBeenCalledWith("end-now");
  });

  it("should validate the teardown input (required + errorKey) before scheduling (ADR-047)", async () => {
    const { result, setError } = setup();
    // 空入力 → required key。
    await act(async () => {
      await result.current.handleScheduleTeardown();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_teardown_required");
    // 不正 ISO → errorKey 付き。
    act(() => {
      result.current.setTeardownDate("2026-13-40");
      result.current.setTeardownTime("99:99");
    });
    await act(async () => {
      await result.current.handleScheduleTeardown();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_teardown_format");
    expect(ops.setEventSchedule).not.toHaveBeenCalled();
  });

  it("should schedule a valid teardown and clear its modal on success (ADR-047)", async () => {
    ops.setEventSchedule.mockResolvedValue(undefined);
    const { result } = setup();
    act(() => {
      result.current.setTeardownDate("2999-01-01");
      result.current.setTeardownTime("10:00");
      result.current.setTeardownModalOpen(true);
    });
    await act(async () => {
      await result.current.handleScheduleTeardown();
    });
    expect(ops.setEventSchedule).toHaveBeenCalledWith(CLIENT, "evt-1", {
      teardownAt: expect.any(String),
    });
    expect(result.current.teardownModalOpen).toBe(false);
  });

  it("should surface teardown schedule errors (Error + non-Error) (ADR-047)", async () => {
    const { result, setError } = setup();
    act(() => {
      result.current.setTeardownDate("2999-01-01");
      result.current.setTeardownTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce(new Error("teardown-sched boom"));
    await act(async () => {
      await result.current.handleScheduleTeardown();
    });
    expect(setError).toHaveBeenCalledWith("teardown-sched boom");
    act(() => {
      result.current.setTeardownDate("2999-01-01");
      result.current.setTeardownTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce("teardown-sched-str");
    await act(async () => {
      await result.current.handleScheduleTeardown();
    });
    expect(setError).toHaveBeenCalledWith("teardown-sched-str");
  });

  it("should validate the deploy input (required + errorKey) before scheduling (ADR-047 follow-up)", async () => {
    const { result, setError } = setup();
    // 空入力 → required key。
    await act(async () => {
      await result.current.handleScheduleDeploy();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_deploy_required");
    // 不正 ISO → errorKey 付き。
    act(() => {
      result.current.setDeployDate("2026-13-40");
      result.current.setDeployTime("99:99");
    });
    await act(async () => {
      await result.current.handleScheduleDeploy();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_deploy_format");
    expect(ops.setEventSchedule).not.toHaveBeenCalled();
  });

  it("should schedule a valid deploy and clear its modal on success (ADR-047 follow-up)", async () => {
    ops.setEventSchedule.mockResolvedValue(undefined);
    const { result } = setup();
    act(() => {
      result.current.setDeployDate("2999-01-01");
      result.current.setDeployTime("10:00");
      result.current.setDeployScheduleModalOpen(true);
    });
    await act(async () => {
      await result.current.handleScheduleDeploy();
    });
    expect(ops.setEventSchedule).toHaveBeenCalledWith(CLIENT, "evt-1", {
      deployAt: expect.any(String),
    });
    expect(result.current.deployScheduleModalOpen).toBe(false);
  });

  it("should surface deploy schedule errors (Error + non-Error) (ADR-047 follow-up)", async () => {
    const { result, setError } = setup();
    act(() => {
      result.current.setDeployDate("2999-01-01");
      result.current.setDeployTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce(new Error("deploy-sched boom"));
    await act(async () => {
      await result.current.handleScheduleDeploy();
    });
    expect(setError).toHaveBeenCalledWith("deploy-sched boom");
    act(() => {
      result.current.setDeployDate("2999-01-01");
      result.current.setDeployTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce("deploy-sched-str");
    await act(async () => {
      await result.current.handleScheduleDeploy();
    });
    expect(setError).toHaveBeenCalledWith("deploy-sched-str");
  });
});

describe("useEventOperations — freeze minutes", () => {
  it("should reject empty / out-of-range input and accept a valid value", async () => {
    ops.setEventSchedule.mockResolvedValue(undefined);
    const { result, setError } = setup();
    await act(async () => {
      await result.current.handleSaveFreezeMinutes();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_freeze_required");

    act(() => result.current.setFreezeMinutesInput("999"));
    await act(async () => {
      await result.current.handleSaveFreezeMinutes();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_freeze_range");

    act(() => result.current.setFreezeMinutesInput("30"));
    await act(async () => {
      await result.current.handleSaveFreezeMinutes();
    });
    expect(ops.setEventSchedule).toHaveBeenCalledWith(CLIENT, "evt-1", {
      scoreboardFreezeMinutes: 30,
    });
  });

  it("should surface a freeze save error", async () => {
    ops.setEventSchedule.mockRejectedValue(new Error("freeze boom"));
    const { result, setError } = setup();
    act(() => result.current.setFreezeMinutesInput("10"));
    await act(async () => {
      await result.current.handleSaveFreezeMinutes();
    });
    expect(setError).toHaveBeenCalledWith("freeze boom");
  });
});

describe("useEventOperations — scoring lock / unlock", () => {
  it("should lock / unlock and map a 409 conflict to a status-specific message", async () => {
    ops.lockEventScoring.mockResolvedValueOnce(undefined);
    ops.unlockEventScoring.mockResolvedValueOnce(undefined);
    const { result, refresh } = setup();
    await act(async () => {
      await result.current.handleLockScoring();
    });
    await act(async () => {
      await result.current.handleUnlockScoring();
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    ops.lockEventScoring.mockRejectedValueOnce(new ApiError(409, "conflict"));
    ops.unlockEventScoring.mockRejectedValueOnce(new ApiError(409, "conflict"));
    const { result: r2, setError } = setup();
    await act(async () => {
      await r2.current.handleLockScoring();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_lock_status");
    await act(async () => {
      await r2.current.handleUnlockScoring();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_unlock_status");
  });

  it("should fall back to the raw message for non-conflict lock / unlock errors", async () => {
    ops.lockEventScoring.mockRejectedValue(new Error("lock boom"));
    ops.unlockEventScoring.mockRejectedValue(new Error("unlock boom"));
    const { result, setError } = setup();
    await act(async () => {
      await result.current.handleLockScoring();
    });
    expect(setError).toHaveBeenCalledWith("lock boom");
    await act(async () => {
      await result.current.handleUnlockScoring();
    });
    expect(setError).toHaveBeenCalledWith("unlock boom");
  });
});

describe("useEventOperations — force archive / end event", () => {
  it("should force-archive and surface its error", async () => {
    ops.archiveEvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("arch"));
    const { result, refresh, setError } = setup();
    await act(async () => {
      await result.current.handleForceArchive();
    });
    expect(refresh).toHaveBeenCalled();
    await act(async () => {
      await result.current.handleForceArchive();
    });
    expect(setError).toHaveBeenCalledWith("arch");
  });

  it("should map end-event 409 with currentStatus, generic 409, and plain errors", async () => {
    // 409 + currentStatus 抽出可 → status 付きメッセージ。
    ops.endEvent.mockRejectedValueOnce(new ApiError(409, '{"currentStatus":"RUNNING"}'));
    const { result, setError } = setup();
    await act(async () => {
      await result.current.handleEndEvent();
    });
    expect(setError).toHaveBeenCalledWith(
      'event_detail.error_end_status_with_current|{"current":"RUNNING"}',
    );

    // 409 だが currentStatus 抽出不可 → 一般 status メッセージ。
    ops.endEvent.mockRejectedValueOnce(new ApiError(409, "no json here"));
    await act(async () => {
      await result.current.handleEndEvent();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_end_status");

    // 非 ApiError → そのままメッセージ。
    ops.endEvent.mockRejectedValueOnce(new Error("end boom"));
    await act(async () => {
      await result.current.handleEndEvent();
    });
    expect(setError).toHaveBeenCalledWith("end boom");

    // 成功経路。
    ops.endEvent.mockResolvedValueOnce(undefined);
    const { result: r2, refresh } = setup();
    await act(async () => {
      await r2.current.handleEndEvent();
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe("useEventOperations — remaining validation + both error-type sides", () => {
  const NOW = new Date("2026-05-05T10:00:00.000Z").getTime();

  it("validateEndsAtInput: an unparseable startsAt skips the before-start check", () => {
    expect(validateEndsAtInput("2999-01-01", "10:00", "garbage", NOW).canSubmit).toBe(true);
  });

  it("handleScheduledStart: format / past validation + API error / non-Error", async () => {
    const { result, setError } = setup();
    act(() => {
      result.current.setScheduleDate("2026-13-40");
      result.current.setScheduleTime("99:99");
    });
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_date_time_format");

    act(() => {
      result.current.setScheduleDate("2020-01-01");
      result.current.setScheduleTime("00:00");
    });
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(setError).toHaveBeenCalledWith("event_detail.error_startsat_past");

    act(() => {
      result.current.setScheduleDate("2999-01-01");
      result.current.setScheduleTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce(new Error("sched boom"));
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(setError).toHaveBeenCalledWith("sched boom");
    ops.setEventSchedule.mockRejectedValueOnce("sched-str");
    await act(async () => {
      await result.current.handleScheduledStart();
    });
    expect(setError).toHaveBeenCalledWith("sched-str");
  });

  it("handleScheduleEnd: API error after a valid input", async () => {
    const { result, setError } = setup();
    act(() => {
      result.current.setEndsAtDate("2999-01-01");
      result.current.setEndsAtTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce(new Error("end-sched boom"));
    await act(async () => {
      await result.current.handleScheduleEnd();
    });
    expect(setError).toHaveBeenCalledWith("end-sched boom");

    // 非 Error 投げ → String() 側。
    act(() => {
      result.current.setEndsAtDate("2999-01-01");
      result.current.setEndsAtTime("10:00");
    });
    ops.setEventSchedule.mockRejectedValueOnce("end-sched-str");
    await act(async () => {
      await result.current.handleScheduleEnd();
    });
    expect(setError).toHaveBeenCalledWith("end-sched-str");
  });

  it("should cover both Error and non-Error catch sides for every mutation", async () => {
    const { result, setError } = setup();
    act(() => result.current.setFreezeMinutesInput("10"));

    // 各 handler を Error → 文字列 の順に投げ、 catch の `err instanceof Error ? : String()` 両側を踏む。
    ops.bulkDeployEvent.mockRejectedValueOnce("s-deploy");
    ops.bulkTeardownEvent.mockRejectedValueOnce(new Error("e-teardown"));
    ops.setEventSchedule
      .mockRejectedValueOnce("s-startnow")
      .mockRejectedValueOnce("s-endnow")
      .mockRejectedValueOnce("s-freeze");
    ops.lockEventScoring.mockRejectedValueOnce("s-lock");
    ops.unlockEventScoring.mockRejectedValueOnce("s-unlock");
    ops.archiveEvent.mockRejectedValueOnce("s-arch");
    ops.endEvent.mockRejectedValueOnce("s-end");

    const calls: (() => Promise<void>)[] = [
      () => result.current.handleBulkDeploy(),
      () => result.current.handleBulkTeardown(),
      () => result.current.handleStartNow(),
      () => result.current.handleEndNowSchedule(),
      () => result.current.handleSaveFreezeMinutes(),
      () => result.current.handleLockScoring(),
      () => result.current.handleUnlockScoring(),
      () => result.current.handleForceArchive(),
      () => result.current.handleEndEvent(),
    ];
    for (const call of calls) {
      await act(async () => {
        await call();
      });
    }
    for (const msg of [
      "s-deploy",
      "e-teardown",
      "s-startnow",
      "s-endnow",
      "s-freeze",
      "s-lock",
      "s-unlock",
      "s-arch",
      "s-end",
    ]) {
      expect(setError).toHaveBeenCalledWith(msg);
    }
  });
});

describe("useEventOperations — guards", () => {
  it("should no-op every mutation when no API client is present", async () => {
    const { result } = setup({ apiClient: null });
    await act(async () => {
      await result.current.handleBulkDeploy();
      await result.current.handleBulkTeardown();
      await result.current.handleStartNow();
      await result.current.handleScheduledStart();
      await result.current.handleScheduleEnd();
      await result.current.handleScheduleTeardown();
      await result.current.handleScheduleDeploy();
      await result.current.handleEndNowSchedule();
      await result.current.handleSaveFreezeMinutes();
      await result.current.handleLockScoring();
      await result.current.handleUnlockScoring();
      await result.current.handleForceArchive();
      await result.current.handleEndEvent();
    });
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it("should no-op every mutation for a read-only viewer", async () => {
    const { result } = setup({ canMutateTenant: false });
    act(() => {
      result.current.setScheduleDate("2999-01-01");
      result.current.setScheduleTime("10:00");
      result.current.setEndsAtDate("2999-01-01");
      result.current.setEndsAtTime("10:00");
      result.current.setDeployDate("2999-01-01");
      result.current.setDeployTime("10:00");
      result.current.setFreezeMinutesInput("10");
    });
    await act(async () => {
      await result.current.handleBulkDeploy();
      await result.current.handleBulkTeardown();
      await result.current.handleStartNow();
      await result.current.handleScheduledStart();
      await result.current.handleScheduleEnd();
      await result.current.handleScheduleTeardown();
      await result.current.handleScheduleDeploy();
      await result.current.handleEndNowSchedule();
      await result.current.handleSaveFreezeMinutes();
      await result.current.handleLockScoring();
      await result.current.handleUnlockScoring();
      await result.current.handleForceArchive();
      await result.current.handleEndEvent();
    });
    for (const fn of Object.values(ops)) expect(fn).not.toHaveBeenCalled();
  });

  it("should debounce concurrent calls that share an in-flight flag", async () => {
    let release: () => void = () => {};
    ops.bulkDeployEvent.mockReturnValue(
      new Promise<{ ok: number }>((resolve) => {
        release = () => resolve({ ok: 1 });
      }),
    );
    const { result } = setup();
    act(() => {
      void result.current.handleBulkDeploy(); // bulkInFlight="deploy" のまま pending
    });
    // 同じ bulkInFlight を見る teardown は guard で弾かれる。
    await act(async () => {
      await result.current.handleBulkTeardown();
    });
    expect(ops.bulkTeardownEvent).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });
  });
});
