import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventDetail } from "../../../src/api/events-client";
import { EventDangerZone } from "../../../src/components/event-detail/EventDangerZone";
import type {
  EventDangerZoneController,
  ScheduleOperationModel,
} from "../../../src/components/event-detail/event-danger-zone-models";
import type { AppConfig } from "../../../src/config";
import type { EndsAtValidation } from "../../../src/hooks/useEventOperations";
import en from "../../../src/i18n/locales/en.json";
import ja from "../../../src/i18n/locales/ja.json";

/** Resolves against a real locale dictionary so copy assertions pin the actual shipped text. */
function realT(dict: Record<string, unknown>) {
  return (key: string, params?: Readonly<Record<string, string | number>>) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        dict,
      );
    let s = typeof value === "string" ? value : key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

/**
 * Issue #1350 / #2020: EventDangerZone (end / force-archive / teardown / schedule-start / ends-at /
 * teardown-schedule / deploy-schedule / notification の確認 modal 群)。 各 modal の confirm/cancel
 * callback、 teardown 確認入力 (DELETE で活性化)、 schedule・ends-at の DatePicker/TimeInput
 * onChange、 notification success alert を pin する。 #2020 で props は単一の grouped controller
 * に再編されたので、 fixture も per-operation model を組み立てる。 子 SendNotificationModal は
 * stub、 t は echo。
 */
vi.mock("../../../src/components/SendNotificationModal", () => ({
  // biome-ignore lint/suspicious/noExplicitAny: stub props。
  SendNotificationModal: (p: any) =>
    p.visible ? (
      <div data-testid="send-notification-modal">
        <button type="button" onClick={p.onSuccess}>
          stub-notify-success
        </button>
        <button type="button" onClick={p.onDismiss}>
          stub-notify-dismiss
        </button>
      </div>
    ) : null,
}));

const DEFAULT_DETAIL = {
  teams: [{}],
  problems: [{}],
  startsAt: "2026-06-01T00:00:00Z",
} as unknown as EventDetail;

function scheduleModel(over: Partial<ScheduleOperationModel> = {}): ScheduleOperationModel {
  return {
    open: false,
    inFlight: false,
    date: "",
    time: "",
    setDate: vi.fn(),
    setTime: vi.fn(),
    submit: vi.fn(),
    dismiss: vi.fn(),
    ...over,
  };
}

/** Build a fully-spied controller; pass `detail` / `canMutateTenant` / model overrides per test. */
function controller(
  over: {
    canMutateTenant?: boolean;
    config?: AppConfig;
    detail?: EventDetail | null;
    endEvent?: Partial<EventDangerZoneController["endEvent"]>;
    forceArchive?: Partial<EventDangerZoneController["forceArchive"]>;
    teardown?: Partial<EventDangerZoneController["teardown"]>;
    schedule?: Partial<ScheduleOperationModel>;
    endsAt?: Partial<EventDangerZoneController["endsAt"]>;
    teardownSchedule?: Partial<ScheduleOperationModel>;
    deploySchedule?: Partial<ScheduleOperationModel>;
    notification?: Partial<EventDangerZoneController["notification"]>;
  } = {},
): EventDangerZoneController {
  return {
    eventContext: {
      canMutateTenant: over.canMutateTenant ?? true,
      config: over.config ?? ({} as AppConfig),
      detail: over.detail === undefined ? DEFAULT_DETAIL : over.detail,
      eventId: "e1",
    },
    endEvent: {
      open: false,
      inFlight: false,
      dismiss: vi.fn(),
      execute: vi.fn(),
      ...over.endEvent,
    },
    forceArchive: {
      open: false,
      inFlight: false,
      dismiss: vi.fn(),
      execute: vi.fn(),
      ...over.forceArchive,
    },
    teardown: { open: false, dismiss: vi.fn(), execute: vi.fn(), ...over.teardown },
    schedule: scheduleModel(over.schedule),
    endsAt: {
      ...scheduleModel(),
      validation: { canSubmit: true } as EndsAtValidation,
      errorText: undefined,
      invalid: false,
      ...over.endsAt,
    },
    teardownSchedule: scheduleModel(over.teardownSchedule),
    deploySchedule: scheduleModel(over.deploySchedule),
    notification: {
      modalOpen: false,
      justSent: false,
      dismissModal: vi.fn(),
      dismissSuccess: vi.fn(),
      onSuccess: vi.fn(),
      ...over.notification,
    },
  };
}

