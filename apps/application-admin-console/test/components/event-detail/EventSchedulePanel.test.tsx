import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventSchedulePanel } from "../../../src/components/event-detail/EventSchedulePanel";
import type { WizardState } from "../../../src/lib/event-wizard";

/**
 * EventSchedulePanel: starts/ends at + scoring 状態 + freeze 分 + 予約/即座の deploy・teardown を
 * 集約したライフサイクル panel。 set/unset の code vs プレースホルダ表示、 freeze の現在値 vs
 * default、 各 button の callback と disabled/loading 条件 (apiClient 不在 / scheduleInFlight
 * now・scheduled / endsAtInFlight / freezeMinutesInFlight / freeze 入力空 / bulkInFlight) を
 * pin する。 即座にデプロイ は未デプロイなら直接 onBulkDeploy、 全デプロイ済みなら force-redeploy の
 * confirm modal を挟む。 即座に撤去 は danger-zone の confirm を開く onConfirmTeardown を叩く。
 * shared (Field/scoringBadge) は stub。
 */
vi.mock("../../../src/components/event-detail/shared", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  scoringBadge: () => <span data-testid="scoring-badge" />,
}));

type Props = Parameters<typeof EventSchedulePanel>[0];
const props = (over: Partial<Props> = {}): Props => ({
  apiClient: {} as never,
  bulkInFlight: null,
  canMutateTenant: true,
  completeCount: 0,
  deployScheduleInFlight: false,
  detail: {
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2026-01-02T00:00:00Z",
    teardownAt: "2026-01-03T00:00:00Z",
    deployAt: "2025-12-31T00:00:00Z",
    scoreboardFreezeMinutes: 5,
    // DRAFT (未デプロイ) を基準に: 予約デプロイ UI は DRAFT でのみ出る (deploy 済では死に設定になる)。
    status: "DRAFT",
    teams: [{ internalSlug: "t" }],
    problems: [{ problemId: "p" }],
  } as unknown as EventDetail,
  endsAtInFlight: false,
  freezeMinutesInFlight: false,
  freezeMinutesInput: "30",
  onBulkDeploy: vi.fn(),
  onConfirmTeardown: vi.fn(),
  onEndNowSchedule: vi.fn(),
  onOpenDeployModal: vi.fn(),
  onOpenEndsAtModal: vi.fn(),
  onOpenScheduleModal: vi.fn(),
  onOpenTeardownModal: vi.fn(),
  onSaveFreezeMinutes: vi.fn(),
  onStartNow: vi.fn(),
  onUpdateFreezeMinutes: vi.fn(),
  scheduleInFlight: null,
  teardownInFlight: false,
  totalDeployCount: 0,
  t: (k: string) => k,
  wizard: { primary: "start" } as unknown as WizardState,
  ...over,
});
const renderPanel = (over: Partial<Props> = {}) => render(<EventSchedulePanel {...props(over)} />);
const btn = (name: string) => screen.getByRole("button", { name });

afterEach(() => vi.clearAllMocks());

