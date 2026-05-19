import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import DatePicker from "@cloudscape-design/components/date-picker";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import TimeInput from "@cloudscape-design/components/time-input";
import { StatusCodes } from "http-status-codes";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ApiError, useApiClient } from "../api/client";
import {
  archiveEvent,
  type BulkDeployBody,
  type BulkResult,
  bulkDeployEvent,
  bulkTeardownEvent,
  EVENT_ID_RE,
  type EventDeploymentStatus,
  type EventDeploymentSummary,
  type EventDetail,
  type EventStatus,
  endEvent,
  getEvent,
  lockEventScoring,
  setEventSchedule,
  unlockEventScoring,
} from "../api/events-client";
import { SendNotificationModal } from "../components/SendNotificationModal";
import { TeamRankingPanel } from "../components/TeamRankingPanel";
import { TeamScoreEventsPanel } from "../components/TeamScoreEventsPanel";
import type { AppConfig } from "../config";
import { useT } from "../i18n";
import { computeEventWizardState, WIZARD_STEPS } from "../lib/event-wizard";

const DEPLOY_STATUS_COLOR: Record<EventDeploymentStatus, "blue" | "green" | "grey" | "red"> = {
  PENDING: "grey",
  IN_PROGRESS: "blue",
  COMPLETE: "green",
  FAILED: "red",
  DELETING: "grey",
  DELETED: "grey",
};

/**
 * 1 problem 行の deploy 状況サマリ: `成功 N / 全 M` + 失敗があれば赤 Badge を併記。
 * Bulk Deploy 未実行 (deployments 無し) なら "未デプロイ" 表示。
 */
function renderProblemDeployStatus(
  deployments: readonly EventDeploymentSummary[] | undefined,
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        {t("event_detail.deploy_status_undeployed")}
      </Box>
    );
  }
  const total = deployments.length;
  const complete = deployments.filter((d) => d.status === "COMPLETE").length;
  const failed = deployments.filter((d) => d.status === "FAILED").length;
  const inFlight = deployments.filter(
    (d) => d.status === "PENDING" || d.status === "IN_PROGRESS",
  ).length;
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Box variant="strong">
        {complete} / {total}
      </Box>
      {failed > 0 && (
        <Badge color="red">{t("event_detail.deploy_status_failed_badge", { count: failed })}</Badge>
      )}
      {inFlight > 0 && (
        <Badge color="blue">{t("event_detail.deploy_status_in_flight", { count: inFlight })}</Badge>
      )}
    </SpaceBetween>
  );
}

/**
 * 1 problem 行の deploy job click-through link 列 (#533)。
 *
 * 旧: Badge を Link でラップしただけだと click 可能か視覚的にわからない (= hover でしか
 * cursor が変わらない)。新: Link テキスト + status badge を **横並び** にし、Link 部分に
 * external icon を付けて click 可能 affordance を明示する。status badge は同色で残し、
 * 「これは link であり、横の badge はその job の状態」の visual identity を分離する。
 */
function renderProblemJobLinks(deployments: readonly EventDeploymentSummary[] | undefined) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        —
      </Box>
    );
  }
  return (
    <SpaceBetween direction="vertical" size="xxs">
      {deployments.map((d, i) => (
        <SpaceBetween key={d.jobId} direction="horizontal" size="xxs" alignItems="center">
          <Link
            href={`/deployments/${encodeURIComponent(d.jobId)}`}
            external={false}
            ariaLabel={`Deploy job 詳細 (status: ${d.status})`}
          >
            Job #{i + 1} ↗
          </Link>
          <Badge color={DEPLOY_STATUS_COLOR[d.status]}>{d.status}</Badge>
        </SpaceBetween>
      ))}
    </SpaceBetween>
  );
}

const STATUS_COLOR: Record<EventStatus, "blue" | "green" | "grey" | "red"> = {
  DRAFT: "blue",
  DEPLOYING: "blue",
  READY: "green",
  ENDED: "grey",
  TEARDOWN: "red",
  ARCHIVED: "grey",
};

interface EndsAtValidation {
  readonly canSubmit: boolean;
  /** i18n key (= `event_detail.error_*`) returned for the caller to resolve via useT(). */
  readonly errorKey?: string;
  readonly value?: Date;
}