const t = (k: string) => k;

afterEach(() => vi.clearAllMocks());

describe("EventDangerZone", () => {
  it("should confirm end / force-archive / teardown (DELETE-gated) and cancel each", () => {
    const c = controller({
      endEvent: { open: true },
      forceArchive: { open: true },
      teardown: { open: true },
    });
    render(<EventDangerZone controller={c} t={t} />);
    // teardown blast-radius は teams/problems 件数を出す。
    expect(screen.getByText("event_detail.modal_teardown_blast_radius_body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "event_detail.modal_end_event_confirm" }));
    expect(c.endEvent.execute).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("force-archive-confirm"));
    expect(c.forceArchive.execute).toHaveBeenCalled();

    // teardown confirm は DELETE 入力まで disabled。
    const teardownBtn = screen.getByTestId("modal-teardown-confirm");
    expect(teardownBtn).toBeDisabled();
    const input = screen.getByTestId("modal-teardown-confirm-input").querySelector("input");
    fireEvent.change(input as HTMLInputElement, { target: { value: "DELETE" } });
    expect(screen.getByTestId("modal-teardown-confirm")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("modal-teardown-confirm"));
    expect(c.teardown.execute).toHaveBeenCalled();

    // 各 modal の cancel (modal_cancel) → end / force-archive / teardown の順。
    const cancels = screen.getAllByRole("button", { name: "event_detail.modal_cancel" });
    fireEvent.click(cancels[0] as HTMLElement);
    fireEvent.click(cancels[1] as HTMLElement);
    fireEvent.click(cancels[2] as HTMLElement);
    expect(c.endEvent.dismiss).toHaveBeenCalled();
    expect(c.forceArchive.dismiss).toHaveBeenCalled();
    expect(c.teardown.dismiss).toHaveBeenCalled();
  });

  it("should drive the schedule-start and ends-at date/time inputs and confirms", () => {
    const c = controller({ schedule: { open: true }, endsAt: { open: true } });
    render(<EventDangerZone controller={c} t={t} />);
    expect(screen.getByText(/event_detail\.modal_endsat_starts_at_hint/)).toBeInTheDocument(); // detail.startsAt hint

    // Cloudscape DatePicker/TimeInput は入力値を正規化するので、 onChange が発火したことだけ pin。
    const dates = screen.getAllByPlaceholderText("YYYY/MM/DD"); // [0]=schedule, [1]=ends-at
    fireEvent.change(dates[0] as HTMLElement, { target: { value: "2026/06/01" } });
    expect(c.schedule.setDate).toHaveBeenCalled();
    fireEvent.change(dates[1] as HTMLElement, { target: { value: "2026/06/02" } });
    expect(c.endsAt.setDate).toHaveBeenCalled();

    const times = screen.getAllByPlaceholderText("hh:mm");
    fireEvent.change(times[0] as HTMLElement, { target: { value: "10:00" } });
    expect(c.schedule.setTime).toHaveBeenCalled();
    fireEvent.change(times[1] as HTMLElement, { target: { value: "18:00" } });
    expect(c.endsAt.setTime).toHaveBeenCalled();

    // 両 modal の confirm (modal_schedule_confirm_label) → schedule-start / ends-at の順。
    const confirms = screen.getAllByRole("button", {
      name: "event_detail.modal_schedule_confirm_label",
    });
    fireEvent.click(confirms[0] as HTMLElement);
    expect(c.schedule.submit).toHaveBeenCalled();
    fireEvent.click(confirms[1] as HTMLElement);
    expect(c.endsAt.submit).toHaveBeenCalled();
  });

  it("should surface the ends-at validation error text and invalid state on the inputs", () => {
    // errorText 付き → FormField の errorText / DatePicker・TimeInput の invalid 経路。
    const c = controller({
      endsAt: {
        open: true,
        errorText: "event_detail.error_endsat_past",
        invalid: true,
        validation: { canSubmit: false } as EndsAtValidation,
      },
    });
    render(<EventDangerZone controller={c} t={t} />);
    const dialog = within(screen.getByRole("dialog", { name: "event_detail.modal_endsat_header" }));
    expect(dialog.getAllByText("event_detail.error_endsat_past").length).toBeGreaterThan(0);
    // canSubmit:false → confirm disabled。
    expect(
      dialog.getByRole("button", { name: "event_detail.modal_schedule_confirm_label" }),
    ).toBeDisabled();
  });

  it("should render the teardown blast-radius with zero counts when detail is null", () => {
    render(
      <EventDangerZone controller={controller({ teardown: { open: true }, detail: null })} t={t} />,
    );
    // detail?.teams.length ?? 0 / detail?.problems.length ?? 0 の null 経路。
    expect(screen.getByText("event_detail.modal_teardown_blast_radius_body")).toBeInTheDocument();
  });

  it("should disable modal confirmations for a read-only viewer", () => {
    render(
      <EventDangerZone
        controller={controller({
          canMutateTenant: false,
          endEvent: { open: true },
          forceArchive: { open: true },
          teardown: { open: true },
        })}
        t={t}
      />,
    );
    expect(
      screen.getByRole("button", { name: "event_detail.modal_end_event_confirm" }),
    ).toBeDisabled();
    expect(screen.getByTestId("force-archive-confirm")).toBeDisabled();
    const input = screen.getByTestId("modal-teardown-confirm-input").querySelector("input");
    fireEvent.change(input as HTMLInputElement, { target: { value: "DELETE" } });
    expect(screen.getByTestId("modal-teardown-confirm")).toBeDisabled();
  });

  it("should drive the teardown-schedule modal inputs and confirm/cancel", () => {
    const c = controller({
      teardownSchedule: { open: true },
      detail: {
        teams: [{}],
        problems: [{}],
        endsAt: "2026-06-02T00:00:00Z",
      } as unknown as EventDetail,
    });
    render(<EventDangerZone controller={c} t={t} />);
    // Cloudscape は他 modal も DOM に描画するため、 teardown dialog に scope する。
    const modal = within(
      screen.getByRole("dialog", { name: "event_detail.modal_teardown_schedule_header" }),
    );
    expect(modal.getByText("event_detail.modal_teardown_schedule_body")).toBeInTheDocument();
    // endsAt hint (truthy 経路)。
    expect(modal.getByText(/event_detail\.modal_teardown_ends_at_hint/)).toBeInTheDocument();

    fireEvent.change(modal.getByPlaceholderText("YYYY/MM/DD"), { target: { value: "2026/06/03" } });
    expect(c.teardownSchedule.setDate).toHaveBeenCalled();
    fireEvent.change(modal.getByPlaceholderText("hh:mm"), { target: { value: "10:00" } });
    expect(c.teardownSchedule.setTime).toHaveBeenCalled();

    fireEvent.click(
      modal.getByRole("button", { name: "event_detail.modal_teardown_schedule_confirm" }),
    );
    expect(c.teardownSchedule.submit).toHaveBeenCalled();
    fireEvent.click(modal.getByRole("button", { name: "event_detail.modal_cancel" }));
    expect(c.teardownSchedule.dismiss).toHaveBeenCalled();
  });

  it("should hide the teardown ends-at hint without an end time and disable confirm in-flight / read-only", () => {
    // endsAt 不在 → hint 非表示 (falsy 経路)。
    const { rerender } = render(
      <EventDangerZone controller={controller({ teardownSchedule: { open: true } })} t={t} />,
    );
    expect(screen.queryByText(/event_detail\.modal_teardown_ends_at_hint/)).toBeNull();
    const confirmName = { name: "event_detail.modal_teardown_schedule_confirm" };
    rerender(
      <EventDangerZone
        controller={controller({ teardownSchedule: { open: true, inFlight: true } })}
        t={t}
      />,
    );
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
    rerender(
      <EventDangerZone
        controller={controller({ canMutateTenant: false, teardownSchedule: { open: true } })}
        t={t}
      />,
    );
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
  });

  it("should drive the deploy-schedule modal inputs and confirm/cancel", () => {
    const c = controller({
      deploySchedule: { open: true },
      detail: {
        teams: [{}],
        problems: [{}],
        endsAt: "2026-06-02T00:00:00Z",
      } as unknown as EventDetail,
    });
    render(<EventDangerZone controller={c} t={t} />);
    // Cloudscape は他 modal も DOM に描画するため、 deploy dialog に scope する。
    const modal = within(
      screen.getByRole("dialog", { name: "event_detail.modal_deploy_schedule_header" }),
    );
    expect(modal.getByText("event_detail.modal_deploy_schedule_body")).toBeInTheDocument();
    // endsAt hint (truthy 経路)。
    expect(modal.getByText(/event_detail\.modal_deploy_ends_at_hint/)).toBeInTheDocument();

    fireEvent.change(modal.getByPlaceholderText("YYYY/MM/DD"), { target: { value: "2026/06/01" } });
    expect(c.deploySchedule.setDate).toHaveBeenCalled();
    fireEvent.change(modal.getByPlaceholderText("hh:mm"), { target: { value: "09:00" } });
    expect(c.deploySchedule.setTime).toHaveBeenCalled();

    fireEvent.click(
      modal.getByRole("button", { name: "event_detail.modal_deploy_schedule_confirm" }),
    );
    expect(c.deploySchedule.submit).toHaveBeenCalled();
    fireEvent.click(modal.getByRole("button", { name: "event_detail.modal_cancel" }));
    expect(c.deploySchedule.dismiss).toHaveBeenCalled();
  });

  it("should hide the deploy ends-at hint without an end time and disable confirm in-flight / read-only", () => {
    // endsAt 不在 → hint 非表示 (falsy 経路)。
    const { rerender } = render(
      <EventDangerZone controller={controller({ deploySchedule: { open: true } })} t={t} />,
    );
    expect(screen.queryByText(/event_detail\.modal_deploy_ends_at_hint/)).toBeNull();
    const confirmName = { name: "event_detail.modal_deploy_schedule_confirm" };
    rerender(
      <EventDangerZone
        controller={controller({ deploySchedule: { open: true, inFlight: true } })}
        t={t}
      />,
    );
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
    rerender(
      <EventDangerZone
        controller={controller({ canMutateTenant: false, deploySchedule: { open: true } })}
        t={t}
      />,
    );
    expect(screen.getByRole("button", confirmName)).toBeDisabled();
  });

  it("should wire the notification modal and dismiss the just-sent success alert", () => {
    const c = controller({ notification: { modalOpen: true, justSent: true } });
    render(<EventDangerZone controller={c} t={t} />);
    fireEvent.click(screen.getByText("stub-notify-success"));
    expect(c.notification.onSuccess).toHaveBeenCalled();
    fireEvent.click(screen.getByText("stub-notify-dismiss"));
    expect(c.notification.dismissModal).toHaveBeenCalled();
    // justSent → success alert + dismiss。
    expect(screen.getByText("event_detail.notification_sent_body")).toBeInTheDocument();
    fireEvent.click(document.querySelector('button[class*="dismiss-button"]') as HTMLButtonElement);
    expect(c.notification.dismissSuccess).toHaveBeenCalled();
  });
});

/**
 * Local-hosting rehearsal defect: the teardown modal showed CloudFormation / competitor-account
 * copy in local mode, which has neither. Assert the literal shipped text (real en/ja dictionaries,
 * not the key-echo `t`) so a future edit can't reintroduce AWS wording under `isLocalHost`.
 */
describe("EventDangerZone teardown modal copy (local hosting vs SaaS)", () => {
  const twoTeamsOneProblem = {
    teams: [{}, {}],
    problems: [{}],
  } as unknown as EventDetail;
  const localHostConfig: AppConfig = {
    cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
    cognitoClientId: "abc",
    redirectUri: "http://localhost:5174/callback",
    scope: "openid email profile",
    tenantId: "tenant-test",
    tenantName: "Test Tenant",
    apiBaseUrl: "https://api.example.com/prod",
    samlIdpDirectory: {},
    mode: "local-host",
  };

  it("should show accurate local-hosting copy in English with no AWS/CloudFormation wording", () => {
    const c = controller({
      config: localHostConfig,
      detail: twoTeamsOneProblem,
      teardown: { open: true },
    });
    render(<EventDangerZone controller={c} t={realT(en)} />);
    const dialog = within(
      screen.getByRole("dialog", { name: "Delete all deployments for this Event?" }),
    );
    expect(
      dialog.getByText(
        "Tears down every team's problem environment for this Event. Docker containers and volumes are deleted for Docker problems on this computer; Battle problems have their access closed. The event, scores and submissions are kept. Cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(
        "2 team(s) × 1 problem(s) will be torn down on this computer. Cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText("Environments already removed are skipped.")).toBeInTheDocument();
    expect(dialog.queryByText(/CloudFormation/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/competitor account/i)).not.toBeInTheDocument();
    expect(dialog.queryByText(/Phase 3/)).not.toBeInTheDocument();
  });

  it.each([
    [
      en,
      "Private native match data and saved match history will be permanently deleted. Event details, scores, and score history are kept.",
    ],
    [
      ja,
      "ネイティブ対戦の非公開データと保存された対戦履歴は完全に削除されます。イベント情報、スコア、スコア履歴は保持されます。",
    ],
  ] as const)(
    "explains native cleanup and score retention before confirmation",
    (dictionary, copy) => {
      const c = controller({
        config: { ...localHostConfig, mode: "cloud-host" },
        detail: {
          ...twoTeamsOneProblem,
          nativeRuns: [
            { runId: "run-1", problemId: "ac26-crypto-battle", status: "CLOSED", revision: 3 },
          ],
        },
        teardown: { open: true },
      });
      render(<EventDangerZone controller={c} t={realT(dictionary)} />);
      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(screen.getByTestId("modal-teardown-confirm")).toBeDisabled();
    },
  );

  it("should show accurate local-hosting copy in Japanese with no competitor-account wording", () => {
    const c = controller({
      config: localHostConfig,
      detail: twoTeamsOneProblem,
      teardown: { open: true },
    });
    render(<EventDangerZone controller={c} t={realT(ja)} />);
    const dialog = within(
      screen.getByRole("dialog", { name: "Event 全 deployment を削除しますか?" }),
    );
    expect(
      dialog.getByText(
        "このイベントの全チームの問題環境を撤収します。Docker 問題はこのPC上のコンテナとボリュームを削除し、Battle 問題は参加アクセスを閉じます。イベント、得点、提出結果は保持します。取り消しできません。",
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText("2 チーム × 1 問題の環境をこのPCで撤収します。取り消しできません。"),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/競技者アカウント/)).not.toBeInTheDocument();
    expect(dialog.queryByText(/Phase 3/)).not.toBeInTheDocument();
  });

  it("should keep the SaaS teardown copy (CloudFormation / competitor accounts) unchanged", () => {
    const c = controller({ detail: twoTeamsOneProblem, teardown: { open: true } });
    render(<EventDangerZone controller={c} t={realT(en)} />);
    const dialog = within(
      screen.getByRole("dialog", { name: "Delete all deployments for this Event?" }),
    );
    expect(
      dialog.getByText(
        "All deployments under this Event will be moved to DELETING and a CloudFormation stack delete will be issued on competitor accounts. Cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(
        "2 team(s) × 1 problem(s) — all CloudFormation stacks will be deleted on the competitor accounts. Cannot be undone.",
      ),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(/Rows already in DELETING \/ DELETED are idempotently skipped/),
    ).toBeInTheDocument();
  });
});