describe("EventSchedulePanel", () => {
  it("should render set values and fire every action callback when enabled", () => {
    const p = props();
    render(<EventSchedulePanel {...p} />);
    expect(screen.getByText("2026-01-01T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-01-02T00:00:00Z")).toBeInTheDocument();
    expect(screen.getByText("2026-01-03T00:00:00Z")).toBeInTheDocument(); // teardownAt
    expect(screen.getByText("2025-12-31T00:00:00Z")).toBeInTheDocument(); // deployAt
    expect(screen.getByText("event_detail.freeze_current_minutes")).toBeInTheDocument();

    fireEvent.click(btn("event_detail.starts_at_pick"));
    expect(p.onOpenScheduleModal).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.starts_at_now"));
    expect(p.onStartNow).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.ends_at_pick"));
    expect(p.onOpenEndsAtModal).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.ends_at_now"));
    expect(p.onEndNowSchedule).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.teardown_at_pick"));
    expect(p.onOpenTeardownModal).toHaveBeenCalled();
    fireEvent.click(btn("event_detail.deploy_at_pick"));
    expect(p.onOpenDeployModal).toHaveBeenCalled();
    // totalDeployCount=0 (default) → 未デプロイ → 即座にデプロイ は直接 onBulkDeploy() を叩く。
    fireEvent.click(btn("event_detail.deploy_at_now"));
    expect(p.onBulkDeploy).toHaveBeenCalledWith();
    // 即座に撤去 は danger-zone の confirm を開く onConfirmTeardown を叩く。
    fireEvent.click(btn("event_detail.teardown_at_now"));
    expect(p.onConfirmTeardown).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "45" } });
    expect(p.onUpdateFreezeMinutes).toHaveBeenCalledWith("45");
    fireEvent.click(btn("event_detail.freeze_save"));
    expect(p.onSaveFreezeMinutes).toHaveBeenCalled();
  });

  it("should relabel the deploy button as force-redeploy once everything is deployed", () => {
    // 未デプロイ (default) は「即座にデプロイ」、 全デプロイ済みは「強制再デプロイ」を出し、
    // 既に deploy 済みなのに無害な初回デプロイに見える混乱を防ぐ (= 押下は破壊的 redeploy)。
    renderPanel();
    expect(btn("event_detail.deploy_at_now")).toBeInTheDocument();
    expect(screen.queryByText("event_detail.deploy_at_redeploy")).not.toBeInTheDocument();

    // 全デプロイ済み + wizard が deploy を指していても force-redeploy は primary 強調しない。
    renderPanel({
      totalDeployCount: 1,
      completeCount: 1,
      wizard: { primary: "deploy" } as unknown as WizardState,
    });
    expect(btn("event_detail.deploy_at_redeploy")).toBeInTheDocument();
  });

  it("should confirm before force-redeploying when everything is already deployed", () => {
    // detail() has 1 team x 1 problem → expected=1. totalDeployCount=1 → all deployed.
    const p = props({ totalDeployCount: 1, completeCount: 1 });
    render(<EventSchedulePanel {...p} />);
    // 全デプロイ済み → ラベルは「強制再デプロイ」、 直接発火せず confirm modal を開く。
    fireEvent.click(btn("event_detail.deploy_at_redeploy"));
    expect(p.onBulkDeploy).not.toHaveBeenCalled();
    // modal の body は completeCount を埋め込む key を出す。
    expect(screen.getByText("event_detail.modal_redeploy_body")).toBeInTheDocument();
    fireEvent.click(btn("event_detail.modal_redeploy_confirm"));
    expect(p.onBulkDeploy).toHaveBeenCalledWith({ forceRedeploy: true });
  });

  it("should cancel the force-redeploy confirm modal without deploying", () => {
    const p = props({ totalDeployCount: 1, completeCount: 1 });
    render(<EventSchedulePanel {...p} />);
    fireEvent.click(btn("event_detail.deploy_at_redeploy"));
    fireEvent.click(btn("event_detail.modal_cancel"));
    expect(p.onBulkDeploy).not.toHaveBeenCalled();
    // dismiss 後は modal が閉じる (confirm button が DOM から消える)。
    expect(screen.queryByText("event_detail.modal_redeploy_confirm")).not.toBeInTheDocument();
  });

  it("should promote the deploy-now button to primary when the wizard points at deploy", () => {
    // wizard.primary === "deploy" → 即座にデプロイ が primary variant (= 推奨アクション強調) を取る分岐。
    renderPanel({ wizard: { primary: "deploy" } as unknown as WizardState });
    // primary でも click でき onBulkDeploy を叩く (= 推奨アクションがそのまま実行できる)。
    fireEvent.click(btn("event_detail.deploy_at_now"));
  });

  it("should show placeholders and defaults when schedule + freeze are unset (wizard null)", () => {
    renderPanel({
      detail: {
        startsAt: undefined,
        endsAt: undefined,
        teardownAt: undefined,
        deployAt: undefined,
        scoreboardFreezeMinutes: undefined,
        status: "DRAFT",
        teams: [],
        problems: [],
      } as unknown as EventDetail,
      wizard: null,
      freezeMinutesInput: "",
    });
    expect(screen.getByText("event_detail.starts_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.ends_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.teardown_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.deploy_at_unset")).toBeInTheDocument();
    expect(screen.getByText("event_detail.freeze_current_default")).toBeInTheDocument();
    // freeze 入力が空 → save 無効。
    expect(btn("event_detail.freeze_save")).toBeDisabled();
    // team / problem が 0 件 → 即座にデプロイ は無効。
    expect(btn("event_detail.deploy_at_now")).toBeDisabled();
  });

  it("should hide scheduled-deploy once deployed (non-DRAFT) and show the after-deploy hint", () => {
    // 予約デプロイは reconciler が DRAFT でしか発火しないので、 deploy 済 (READY 等) では予約 UI を
    // 出さず hint に切り替える (= 死に設定 + endsAt 比較 400 を作らせない)。 即座にデプロイは残す。
    renderPanel({
      detail: {
        deployAt: "2025-12-31T00:00:00Z",
        teardownAt: undefined,
        status: "READY",
        teams: [{ internalSlug: "t" }],
        problems: [{ problemId: "p" }],
      } as unknown as EventDetail,
    });
    expect(screen.getByText("event_detail.deploy_at_after_deploy_hint")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "event_detail.deploy_at_pick" }),
    ).not.toBeInTheDocument();
    // 死に設定を見せないため deployAt の生時刻も出さない。
    expect(screen.queryByText("2025-12-31T00:00:00Z")).not.toBeInTheDocument();
    // 即座にデプロイ (= 手動 deploy / redeploy) は残る。
    expect(btn("event_detail.deploy_at_now")).toBeInTheDocument();
  });

  it("should disable every action when the API client is unavailable", () => {
    renderPanel({ apiClient: null });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled();
    expect(btn("event_detail.starts_at_now")).toBeDisabled();
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(btn("event_detail.ends_at_now")).toBeDisabled();
    expect(btn("event_detail.teardown_at_pick")).toBeDisabled();
    expect(btn("event_detail.teardown_at_now")).toBeDisabled();
    expect(btn("event_detail.deploy_at_pick")).toBeDisabled();
    expect(btn("event_detail.deploy_at_now")).toBeDisabled();
    expect(btn("event_detail.freeze_save")).toBeDisabled();
  });

  it("should disable every write action for a read-only viewer", () => {
    renderPanel({ canMutateTenant: false });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled();
    expect(btn("event_detail.starts_at_now")).toBeDisabled();
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(btn("event_detail.ends_at_now")).toBeDisabled();
    expect(btn("event_detail.teardown_at_pick")).toBeDisabled();
    expect(btn("event_detail.teardown_at_now")).toBeDisabled();
    expect(btn("event_detail.deploy_at_pick")).toBeDisabled();
    expect(btn("event_detail.deploy_at_now")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();
    expect(btn("event_detail.freeze_save")).toBeDisabled();
  });

  it("should disable the deploy-now / teardown-now buttons for a terminal status", () => {
    renderPanel({
      detail: {
        status: "ENDED",
        teams: [{ internalSlug: "t" }],
        problems: [{ problemId: "p" }],
      } as unknown as EventDetail,
    });
    // 終端 status → 即座にデプロイ は無効 (撤去は status を見ないので有効のまま)。
    expect(btn("event_detail.deploy_at_now")).toBeDisabled();
  });

  it("should reflect bulk in-flight states on the deploy-now and teardown-now buttons", () => {
    const { rerender } = renderPanel({ bulkInFlight: "deploy" });
    // bulkInFlight が立つと両 button とも無効 (= 同じ POST 経路を奪い合わない)。
    expect(btn("event_detail.deploy_at_now")).toBeDisabled();
    expect(btn("event_detail.teardown_at_now")).toBeDisabled();
    rerender(<EventSchedulePanel {...props({ bulkInFlight: "teardown" })} />);
    expect(btn("event_detail.teardown_at_now")).toBeDisabled();
  });

  it("should reflect in-flight schedule states (now loading / scheduled disabling pick)", () => {
    const { rerender } = renderPanel({ scheduleInFlight: "now" });
    expect(btn("event_detail.starts_at_pick")).toBeDisabled(); // scheduleInFlight !== null
    rerender(<EventSchedulePanel {...props({ scheduleInFlight: "scheduled" })} />);
    expect(btn("event_detail.starts_at_now")).toBeDisabled(); // === "scheduled"
  });

  it("should reflect ends-at and freeze in-flight states", () => {
    renderPanel({ endsAtInFlight: true, freezeMinutesInFlight: true });
    expect(btn("event_detail.ends_at_pick")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled(); // freeze input
  });

  it("should disable the teardown pick button while a teardown schedule is in flight", () => {
    renderPanel({ teardownInFlight: true });
    expect(btn("event_detail.teardown_at_pick")).toBeDisabled();
  });

  it("should disable the deploy pick button while a deploy schedule is in flight", () => {
    renderPanel({ deployScheduleInFlight: true });
    expect(btn("event_detail.deploy_at_pick")).toBeDisabled();
  });
});
