import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../../../src/api/client";
import type { EventDetail, ProgressionGateConfig } from "../../../src/api/events-client";
import { EventProgressionGatePanel } from "../../../src/components/event-detail/EventProgressionGatePanel";

/**
 * Issue #2283: Progression / Gate (Advanced) panel。
 *
 * - 有効判定は per-tenant runtime flag (`GET /feature-flags`) のみ — flag OFF なら editor を
 *   出さず、 無効 Alert + read-only 表示 + 有効化 Toggle (PUT /admin/feature-flags) を出す
 * - flag ON なら detail.progressionGate を prefill した editor を出し、 保存は full-replace PUT
 * - backend の 400 invalid_progression_gate reason / 409 feature_disabled を文言化する
 */

const { getFlags, putFlags, putGate, deleteGate } = vi.hoisted(() => ({
  getFlags: vi.fn(),
  putFlags: vi.fn(),
  putGate: vi.fn(),
  deleteGate: vi.fn(),
}));

vi.mock("../../../src/api/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/events-client")>();
  return {
    ...actual,
    getTenantFeatureFlags: getFlags,
    putTenantFeatureFlags: putFlags,
    putEventProgressionGate: putGate,
    deleteEventProgressionGate: deleteGate,
  };
});

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const fakeApi = {} as ApiClient;

const storedGate: ProgressionGateConfig = {
  gateProblemId: "p-gate",
  unlockTargetIds: ["p-a"],
  defaultPolicy: "off",
  teamOverrides: { t2: { policy: "required", completionBonus: 500 } },
};

const detail = (over: Partial<EventDetail> = {}): EventDetail =>
  ({
    eventId: "EVT1",
    status: "READY",
    teams: [
      { teamId: "t1", internalSlug: "team-a", displayName: "Alpha" },
      { teamId: "t2", internalSlug: "team-b" },
    ],
    problems: [
      { problemId: "p-gate", defaultRegion: "ap-northeast-1" },
      { problemId: "p-a", defaultRegion: "ap-northeast-1" },
      { problemId: "p-b", defaultRegion: "ap-northeast-1" },
    ],
    deploymentsByProblem: {},
    ...over,
  }) as unknown as EventDetail;

const renderPanel = (
  args: {
    apiClient?: ApiClient | null;
    canMutateTenant?: boolean;
    detail?: EventDetail;
    onRefresh?: () => void;
  } = {},
) =>
  render(
    <EventProgressionGatePanel
      apiClient={args.apiClient === undefined ? fakeApi : args.apiClient}
      canMutateTenant={args.canMutateTenant ?? true}
      detail={args.detail ?? detail()}
      onRefresh={args.onRefresh ?? vi.fn()}
      t={t}
    />,
  );

const wrapper = () => createWrapper(document.body);
const toggle = () => wrapper().findToggle();
const saveButton = () => screen.queryByText("gate.save_button");

beforeEach(() => {
  getFlags.mockReset().mockResolvedValue({});
  putFlags.mockReset().mockResolvedValue({ challengePrerequisiteGate: true });
  putGate.mockReset().mockResolvedValue({ progressionGate: storedGate });
  deleteGate.mockReset().mockResolvedValue({ removed: true });
});
afterEach(() => vi.clearAllMocks());