function validateEndsAtInput(
  date: string,
  time: string,
  startsAt: string | undefined,
  nowMs: number,
): EndsAtValidation {
  if (!date || !time) return { canSubmit: false };
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) {
    return { canSubmit: false, errorKey: "event_detail.error_endsat_format" };
  }
  if (value.getTime() < nowMs - 60_000) {
    return { canSubmit: false, errorKey: "event_detail.error_endsat_past" };
  }
  if (startsAt) {
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && value.getTime() <= startsAtMs) {
      return { canSubmit: false, errorKey: "event_detail.error_endsat_before_start" };
    }
  }
  return { canSubmit: true, value };
}

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const t = useT();
  const apiClient = useApiClient(config);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  // #555/#756: deploy 系操作は同じ POST /deploy 経路。in-flight 状態だけ分けて表示する。
  const [bulkInFlight, setBulkInFlight] = useState<
    "deploy" | "teardown" | "retry-failed" | "redeploy" | null
  >(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleInFlight, setScheduleInFlight] = useState<"now" | "scheduled" | null>(null);
  // #536: 終了予約 modal の state (= 開始 modal と独立)
  const [endsAtModalOpen, setEndsAtModalOpen] = useState(false);
  const [endsAtDate, setEndsAtDate] = useState("");
  const [endsAtTime, setEndsAtTime] = useState("");
  const [endsAtInFlight, setEndsAtInFlight] = useState(false);
  const [endInFlight, setEndInFlight] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // Issue #1038 P1 #9 follow-up: scoreboard freeze 分数の operator 編集 state
  const [freezeMinutesInput, setFreezeMinutesInput] = useState<string>("");
  const [freezeMinutesInFlight, setFreezeMinutesInFlight] = useState(false);
  // #708: TEARDOWN が ROLLBACK_COMPLETE な stack で stuck したときの operator rescue。
  const [confirmForceArchive, setConfirmForceArchive] = useState(false);
  const [forceArchiveInFlight, setForceArchiveInFlight] = useState(false);
  const [notifyModalOpen, setNotifyModalOpen] = useState(false);
  const [notifyJustSent, setNotifyJustSent] = useState(false);
  // #558: scoring lock/unlock の in-flight 状態。"lock" / "unlock" / null を持つ。
  const [scoringLockInFlight, setScoringLockInFlight] = useState<"lock" | "unlock" | null>(null);

  const eventIdValid = !!eventId && EVENT_ID_RE.test(eventId);

  // Issue #1068: deploy status の手動 reload button 用 in-flight flag。 自動 polling が
  // 止まる (= tab background / network 一時切断 / backend hang) ケースの fallback 経路。
  const [manualRefreshInFlight, setManualRefreshInFlight] = useState(false);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    try {
      // Issue #1038 P1 #7: operator が「どのチームがいつ加点 / 減点したか」 を一目で
      // 把握できるよう、 Event 詳細取得で全 team の score event timeline も同時に fetch する。
      const d = await getEvent(apiClient, eventId, { withScoreEvents: true });
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiClient, eventId, eventIdValid]);

  const manualRefresh = useCallback(async () => {
    if (manualRefreshInFlight) return;
    setManualRefreshInFlight(true);
    try {
      await refresh();
    } finally {
      setManualRefreshInFlight(false);
    }
  }, [manualRefreshInFlight, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!eventIdValid || !eventId) {
    return <Navigate to="/events" replace />;
  }

  const handleBulkDeploy = async (body: BulkDeployBody = {}) => {
    if (!apiClient || bulkInFlight) return;
    setBulkInFlight(
      body.retryFailedOnly ? "retry-failed" : body.forceRedeploy ? "redeploy" : "deploy",
    );
    setError(null);
    try {
      const res = await bulkDeployEvent(apiClient, eventId, body);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  const handleBulkTeardown = async () => {
    if (!apiClient || bulkInFlight) return;
    setBulkInFlight("teardown");
    setConfirmTeardown(false);
    setError(null);
    try {
      const res = await bulkTeardownEvent(apiClient, eventId);
      setBulkResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkInFlight(null);
    }
  };

  const handleStartNow = async () => {
    if (!apiClient || scheduleInFlight) return;
    setScheduleInFlight("now");
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { startNow: true });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleInFlight(null);
    }
  };

  const handleScheduledStart = async () => {
    if (!apiClient || scheduleInFlight) return;
    if (!scheduleDate || !scheduleTime) {
      setError(t("event_detail.error_date_time_required"));
      return;
    }
    // DatePicker は YYYY-MM-DD、TimeInput は HH:mm。秒は :00 固定で組む (operator UX が分精度想定)。
    const local = new Date(`${scheduleDate}T${scheduleTime}:00`);
    if (Number.isNaN(local.getTime())) {
      setError(t("event_detail.error_date_time_format"));
      return;
    }
    if (local.getTime() < Date.now() - 60_000) {
      setError(t("event_detail.error_startsat_past"));
      return;
    }
    setScheduleInFlight("scheduled");
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { startsAt: local.toISOString() });
      setScheduleModalOpen(false);
      setScheduleDate("");
      setScheduleTime("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleInFlight(null);
    }
  };

  // #536: 「日時を指定して終了」 modal の submit。endsAt を未来時刻で予約する。
  // 既存「Event を終了」 button (= POST /events/:id/end、status=ENDED 即遷移) とは別経路:
  // こちらは status は触らず HealthCheck の gate で時刻 gate するだけ (operator の負担減)。
  const handleScheduleEnd = async () => {
    if (!apiClient || endsAtInFlight) return;
    const validation = validateEndsAtInput(endsAtDate, endsAtTime, detail?.startsAt, Date.now());
    if (!validation.canSubmit || !validation.value) {
      setError(
        validation.errorKey ? t(validation.errorKey) : t("event_detail.error_endsat_required"),
      );
      return;
    }
    setEndsAtInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { endsAt: validation.value.toISOString() });
      setEndsAtModalOpen(false);
      setEndsAtDate("");
      setEndsAtTime("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEndsAtInFlight(false);
    }
  };

  const handleEndNowSchedule = async () => {
    if (!apiClient || endsAtInFlight) return;
    setEndsAtInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { endsAt: new Date(Date.now()).toISOString() });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEndsAtInFlight(false);
    }
  };

  // Issue #1038 P1 #9 follow-up: scoreboard freeze window (= 終了 N 分前から順位非公開) の
  // 分数を operator が変更する handler。 0=freeze 無効、 1〜180 が有効範囲。
  const handleSaveFreezeMinutes = async () => {
    if (!apiClient || freezeMinutesInFlight) return;
    const trimmed = freezeMinutesInput.trim();
    if (trimmed === "") {
      setError(t("event_detail.error_freeze_required"));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 180) {
      setError(t("event_detail.error_freeze_range"));
      return;
    }
    setFreezeMinutesInFlight(true);
    setError(null);
    try {
      await setEventSchedule(apiClient, eventId, { scoreboardFreezeMinutes: n });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFreezeMinutesInFlight(false);
    }
  };

  // #558: 採点を lock (= 表彰フェーズ、加点経路全停止)。
  //   - server side: READY / ENDED の event のみ受理 (= 409 not_lockable for other)
  //   - idempotent: 既に locked のときも 200 + idempotent=true
  const handleLockScoring = async () => {
    if (!apiClient || scoringLockInFlight) return;
    setScoringLockInFlight("lock");
    setError(null);
    try {
      await lockEventScoring(apiClient, eventId);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        setError(t("event_detail.error_lock_status"));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setScoringLockInFlight(null);
    }
  };

  const handleUnlockScoring = async () => {
    if (!apiClient || scoringLockInFlight) return;
    setScoringLockInFlight("unlock");
    setError(null);
    try {
      await unlockEventScoring(apiClient, eventId);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        setError(t("event_detail.error_unlock_status"));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setScoringLockInFlight(null);
    }
  };

  /**
   * #708: TEARDOWN で stuck している Event を operator 判断で ARCHIVED に倒す rescue。
   * backend の archive endpoint は TEARDOWN を allow しているので追加 API 不要。
   * 競技者 account 側に残る CFn stack (= ROLLBACK_COMPLETE 等) は別途競技者が手動削除する。
   */
  const handleForceArchive = async () => {
    if (!apiClient || forceArchiveInFlight) return;
    setForceArchiveInFlight(true);
    setConfirmForceArchive(false);
    setError(null);
    try {
      await archiveEvent(apiClient, eventId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setForceArchiveInFlight(false);
    }
  };

  const handleEndEvent = async () => {
    if (!apiClient || endInFlight) return;
    setEndInFlight(true);
    setConfirmEnd(false);
    setError(null);
    try {
      await endEvent(apiClient, eventId);
      await refresh();
    } catch (err) {
      // 409 not_endable: backend は body に `currentStatus` を載せているので、
      // どの status だったかを operator に伝える (= refresh 押せばいいのか、別操作が
      // 要るのかを判断しやすくする)。
      if (err instanceof ApiError && err.status === StatusCodes.CONFLICT) {
        const match = err.message.match(/"currentStatus"\s*:\s*"([A-Z_]+)"/);
        const current = match?.[1];
        setError(
          current
            ? t("event_detail.error_end_status_with_current", { current })
            : t("event_detail.error_end_status"),
        );
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEndInFlight(false);
    }
  };

  if (!detail && !error) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner /> {t("event_detail.loading_spinner")}
      </Box>
    );
  }

  // #531: 「今 operator が押すべき primary action」を 1 つだけ強調する。
  // wizard.primary が一致した button のみ variant=primary、それ以外は default。
  // 状態と一致しない button (= DRAFT で「即座に開始」など) は disabled で抑止する。
  const wizard = detail ? computeEventWizardState(detail, Date.now()) : null;

  // #555: FAILED 状態の deployment 件数を全 problem 横断で集計。> 0 なら
  // 「失敗分を再実行」 button を表示し、operator が部分 retry できるようにする (FR-3)。
  const failedCount = detail
    ? Object.values(detail.deploymentsByProblem).reduce(
        (acc, list) => acc + list.filter((d) => d.status === "FAILED").length,
        0,
      )
    : 0;
  const completeCount = detail
    ? Object.values(detail.deploymentsByProblem).reduce(
        (acc, list) => acc + list.filter((d) => d.status === "COMPLETE").length,
        0,
      )
    : 0;
  // Issue #999: deploy 中 / 完了 / 失敗を一目で見える進捗 panel を出す。 EventCreate 直後に
  // ユーザーが EventDetail に遷移してきた瞬間 「いま何が走っているか」 を即把握できるように、
  // 全 problem × team の deployment 行を横断集計して header 直下に ProgressBar を表示する。
  const inFlightCount = detail
    ? Object.values(detail.deploymentsByProblem).reduce(
        (acc, list) =>
          acc + list.filter((d) => d.status === "PENDING" || d.status === "IN_PROGRESS").length,
        0,
      )
    : 0;
  const totalDeployCount = detail
    ? Object.values(detail.deploymentsByProblem).reduce((acc, list) => acc + list.length, 0)
    : 0;
  const allDoneCount = completeCount + failedCount;
  const deployProgressPercent =
    totalDeployCount > 0 ? Math.round((allDoneCount / totalDeployCount) * 100) : 0;
  const endsAtValidation = validateEndsAtInput(
    endsAtDate,
    endsAtTime,
    detail?.startsAt,
    Date.now(),
  );
  const endsAtErrorText = endsAtValidation.errorKey ? t(endsAtValidation.errorKey) : undefined;
  const endsAtInvalid = endsAtErrorText !== undefined;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => navigate("/events")}>{t("event_detail.back_to_list")}</Button>
            <Button
              variant={wizard?.primary === "deploy" ? "primary" : "normal"}
              loading={bulkInFlight === "deploy"}
              disabled={
                !detail ||
                detail.problems.length === 0 ||
                detail.teams.length === 0 ||
                detail.status === "ENDED" ||
                detail.status === "TEARDOWN" ||
                detail.status === "ARCHIVED"
              }
              onClick={() => handleBulkDeploy()}
            >
              {t("event_detail.deploy_button")}
            </Button>
            {/* #555: FAILED の deployment がある場合のみ「失敗分を再実行」 button を出す
             *   (= 要件 FR-3「N 件失敗」の retry path)。同じ POST /deploy 経路を retryFailedOnly:
             *   true で呼ぶ。旧 FAILED 行は backend で DELETE → 新 PENDING で CREATE される。 */}
            {failedCount > 0 && (
              <Button
                loading={bulkInFlight === "retry-failed"}
                disabled={
                  !detail ||
                  detail.status === "ENDED" ||
                  detail.status === "TEARDOWN" ||
                  detail.status === "ARCHIVED" ||
                  bulkInFlight !== null
                }
                iconName="refresh"
                onClick={() => handleBulkDeploy({ retryFailedOnly: true })}
              >
                {t("event_detail.retry_failed", { count: failedCount })}
              </Button>
            )}
            {completeCount > 0 && (
              <Button
                loading={bulkInFlight === "redeploy"}
                disabled={
                  !detail ||
                  detail.status === "ENDED" ||
                  detail.status === "TEARDOWN" ||
                  detail.status === "ARCHIVED" ||
                  bulkInFlight !== null
                }
                iconName="refresh"
                onClick={() => handleBulkDeploy({ forceRedeploy: true })}
              >
                {t("event_detail.redeploy", { count: completeCount })}
              </Button>
            )}
            <Button
              loading={endInFlight}
              disabled={!detail || detail.status !== "READY"}
              onClick={() => setConfirmEnd(true)}
            >
              {t("event_detail.end_event")}
            </Button>
            {/* #558: 採点 lock/unlock — READY / ENDED の event でのみ表示 (= 表彰フェーズ
             *   用途)。現在 locked / unlocked で button label と loading 状態を分ける。 */}
            {detail && (detail.status === "READY" || detail.status === "ENDED") && (
              <Button
                loading={scoringLockInFlight !== null}
                disabled={!apiClient}
                onClick={detail.scoringLocked === true ? handleUnlockScoring : handleLockScoring}
              >
                {detail.scoringLocked === true
                  ? t("event_detail.scoring_unlock")
                  : t("event_detail.scoring_lock")}
              </Button>
            )}
            <Button
              variant={wizard?.primary === "delete" ? "primary" : "normal"}
              loading={bulkInFlight === "teardown"}
              disabled={!detail}
              onClick={() => setConfirmTeardown(true)}
            >
              {t("event_detail.delete_button")}
            </Button>
          </SpaceBetween>
        }
      >
        {detail?.name ?? t("event_detail.loading_title")}
      </Header>

      {/* #531: Wizard StepIndicator + CTA banner — 初見 operator が「次に何を押すか」を
       *   1 画面で分かるようにする。Step 表示は 5 段固定 (作成 → Deploy → 開始時刻設定 →
       *   競技中 → 終了)、CTA Alert は status 依存。primary button 表示は Header actions
       *   / Schedule Container の既存 button と variant 同期。 */}
      {wizard && (
        <Container>
          <SpaceBetween size="m">
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              {WIZARD_STEPS.map((step, i) => (
                <Fragment key={step.key}>
                  {i > 0 && (
                    <Box color="text-status-inactive" variant="small">
                      →
                    </Box>
                  )}
                  <Badge
                    color={
                      i < wizard.stepIndex ? "green" : i === wizard.stepIndex ? "blue" : "grey"
                    }
                  >
                    {i + 1}. {step.label}
                  </Badge>
                </Fragment>
              ))}
            </SpaceBetween>
            <Alert type={wizard.alertType} header={t("event_detail.next_action")}>
              {wizard.cta}
            </Alert>
            {detail?.status === "TEARDOWN" && (
              // #708: 子 deployment の DeleteStack が ROLLBACK_COMPLETE な stack で stuck
              // すると TEARDOWN のまま ARCHIVED に遷移しない問題への operator rescue。
              <Alert
                type="info"
                header={t("event_detail.rescue_header")}
                action={
                  <Button
                    loading={forceArchiveInFlight}
                    onClick={() => setConfirmForceArchive(true)}
                    data-testid="force-archive-button"
                  >
                    {t("event_detail.rescue_force_archive")}
                  </Button>
                }
              >
                {t("event_detail.rescue_body")}
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      )}

      {error && (
        <Alert type="error" header={t("event_detail.error_header")}>
          {error}
        </Alert>
      )}
      {bulkResult && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => setBulkResult(null)}
          header={t("event_detail.bulk_result_header")}
        >
          {t("event_detail.bulk_result_body", {
            enqueued: bulkResult.enqueued,
            skipped: bulkResult.skipped,
          })}
        </Alert>
      )}

      {/* Issue #999: 全 deploy の集約進捗。 EventCreate 直後 / Deploy 押下後にユーザーが
       *   迷子にならないように、 header 直下に常駐 (= 100% 完了 / 0 件はどちらも非表示)。 */}
      {totalDeployCount > 0 && (
        <Container
          header={
            <Header
              variant="h2"
              description={
                failedCount > 0
                  ? t("event_detail.deploy_progress_description_with_failed", {
                      total: totalDeployCount,
                      complete: completeCount,
                      inFlight: inFlightCount,
                      failed: failedCount,
                    })
                  : t("event_detail.deploy_progress_description", {
                      total: totalDeployCount,
                      complete: completeCount,
                      inFlight: inFlightCount,
                    })
              }
              actions={
                <Button
                  iconName="refresh"
                  loading={manualRefreshInFlight}
                  onClick={() => void manualRefresh()}
                  ariaLabel={t("event_detail.deploy_progress_reload_aria")}
                  data-testid="deploy-status-reload"
                >
                  {t("event_detail.deploy_progress_reload")}
                </Button>
              }
            >
              {t("event_detail.deploy_progress_header")}
            </Header>
          }
        >
          <ProgressBar
            value={deployProgressPercent}
            label={
              inFlightCount > 0
                ? t("event_detail.deploy_progress_in_flight", {
                    done: allDoneCount,
                    total: totalDeployCount,
                  })
                : failedCount > 0
                  ? t("event_detail.deploy_progress_complete_with_failed", { failed: failedCount })
                  : t("event_detail.deploy_progress_complete")
            }
            description={
              inFlightCount > 0
                ? t("event_detail.deploy_progress_in_flight_description")
                : failedCount > 0
                  ? t("event_detail.deploy_progress_failed_description")
                  : t("event_detail.deploy_progress_complete_description")
            }
            status={failedCount > 0 ? "error" : inFlightCount > 0 ? "in-progress" : "success"}
            additionalInfo={inFlightCount > 0 ? "auto polling" : undefined}
          />
        </Container>
      )}

      {detail && (
        <Container header={<Header variant="h2">{t("event_detail.event_summary_header")}</Header>}>
          <SpaceBetween size="m">
            {detail.scoringLocked === true && (
              <Alert
                type="warning"
                statusIconAriaLabel="scoring locked"
                header={t("event_detail.scoring_locked_header")}
              >
                {t("event_detail.scoring_locked_body")}
                {detail.scoringLockedAt &&
                  ` ${t("event_detail.scoring_locked_locked_at", { at: detail.scoringLockedAt })}`}
              </Alert>
            )}
            <ColumnLayout columns={4} variant="text-grid">
              <Field label={t("event_detail.field_status")}>
                <SpaceBetween direction="horizontal" size="xxs">
                  <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>
                  {detail.scoringLocked === true && (
                    <Badge color="red">{t("event_detail.scoring_locked_badge")}</Badge>
                  )}
                </SpaceBetween>
              </Field>
              <Field label={t("event_detail.field_team_count")}>{detail.teamCount}</Field>
              <Field label={t("event_detail.field_problem_count")}>{detail.problems.length}</Field>
              <Field label={t("event_detail.field_created_at")}>{detail.createdAt}</Field>
            </ColumnLayout>
          </SpaceBetween>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header variant="h2" description={t("event_detail.schedule_description")}>
              {t("event_detail.schedule_header")}
            </Header>
          }
        >
          <ColumnLayout columns={2} variant="text-grid">
            <Field label={t("event_detail.starts_at_label")}>
              <SpaceBetween size="xs">
                {detail.startsAt ? (
                  <code>{detail.startsAt}</code>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.starts_at_unset")}
                  </Box>
                )}
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => setScheduleModalOpen(true)}
                    disabled={!apiClient || scheduleInFlight !== null}
                  >
                    {t("event_detail.starts_at_pick")}
                  </Button>
                  <Button
                    variant={wizard?.primary === "start" ? "primary" : "normal"}
                    loading={scheduleInFlight === "now"}
                    disabled={!apiClient || scheduleInFlight === "scheduled"}
                    onClick={handleStartNow}
                  >
                    {t("event_detail.starts_at_now")}
                  </Button>
                </SpaceBetween>
              </SpaceBetween>
            </Field>
            {/* #536: 終了時刻 column (= 予約終了)。「Event を終了」 button (= 即終了) は
             *   Header actions に既存、こちらは未来時刻を予約する経路。両方とも endsAt
             *   field を書き、HealthCheck が `now >= endsAt` で gate を閉じる。 */}
            <Field label={t("event_detail.ends_at_label")}>
              <SpaceBetween size="xs">
                {detail.endsAt ? (
                  <code>{detail.endsAt}</code>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    {t("event_detail.ends_at_unset")}
                  </Box>
                )}
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => setEndsAtModalOpen(true)}
                    disabled={!apiClient || endsAtInFlight}
                  >
                    {t("event_detail.ends_at_pick")}
                  </Button>
                  <Button
                    loading={endsAtInFlight}
                    disabled={!apiClient}
                    onClick={handleEndNowSchedule}
                  >
                    {t("event_detail.ends_at_now")}
                  </Button>
                </SpaceBetween>
              </SpaceBetween>
            </Field>
          </ColumnLayout>
          <Box margin={{ top: "m" }}>
            <Field label={t("event_detail.scoring_status_label")}>{scoringBadge(detail, t)}</Field>
          </Box>
          <Box margin={{ top: "m" }}>
            <Field label={t("event_detail.freeze_label")}>
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box variant="small" color="text-status-inactive">
                  {detail.scoreboardFreezeMinutes !== undefined
                    ? t("event_detail.freeze_current_minutes", {
                        minutes: detail.scoreboardFreezeMinutes,
                      })
                    : t("event_detail.freeze_current_default")}
                </Box>
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder={t("event_detail.freeze_placeholder")}
                  value={freezeMinutesInput}
                  onChange={({ detail: d }) => setFreezeMinutesInput(d.value)}
                  disabled={freezeMinutesInFlight}
                />
                <Button
                  loading={freezeMinutesInFlight}
                  disabled={!apiClient || freezeMinutesInput.trim() === ""}
                  onClick={handleSaveFreezeMinutes}
                >
                  {t("event_detail.freeze_save")}
                </Button>
              </SpaceBetween>
            </Field>
          </Box>
        </Container>
      )}

      {/* #552: 通知の発見性を上げる専用 section。旧 UX では「通知を送る」 button が
       *   Header actions (= Deploy / Delete 等と同列) に埋もれており、初見 operator から
       *   見つけにくかった。説明文 + 単独 button にして「通知って何ができる?」が
       *   1 画面で完結するようにする。過去履歴 list は別 PR で (= GET endpoint が要る)。 */}
      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description={t("event_detail.notifications_description")}
              actions={
                <Button
                  variant="primary"
                  iconName="notification"
                  disabled={
                    detail.status === "DRAFT" ||
                    detail.status === "TEARDOWN" ||
                    detail.status === "ARCHIVED"
                  }
                  onClick={() => setNotifyModalOpen(true)}
                >
                  {t("event_detail.notifications_send")}
                </Button>
              }
            >
              {t("event_detail.notifications_header")}
            </Header>
          }
        >
          <SpaceBetween size="s">
            <Box variant="small" color="text-status-inactive">
              {t("event_detail.notifications_hint")}
            </Box>
            {detail.status === "DRAFT" && (
              <Alert type="info">{t("event_detail.notifications_draft_disabled")}</Alert>
            )}
            {(detail.status === "TEARDOWN" || detail.status === "ARCHIVED") && (
              <Alert type="info">
                {detail.status === "TEARDOWN"
                  ? t("event_detail.notifications_teardown_disabled_teardown")
                  : t("event_detail.notifications_teardown_disabled_archived")}
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header variant="h2" description={t("event_detail.problemset_description")}>
              {t("event_detail.problemset_header", { count: detail.problems.length })}
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={[...detail.problems]}
            columnDefinitions={[
              {
                id: "id",
                header: t("event_detail.problemset_col_id"),
                cell: (p) => <code>{p.problemId}</code>,
              },
              {
                id: "account",
                header: t("event_detail.problemset_col_account"),
                cell: (p) => p.defaultAwsAccountId,
              },
              {
                id: "region",
                header: t("event_detail.problemset_col_region"),
                cell: (p) => p.defaultRegion,
              },
              {
                id: "status",
                header: t("event_detail.problemset_col_status"),
                cell: (p) => renderProblemDeployStatus(detail.deploymentsByProblem[p.problemId], t),
              },
              {
                id: "jobs",
                header: t("event_detail.problemset_col_jobs"),
                cell: (p) => renderProblemJobLinks(detail.deploymentsByProblem[p.problemId]),
              },
            ]}
            empty={<Box>{t("event_detail.problemset_empty")}</Box>}
          />
        </Container>
      )}

      {detail?.scoreEventsByTeam && <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} />}

      {/* Issue #1071: 現在の順位 table。 score 推移 chart と同 data source、 backend 不要。 */}
      {detail?.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}

      {detail && (
        <ExpandableSection
          variant="container"
          defaultExpanded={
            // Issue #1072: 競技中以降は配布情報は基本不要。 DRAFT / DEPLOYING / READY (= 開始前)
            // のみ default expanded。 ENDED / TEARDOWN / ARCHIVED は collapsed (= operator が
            // 必要に応じて open)。
            detail.status === "DRAFT" || detail.status === "DEPLOYING" || detail.status === "READY"
          }
          headerText={t("event_detail.participants_header")}
        >
          <SpaceBetween size="m">
            {config.participantPortalUrl ? (
              <ColumnLayout columns={2} variant="text-grid">
                <Box>
                  <Box variant="awsui-key-label">{t("event_detail.participants_portal_url")}</Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <a href={config.participantPortalUrl} target="_blank" rel="noreferrer noopener">
                      <code>{config.participantPortalUrl}</code>
                    </a>
                    <Button
                      iconName="copy"
                      ariaLabel={t("event_detail.participants_copy_aria")}
                      onClick={() =>
                        void navigator.clipboard?.writeText(config.participantPortalUrl ?? "")
                      }
                    >
                      {t("event_detail.participants_copy")}
                    </Button>
                  </SpaceBetween>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">{t("event_detail.participants_steps_header")}</Box>
                  <Box variant="small">
                    1. {t("event_detail.participants_step_1")}
                    <br />
                    2. {t("event_detail.participants_step_2")}
                    <br />
                    3. {t("event_detail.participants_step_3")}
                    <br />
                    4. {t("event_detail.participants_step_4")}
                  </Box>
                </Box>
              </ColumnLayout>
            ) : (
              <Alert type="info" header={t("event_detail.participants_no_url_header")}>
                {t("event_detail.participants_no_url_body")}
              </Alert>
            )}
          </SpaceBetween>
        </ExpandableSection>
      )}

      {detail && (
        <ExpandableSection
          variant="container"
          defaultExpanded={
            // Issue #1072: チーム一覧 (= teamLoginKey 配布用) は競技開始前のみ default expanded。
            // 競技中 / 終了後は operator が必要に応じて open する。
            detail.status === "DRAFT" || detail.status === "DEPLOYING" || detail.status === "READY"
          }
          headerText={t("event_detail.teams_header", { count: detail.teams.length })}
          headerDescription={t("event_detail.teams_description")}
        >
          <Table
            variant="embedded"
            items={[...detail.teams]}
            columnDefinitions={[
              {
                id: "slug",
                header: t("event_detail.teams_col_slug"),
                cell: (tr) => <code>{tr.internalSlug}</code>,
              },
              {
                id: "displayName",
                header: t("event_detail.teams_col_display_name"),
                cell: (tr) =>
                  tr.displayName ?? (
                    <Box variant="small" color="text-status-inactive">
                      {t("event_detail.teams_col_display_name_unset")}
                    </Box>
                  ),
              },
              {
                id: "account",
                header: t("event_detail.teams_col_account"),
                cell: (tr) =>
                  tr.awsAccountId ? (
                    <code>{tr.awsAccountId}</code>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      {t("event_detail.teams_col_account_legacy")}
                    </Box>
                  ),
              },
              {
                id: "key",
                header: t("event_detail.teams_col_login_key"),
                cell: (tr) =>
                  tr.teamLoginKey ? (
                    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                      <Box variant="code" fontSize="body-s">
                        {tr.teamLoginKey}
                      </Box>
                      <Button
                        iconName="copy"
                        variant="inline-icon"
                        ariaLabel={t("event_detail.teams_col_login_key_aria", {
                          slug: tr.internalSlug,
                        })}
                        onClick={() => void navigator.clipboard?.writeText(tr.teamLoginKey ?? "")}
                      />
                    </SpaceBetween>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      {t("event_detail.teams_col_login_key_legacy")}
                    </Box>
                  ),
              },
            ]}
            empty={<Box>{t("event_detail.teams_empty")}</Box>}
          />
        </ExpandableSection>
      )}

      <Modal
        visible={confirmEnd}
        header={t("event_detail.modal_end_event_header")}
        onDismiss={() => setConfirmEnd(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmEnd(false)}>{t("event_detail.modal_cancel")}</Button>
              <Button variant="primary" onClick={handleEndEvent}>
                {t("event_detail.modal_end_event_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_end_event_body")}</Box>
          <Box variant="small" color="text-status-warning">
            {t("event_detail.modal_end_event_extra")}
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmForceArchive}
        header={t("event_detail.modal_force_archive_header")}
        onDismiss={() => setConfirmForceArchive(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmForceArchive(false)}>
                {t("event_detail.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={forceArchiveInFlight}
                onClick={handleForceArchive}
                data-testid="force-archive-confirm"
              >
                {t("event_detail.modal_force_archive_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_force_archive_body")}</Box>
          <Alert type="warning" header={t("event_detail.modal_force_archive_alert_header")}>
            {t("event_detail.modal_force_archive_alert_body")}
          </Alert>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmTeardown}
        header={t("event_detail.modal_teardown_header")}
        onDismiss={() => setConfirmTeardown(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmTeardown(false)}>
                {t("event_detail.modal_cancel")}
              </Button>
              <Button variant="primary" onClick={handleBulkTeardown}>
                {t("event_detail.modal_teardown_confirm")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_teardown_body")}</Box>
          <Box variant="small" color="text-status-warning">
            {t("event_detail.modal_teardown_extra")}
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={scheduleModalOpen}
        onDismiss={() => setScheduleModalOpen(false)}
        header={t("event_detail.modal_schedule_header")}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setScheduleModalOpen(false)}>
                {t("event_detail.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={scheduleInFlight === "scheduled"}
                onClick={handleScheduledStart}
              >
                {t("event_detail.modal_schedule_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_schedule_body")}</Box>
          <FormField label={t("event_detail.modal_date_label")}>
            <DatePicker
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
            />
          </FormField>
          <FormField label={t("event_detail.modal_time_label")}>
            <TimeInput
              value={scheduleTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setScheduleTime(e.detail.value)}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={endsAtModalOpen}
        onDismiss={() => setEndsAtModalOpen(false)}
        header={t("event_detail.modal_endsat_header")}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setEndsAtModalOpen(false)}>
                {t("event_detail.modal_cancel")}
              </Button>
              <Button
                variant="primary"
                loading={endsAtInFlight}
                disabled={!endsAtValidation.canSubmit || endsAtInFlight}
                onClick={handleScheduleEnd}
              >
                {t("event_detail.modal_schedule_confirm_label")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>{t("event_detail.modal_endsat_body")}</Box>
          {detail?.startsAt && (
            <Box variant="small" color="text-status-inactive">
              {t("event_detail.modal_endsat_starts_at_hint")}: <code>{detail.startsAt}</code>
            </Box>
          )}
          <FormField label={t("event_detail.modal_date_label")} errorText={endsAtErrorText}>
            <DatePicker
              value={endsAtDate}
              onChange={(e) => setEndsAtDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
              invalid={endsAtInvalid}
            />
          </FormField>
          <FormField label={t("event_detail.modal_time_label")} errorText={endsAtErrorText}>
            <TimeInput
              value={endsAtTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setEndsAtTime(e.detail.value)}
              invalid={endsAtInvalid}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      <SendNotificationModal
        config={config}
        visible={notifyModalOpen}
        eventId={eventId}
        onDismiss={() => setNotifyModalOpen(false)}
        onSuccess={() => {
          setNotifyModalOpen(false);
          setNotifyJustSent(true);
        }}
      />
      {notifyJustSent && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => setNotifyJustSent(false)}
          header={t("event_detail.notification_sent_header")}
        >
          {t("event_detail.notification_sent_body")}
        </Alert>
      )}
    </SpaceBetween>
  );
}

/**
 * Event の採点状況バッジ。 #1095: status / scoringLocked / 時刻の優先順位で分岐。
 *   1. scoringLocked → 「採点 lock 中」 (red)
 *   2. status === ENDED → 「終了」 (grey)
 *   3. status === ARCHIVED / TEARDOWN → 「終了」 (grey)
 *   4. !startsAt → 「未開始」 (grey)
 *   5. startsAt 未到達 → 「開始予定」 (blue)
 *   6. それ以外 → 「採点中」 (green)
 */
function scoringBadge(
  detail: Pick<EventDetail, "startsAt" | "status" | "scoringLocked">,
  t: (key: string) => string,
) {
  if (detail.scoringLocked === true)
    return <Badge color="red">{t("event_detail.scoring_badge_locked")}</Badge>;
  if (detail.status === "ENDED" || detail.status === "ARCHIVED" || detail.status === "TEARDOWN") {
    return <Badge color="grey">{t("event_detail.scoring_badge_ended")}</Badge>;
  }
  if (!detail.startsAt)
    return <Badge color="grey">{t("event_detail.scoring_badge_not_started")}</Badge>;
  if (new Date(detail.startsAt).getTime() > Date.now()) {
    return <Badge color="blue">{t("event_detail.scoring_badge_scheduled")}</Badge>;
  }
  return <Badge color="green">{t("event_detail.scoring_badge_active")}</Badge>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