describe("EventProgressionGatePanel", () => {
  it("should not fetch tenant flags when there is no api client", () => {
    renderPanel({ apiClient: null });
    expect(getFlags).not.toHaveBeenCalled();
    expect(screen.getByText("gate.loading")).toBeInTheDocument();
  });

  it("should show the disabled alert and no editor when the tenant flag is OFF", async () => {
    renderPanel();
    expect(await screen.findByText("gate.disabled_alert_header")).toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
    expect(getFlags).toHaveBeenCalledWith(fakeApi);
  });

  it("should show a read-only summary of the stored config when the flag is OFF", async () => {
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    expect(await screen.findByText("gate.stored_readonly_header")).toBeInTheDocument();
    expect(screen.getByText("p-gate")).toBeInTheDocument();
    expect(screen.getByText('gate.stored_overrides_count:{"count":1}')).toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
  });

  it("should PUT the merged tenant flags when enabling the feature via the toggle", async () => {
    getFlags.mockResolvedValue({ redTeam: true });
    putFlags.mockResolvedValue({ redTeam: true, challengePrerequisiteGate: true });
    renderPanel();
    await screen.findByText("gate.disabled_alert_header");
    toggle()?.findNativeInput().click();
    await waitFor(() =>
      expect(putFlags).toHaveBeenCalledWith(fakeApi, {
        redTeam: true,
        challengePrerequisiteGate: true,
      }),
    );
    // 有効化に成功すると editor が現れる。
    expect(await screen.findByText("gate.save_button")).toBeInTheDocument();
  });

  it("should re-fetch the current flags right before the toggle PUT and merge onto them", async () => {
    // #2283: PUT は full-replace。 mount 時 snapshot ({}) ではなく、 toggle 直前に再取得した
    // 最新 map (他 admin が ON にした redTeam 入り) へ merge して送ることを pin する。
    getFlags.mockResolvedValueOnce({}).mockResolvedValueOnce({ redTeam: true });
    putFlags.mockResolvedValue({ redTeam: true, challengePrerequisiteGate: true });
    renderPanel();
    await screen.findByText("gate.disabled_alert_header");
    toggle()?.findNativeInput().click();
    await waitFor(() =>
      expect(putFlags).toHaveBeenCalledWith(fakeApi, {
        redTeam: true,
        challengePrerequisiteGate: true,
      }),
    );
    // mount 時 1 回 + PUT 直前 1 回 = 2 回。
    expect(getFlags).toHaveBeenCalledTimes(2);
  });

  it("should PUT the merged flags with the gate OFF when disabling (mirror flow)", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    putFlags.mockResolvedValue({ challengePrerequisiteGate: false });
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    toggle()?.findNativeInput().click();
    await waitFor(() =>
      expect(putFlags).toHaveBeenCalledWith(fakeApi, { challengePrerequisiteGate: false }),
    );
    expect(await screen.findByText("gate.disabled_alert_header")).toBeInTheDocument();
  });

  it("should show the TenantAdmin-required error when the flag PUT is forbidden", async () => {
    putFlags.mockRejectedValue(new ApiError(StatusCodes.FORBIDDEN, "forbidden"));
    renderPanel();
    await screen.findByText("gate.disabled_alert_header");
    toggle()?.findNativeInput().click();
    expect(await screen.findByText("gate.error_toggle_forbidden")).toBeInTheDocument();
    // flag は変わらない (= 無効 Alert のまま)。
    expect(screen.getByText("gate.disabled_alert_header")).toBeInTheDocument();
  });

  it("should remount the editor with fresh values when the stored config changes", async () => {
    // #2283: Remove + refresh / 他 session の保存が refresh で届いたとき、 form が
    // mount 時の stale 値を保持し続けない (= key remount) ことを pin する。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container, rerender } = renderPanel({
      detail: detail({ progressionGate: storedGate }),
    });
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    expect(cw.findSelect()?.findTrigger().getElement().textContent).toContain("p-gate");
    // refresh が「設定なし」の detail を届けた想定 → form は空にリセットされる。
    rerender(
      <EventProgressionGatePanel
        apiClient={fakeApi}
        canMutateTenant
        detail={detail()}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    await waitFor(() =>
      expect(cw.findSelect()?.findTrigger().getElement().textContent).toContain(
        "gate.gate_problem_placeholder",
      ),
    );
    expect(screen.getByText("gate.error_gate_required")).toBeInTheDocument();
  });

  /**
   * [Issue #3174] What a stored config now looks like when it uses the two
   * things that did not exist before: an event-wide bonus, and a team override
   * that carries only a bonus while still following the event's policy.
   */
  it("should prefill the event bonus and a policy-less team override", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel({
      detail: detail({
        progressionGate: {
          gateProblemId: "p-gate",
          unlockTargetIds: ["p-a"],
          defaultPolicy: "required",
          completionBonus: 300,
          teamOverrides: { t1: { completionBonus: 750 } },
        },
      }),
    });
    await screen.findByText("gate.save_button");
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(bonusInputs[0]?.value).toBe("300");
    expect(bonusInputs[1]?.value).toBe("750");
    // The row carries a bonus and no policy, so its select still reads inherit.
    const selects = createWrapper(container).findAllSelects();
    expect(selects[1]?.findTrigger().getElement().textContent).toContain("gate.policy_inherit");
  });

  it("should refuse to save an out-of-range event bonus", async () => {
    // The event field is validated on the same rule as a team's, and the save
    // button mirrors it — an operator cannot push a typo'd handicap through.
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(bonusInputs[0] as HTMLInputElement, { target: { value: "999999999" } });
    expect(screen.getByText("gate.error_bonus_range")).toBeInTheDocument();
    expect(saveButton()?.closest("button")).toBeDisabled();
    expect(createWrapper(container).findAllSelects().length).toBeGreaterThan(0);
  });

  it("should render the editor prefilled from detail.progressionGate when the flag is ON", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    // gate select の trigger に保存済み gateProblemId が出る。
    expect(cw.findSelect()?.findTrigger().getElement().textContent).toContain("p-gate");
    // unlock target token が prefill される。
    expect(cw.findMultiselect()?.findTokens()).toHaveLength(1);
    // default policy radio は "off" が選択済み。
    expect(cw.findRadioGroup()?.findInputByValue("off")?.getElement().checked).toBe(true);
    // t2 の override select は required、 bonus input は 500。
    const selects = cw.findAllSelects();
    expect(selects[2]?.findTrigger().getElement().textContent).toContain("gate.policy_required");
    // [Issue #3174] index 0 is the event-wide bonus now, then one per team.
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(bonusInputs[2]?.value).toBe("500");
    // 除去 button は保存済み設定があるときだけ出る。
    expect(screen.getByText("gate.remove_button")).toBeInTheDocument();
  });

  it("should save the built config including a team override with bonus", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const onRefresh = vi.fn();
    const { container } = renderPanel({ onRefresh });
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    // gate 未選択の空 form: client-side guard で保存不可。
    expect(saveButton()?.closest("button")).toBeDisabled();
    expect(screen.getByText("gate.error_gate_required")).toBeInTheDocument();
    // gate challenge を選択。
    const gateSelect = cw.findSelect();
    gateSelect?.openDropdown();
    gateSelect?.selectOptionByValue("p-gate");
    // gate を選んだだけでは target が無い → まだ保存不可。
    expect(saveButton()?.closest("button")).toBeDisabled();
    expect(screen.getByText("gate.error_no_targets")).toBeInTheDocument();
    // unlock target を選択。
    const ms = cw.findMultiselect();
    ms?.openDropdown();
    ms?.selectOptionByValue("p-a");
    // t2 (index 2 = gate select, t1, t2 の順) を required に上書きして bonus 1000。
    const t2Select = cw.findAllSelects()[2];
    t2Select?.openDropdown();
    t2Select?.selectOptionByValue("required");
    // [Issue #3174] index 0 is the event-wide bonus, then one per team.
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(bonusInputs[0] as HTMLInputElement, { target: { value: "50" } });
    fireEvent.change(bonusInputs[2] as HTMLInputElement, { target: { value: "1000" } });
    // 保存。
    fireEvent.click(screen.getByText("gate.save_button"));
    await waitFor(() =>
      expect(putGate).toHaveBeenCalledWith(fakeApi, "EVT1", {
        gateProblemId: "p-gate",
        unlockTargetIds: ["p-a"],
        defaultPolicy: "required",
        completionBonus: 50,
        teamOverrides: { t2: { policy: "required", completionBonus: 1000 } },
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
    expect(await screen.findByText("gate.saved_flash")).toBeInTheDocument();
  });

  /**
   * [Issue #3174] The case the old model could not express: leave every team on
   * the event's policy and still hand one of them a bonus. `inherit` rows were
   * dropped on save and their bonus input was disabled, so the only way to give
   * a handicap was to take the team off the event's policy.
   */
  it("should send a bonus-only override without touching the team's policy", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel();
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    cw.findSelect()?.openDropdown();
    cw.findSelect()?.selectOptionByValue("p-gate");
    cw.findMultiselect()?.openDropdown();
    cw.findMultiselect()?.selectOptionByValue("p-a");
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    fireEvent.change(bonusInputs[1] as HTMLInputElement, { target: { value: "250" } });
    fireEvent.click(screen.getByText("gate.save_button"));
    await waitFor(() =>
      expect(putGate).toHaveBeenCalledWith(fakeApi, "EVT1", {
        gateProblemId: "p-gate",
        unlockTargetIds: ["p-a"],
        defaultPolicy: "required",
        teamOverrides: { t1: { completionBonus: 250 } },
      }),
    );
  });

  it("should omit teamOverrides entirely when no team is overridden", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel();
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    const gateSelect = cw.findSelect();
    gateSelect?.openDropdown();
    gateSelect?.selectOptionByValue("p-gate");
    const ms = cw.findMultiselect();
    ms?.openDropdown();
    ms?.selectOptionByValue("p-b");
    fireEvent.click(screen.getByText("gate.save_button"));
    await waitFor(() =>
      expect(putGate).toHaveBeenCalledWith(fakeApi, "EVT1", {
        gateProblemId: "p-gate",
        unlockTargetIds: ["p-b"],
        defaultPolicy: "required",
      }),
    );
  });

  it("should ignore a stale draft for a team no longer in the event when validating", async () => {
    // #2283: 保存・表示は detail.teams のみを走査するのに検証だけ全 draft を見ると、
    // 除去済み team の残骸 draft (範囲外 bonus) が「見えないエラー」で Save を永続 block する。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const staleConfig: ProgressionGateConfig = {
      gateProblemId: "p-gate",
      unlockTargetIds: ["p-a"],
      defaultPolicy: "off",
      // ghost は detail.teams (t1 / t2) に存在しない + bonus が上限超え。
      teamOverrides: { ghost: { policy: "required", completionBonus: 999999 } },
    };
    renderPanel({ detail: detail({ progressionGate: staleConfig }) });
    await screen.findByText("gate.save_button");
    expect(screen.queryByText("gate.error_bonus_range")).not.toBeInTheDocument();
    expect(saveButton()?.closest("button")).not.toBeDisabled();
    fireEvent.click(screen.getByText("gate.save_button"));
    // 実在 team に override は無い → teamOverrides ごと省略して保存できる。
    await waitFor(() =>
      expect(putGate).toHaveBeenCalledWith(fakeApi, "EVT1", {
        gateProblemId: "p-gate",
        unlockTargetIds: ["p-a"],
        defaultPolicy: "off",
      }),
    );
  });

  it("should map an invalid_progression_gate reason to its error text", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    putGate.mockRejectedValue(
      new ApiError(
        StatusCodes.BAD_REQUEST,
        JSON.stringify({ error: "invalid_progression_gate", reason: "unknown_override_team" }),
      ),
    );
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText("gate.error_reason_unknown_override_team")).toBeInTheDocument();
  });

  it("should map the 409 feature_disabled conflict to its error text", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    putGate.mockRejectedValue(
      new ApiError(StatusCodes.CONFLICT, JSON.stringify({ error: "feature_disabled" })),
    );
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText("gate.error_feature_disabled")).toBeInTheDocument();
  });

  it("should disable save and show the bonus-range guard for an out-of-range bonus", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    // t2 は override 済み (= 入力可能)。上限超え / 非整数はどちらも guard に落ちる。
    fireEvent.change(bonusInputs[1] as HTMLInputElement, { target: { value: "999999" } });
    expect(saveButton()?.closest("button")).toBeDisabled();
    expect(screen.getByText("gate.error_bonus_range")).toBeInTheDocument();
    fireEvent.change(bonusInputs[1] as HTMLInputElement, { target: { value: "1.5" } });
    expect(saveButton()?.closest("button")).toBeDisabled();
    // 有効値に戻すと保存可能になる。
    fireEvent.change(bonusInputs[1] as HTMLInputElement, { target: { value: "500" } });
    expect(saveButton()?.closest("button")).not.toBeDisabled();
  });

  it("should remove the gate via the confirm modal and refresh", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const onRefresh = vi.fn();
    renderPanel({ detail: detail({ progressionGate: storedGate }), onRefresh });
    await screen.findByText("gate.remove_button");
    fireEvent.click(screen.getByText("gate.remove_button"));
    // Cloudscape Modal (danger 操作の confirm パターン) を経由する。
    expect(wrapper().findModal()).not.toBeNull();
    fireEvent.click(screen.getByText("gate.modal_remove_confirm"));
    await waitFor(() => expect(deleteGate).toHaveBeenCalledWith(fakeApi, "EVT1"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("should cancel the remove modal without deleting", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.remove_button");
    fireEvent.click(screen.getByText("gate.remove_button"));
    fireEvent.click(screen.getByText("gate.modal_cancel"));
    await waitFor(() => expect(wrapper().findModal()).toBeNull());
    expect(deleteGate).not.toHaveBeenCalled();
  });

  it("should show a flags load error when GET /feature-flags fails", async () => {
    getFlags.mockRejectedValue(new Error("flags boom"));
    renderPanel();
    expect(await screen.findByText("gate.flags_error_header")).toBeInTheDocument();
    expect(screen.getByText("flags boom")).toBeInTheDocument();
  });

  it("should treat a demo-mode NOT_IMPLEMENTED flags response as feature OFF, not an error", async () => {
    // #2283: demo mode (Issue #1954) の fixture client は GET feature-flags を
    // NOT_IMPLEMENTED で投げる → 「flag 行なし = OFF」 と同じ read-only 無効 Alert を出す。
    getFlags.mockRejectedValue(
      new ApiError(
        StatusCodes.NOT_IMPLEMENTED,
        'Demo mode does not simulate "GET feature-flags" yet — no real AWS is called.',
      ),
    );
    renderPanel();
    expect(await screen.findByText("gate.disabled_alert_header")).toBeInTheDocument();
    expect(screen.queryByText("gate.flags_error_header")).not.toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
  });

  it("should disable the editor save for a read-only viewer", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ progressionGate: storedGate }), canMutateTenant: false });
    await screen.findByText("gate.save_button");
    expect(saveButton()?.closest("button")).toBeDisabled();
  });

  it("should disable the default-policy radio group for a read-only viewer", async () => {
    // #2283: RadioGroup は group-level disabled を持たないため per-item disabled で guard する。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel({
      detail: detail({ progressionGate: storedGate }),
      canMutateTenant: false,
    });
    await screen.findByText("gate.save_button");
    const radio = createWrapper(container).findRadioGroup();
    expect(radio?.findInputByValue("required")?.getElement().disabled).toBe(true);
    expect(radio?.findInputByValue("off")?.getElement().disabled).toBe(true);
  });

  it("should surface the raw message when the gate save fails with a non-API error", async () => {
    // mapGateSaveError: ApiError 以外 (network 断など) は toErrorMessage の素の文言に落ちる。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    putGate.mockRejectedValue(new Error("network boom"));
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText("gate.error_save_header")).toBeInTheDocument();
    expect(screen.getByText("network boom")).toBeInTheDocument();
  });

  it("should fall back to the raw message for a 409 conflict without feature_disabled", async () => {
    // 409 でも body が feature_disabled でなければ専用文言に写像しない (別種の conflict)。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    putGate.mockRejectedValue(
      new ApiError(StatusCodes.CONFLICT, JSON.stringify({ error: "already_started" })),
    );
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText('API 409: {"error":"already_started"}')).toBeInTheDocument();
    expect(screen.queryByText("gate.error_feature_disabled")).not.toBeInTheDocument();
  });

  it("should fall back to the raw message for a 400 without a mappable reason", async () => {
    // reason が allowlist (GATE_INVALID_REASONS) に無い 400 は素の文言に落とす。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const body = JSON.stringify({ error: "invalid_progression_gate", reason: "mystery_reason" });
    putGate.mockRejectedValue(new ApiError(StatusCodes.BAD_REQUEST, body));
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText(`API 400: ${body}`)).toBeInTheDocument();
    expect(screen.queryByText("gate.error_reason_mystery_reason")).not.toBeInTheDocument();
  });

  it("should show the save error alert when removing the gate fails", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    deleteGate.mockRejectedValue(new Error("remove boom"));
    const onRefresh = vi.fn();
    renderPanel({ detail: detail({ progressionGate: storedGate }), onRefresh });
    await screen.findByText("gate.remove_button");
    fireEvent.click(screen.getByText("gate.remove_button"));
    fireEvent.click(screen.getByText("gate.modal_remove_confirm"));
    expect(await screen.findByText("gate.error_save_header")).toBeInTheDocument();
    expect(screen.getByText("remove boom")).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("should clear the saved flash when it is dismissed", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    fireEvent.click(screen.getByText("gate.save_button"));
    expect(await screen.findByText("gate.saved_flash")).toBeInTheDocument();
    wrapper().findAlert()?.findDismissButton()?.click();
    await waitFor(() => expect(screen.queryByText("gate.saved_flash")).not.toBeInTheDocument());
  });

  it("should change the default policy via the radio group", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel();
    await screen.findByText("gate.save_button");
    const radio = createWrapper(container).findRadioGroup();
    // 空 form の default は required。 off をクリックすると選択が切り替わる。
    expect(radio?.findInputByValue("required")?.getElement().checked).toBe(true);
    const offInput = radio?.findInputByValue("off")?.getElement();
    expect(offInput).toBeDefined();
    fireEvent.click(offInput as HTMLInputElement);
    await waitFor(() => expect(radio?.findInputByValue("off")?.getElement().checked).toBe(true));
  });

  it("should close the remove modal via its dismiss control without deleting", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.remove_button");
    fireEvent.click(screen.getByText("gate.remove_button"));
    const modal = wrapper().findModal();
    expect(modal).not.toBeNull();
    modal?.findDismissButton().click();
    await waitFor(() => expect(wrapper().findModal()).toBeNull());
    expect(deleteGate).not.toHaveBeenCalled();
  });

  it("should not delete the gate when the api client is gone while the confirm modal is open", async () => {
    // handleRemove の guard: modal の confirm button は !apiClient で disable されないため、
    // modal open 中に apiClient が失われても DELETE を撃たないことを pin する。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { rerender } = renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.remove_button");
    fireEvent.click(screen.getByText("gate.remove_button"));
    expect(wrapper().findModal()).not.toBeNull();
    rerender(
      <EventProgressionGatePanel
        apiClient={null}
        canMutateTenant
        detail={detail({ progressionGate: storedGate })}
        onRefresh={vi.fn()}
        t={t}
      />,
    );
    fireEvent.click(screen.getByText("gate.modal_remove_confirm"));
    expect(deleteGate).not.toHaveBeenCalled();
  });

  it("should prune the new gate problem from the unlock targets on gate change", async () => {
    // 自己参照 (gate ∈ targets) 防止: gate を既存 target の問題に変更すると target から除外される。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const { container } = renderPanel({ detail: detail({ progressionGate: storedGate }) });
    await screen.findByText("gate.save_button");
    const cw = createWrapper(container);
    expect(cw.findMultiselect()?.findTokens()).toHaveLength(1);
    const gateSelect = cw.findSelect();
    gateSelect?.openDropdown();
    gateSelect?.selectOptionByValue("p-a");
    await waitFor(() => expect(cw.findMultiselect()?.findTokens()).toHaveLength(0));
    expect(screen.getByText("gate.error_no_targets")).toBeInTheDocument();
  });

  it("should show a zero override count when the stored config has no teamOverrides", async () => {
    // flag OFF read-only summary: teamOverrides 未設定 (undefined) は count 0 と表示する。
    const noOverrides: ProgressionGateConfig = {
      gateProblemId: "p-gate",
      unlockTargetIds: ["p-a"],
      defaultPolicy: "off",
    };
    renderPanel({ detail: detail({ progressionGate: noOverrides }) });
    expect(await screen.findByText("gate.stored_readonly_header")).toBeInTheDocument();
    expect(screen.getByText('gate.stored_overrides_count:{"count":0}')).toBeInTheDocument();
  });

  it("should prefill an empty bonus for stored overrides without completionBonus and omit it on save", async () => {
    // completionBonus 未設定 / 0 はどちらも空欄で prefill し、 保存時も completionBonus を省略する。
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    const noBonusGate: ProgressionGateConfig = {
      gateProblemId: "p-gate",
      unlockTargetIds: ["p-a"],
      defaultPolicy: "required",
      teamOverrides: { t1: { policy: "off" }, t2: { policy: "required", completionBonus: 0 } },
    };
    renderPanel({ detail: detail({ progressionGate: noBonusGate }) });
    await screen.findByText("gate.save_button");
    const bonusInputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(bonusInputs[0]?.value).toBe("");
    expect(bonusInputs[1]?.value).toBe("");
    fireEvent.click(screen.getByText("gate.save_button"));
    await waitFor(() =>
      expect(putGate).toHaveBeenCalledWith(fakeApi, "EVT1", {
        gateProblemId: "p-gate",
        unlockTargetIds: ["p-a"],
        defaultPolicy: "required",
        teamOverrides: { t1: { policy: "off" }, t2: { policy: "required" } },
      }),
    );
  });

  it("should show the overrides-empty hint when the event has no teams", async () => {
    getFlags.mockResolvedValue({ challengePrerequisiteGate: true });
    renderPanel({ detail: detail({ teams: [] }) });
    await screen.findByText("gate.save_button");
    expect(screen.getByText("gate.overrides_empty")).toBeInTheDocument();
  });

  it("should fall back to the raw message when the flag toggle fails with a non-403 error", async () => {
    putFlags.mockRejectedValue(new Error("toggle boom"));
    renderPanel();
    await screen.findByText("gate.disabled_alert_header");
    toggle()?.findNativeInput().click();
    expect(await screen.findByText("toggle boom")).toBeInTheDocument();
    expect(screen.queryByText("gate.error_toggle_forbidden")).not.toBeInTheDocument();
  });

  it("should ignore the flags response arriving after unmount", async () => {
    // effect の cancelled guard: unmount 後に届いた応答で setState しない。
    let resolveFlags: (flags: Record<string, boolean>) => void = () => {};
    getFlags.mockImplementationOnce(
      () =>
        new Promise<Record<string, boolean>>((resolve) => {
          resolveFlags = resolve;
        }),
    );
    const { unmount } = renderPanel();
    unmount();
    resolveFlags({ challengePrerequisiteGate: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getFlags).toHaveBeenCalledTimes(1);
  });

  it("should ignore a flags fetch failure arriving after unmount", async () => {
    // effect の cancelled guard (エラー側): unmount 後の失敗を error state に反映しない。
    let rejectFlags: (err: Error) => void = () => {};
    getFlags.mockImplementationOnce(
      () =>
        new Promise<Record<string, boolean>>((_resolve, reject) => {
          rejectFlags = reject;
        }),
    );
    const { unmount } = renderPanel();
    unmount();
    rejectFlags(new Error("late boom"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getFlags).toHaveBeenCalledTimes(1);
  });
});
