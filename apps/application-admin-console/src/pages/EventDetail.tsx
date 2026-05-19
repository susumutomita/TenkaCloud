import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import DatePicker from "@cloudscape-design/components/date-picker";
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
function renderProblemDeployStatus(deployments: readonly EventDeploymentSummary[] | undefined) {
  if (!deployments || deployments.length === 0) {
    return (
      <Box variant="small" color="text-status-inactive">
        未デプロイ
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
      {failed > 0 && <Badge color="red">FAILED {failed}</Badge>}
      {inFlight > 0 && <Badge color="blue">進行中 {inFlight}</Badge>}
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
  readonly errorText?: string;
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
    return { canSubmit: false, errorText: "終了日時の形式が不正です" };
  }
  if (value.getTime() < nowMs - 60_000) {
    return {
      canSubmit: false,
      errorText:
        "過去の日時は指定できません。今すぐ終了するには「Event を終了」 button を使ってください。",
    };
  }
  if (startsAt) {
    const startsAtMs = new Date(startsAt).getTime();
    if (Number.isFinite(startsAtMs) && value.getTime() <= startsAtMs) {
      return { canSubmit: false, errorText: "終了時刻は開始時刻より後の時刻を指定してください。" };
    }
  }
  return { canSubmit: true, value };
}

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
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
      setError("日付と時刻の両方を指定してください");
      return;
    }
    // DatePicker は YYYY-MM-DD、TimeInput は HH:mm。秒は :00 固定で組む (operator UX が分精度想定)。
    const local = new Date(`${scheduleDate}T${scheduleTime}:00`);
    if (Number.isNaN(local.getTime())) {
      setError("日時の形式が不正です");
      return;
    }
    // #537: 過去日時 reject (第一防衛線、frontend)。SLACK 60s で server 側と揃える。
    // 過去にしたいなら「即座に開始」 button を使うべき。
    if (local.getTime() < Date.now() - 60_000) {
      setError(
        "過去の日時は指定できません。即座に開始するには「即座に開始」 button を使ってください。",
      );
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
      setError(validation.errorText ?? "終了の日付と時刻の両方を指定してください");
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
      setError("freeze 分数を入力してください (0 で無効化、 1〜180 が有効範囲)");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 180) {
      setError("freeze 分数は 0〜180 の整数で指定してください");
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
        setError(
          "Event は READY / ENDED 状態でのみ採点を lock できます。現在 status を確認してください。",
        );
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
        setError("採点 lock の解除は READY / ENDED 状態でのみ可能です。");
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
            ? `Event は READY 状態でのみ終了できます (現在: ${current})`
            : "Event は READY 状態でのみ終了できます",
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
        <Spinner /> 読み込み中…
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
  const endsAtInvalid = endsAtValidation.errorText !== undefined;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => navigate("/events")}>一覧へ戻る</Button>
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
              Deploy
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
                失敗分を再実行 ({failedCount} 件)
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
                再デプロイ ({completeCount} 件)
              </Button>
            )}
            <Button
              loading={endInFlight}
              disabled={!detail || detail.status !== "READY"}
              onClick={() => setConfirmEnd(true)}
            >
              Event を終了
            </Button>
            {/* #558: 採点 lock/unlock — READY / ENDED の event でのみ表示 (= 表彰フェーズ
             *   用途)。現在 locked / unlocked で button label と loading 状態を分ける。 */}
            {detail && (detail.status === "READY" || detail.status === "ENDED") && (
              <Button
                loading={scoringLockInFlight !== null}
                disabled={!apiClient}
                onClick={detail.scoringLocked === true ? handleUnlockScoring : handleLockScoring}
              >
                {detail.scoringLocked === true ? "採点 lock を解除" : "採点を lock"}
              </Button>
            )}
            <Button
              variant={wizard?.primary === "delete" ? "primary" : "normal"}
              loading={bulkInFlight === "teardown"}
              disabled={!detail}
              onClick={() => setConfirmTeardown(true)}
            >
              Delete
            </Button>
          </SpaceBetween>
        }
      >
        {detail?.name ?? "(loading)"}
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
            <Alert type={wizard.alertType} header="次のアクション">
              {wizard.cta}
            </Alert>
            {detail?.status === "TEARDOWN" && (
              // #708: 子 deployment の DeleteStack が ROLLBACK_COMPLETE な stack で stuck
              // すると TEARDOWN のまま ARCHIVED に遷移しない問題への operator rescue。
              <Alert
                type="info"
                header="削除が進まない場合 (operator rescue)"
                action={
                  <Button
                    loading={forceArchiveInFlight}
                    onClick={() => setConfirmForceArchive(true)}
                    data-testid="force-archive-button"
                  >
                    Force ARCHIVED に倒す
                  </Button>
                }
              >
                競技者 account 側で stack が <code>ROLLBACK_COMPLETE</code> 等の状態のまま
                残っていると DeleteStack が no-op 扱いで進行せず、 Event が TEARDOWN のまま固まる
                ことがあります。 5 分以上動かない場合は競技者に
                <strong>CFn console で該当 stack の手動 Delete</strong> を依頼するか、 operator
                判断で本 Event を <strong>Force ARCHIVED</strong> に倒してください (= 該当
                deployment 行は DELETED に遷移済 / FAILED として扱われ、 Event view から 外れます)。
                物理 stack は別途競技者の手動削除が必要なので注意。
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      )}

      {error && (
        <Alert type="error" header="エラー">
          {error}
        </Alert>
      )}
      {bulkResult && (
        <Alert
          type="success"
          dismissible
          onDismiss={() => setBulkResult(null)}
          header="Deploy / Delete 受付"
        >
          受付: {bulkResult.enqueued} 件 / skipped: {bulkResult.skipped} 件 (実 deploy / delete は
          State Machine が非同期に進めます。数分後に再読み込みしてください)
        </Alert>
      )}

      {/* Issue #999: 全 deploy の集約進捗。 EventCreate 直後 / Deploy 押下後にユーザーが
       *   迷子にならないように、 header 直下に常駐 (= 100% 完了 / 0 件はどちらも非表示)。 */}
      {totalDeployCount > 0 && (
        <Container
          header={
            <Header
              variant="h2"
              description={`${totalDeployCount} 件中 完了 ${completeCount} / 進行中 ${inFlightCount}${failedCount > 0 ? ` / 失敗 ${failedCount}` : ""}`}
            >
              Deploy 進捗
            </Header>
          }
        >
          <ProgressBar
            value={deployProgressPercent}
            label={
              inFlightCount > 0
                ? `Deploy 進行中… (${allDoneCount} / ${totalDeployCount})`
                : failedCount > 0
                  ? `完了 (失敗 ${failedCount} 件あり)`
                  : "Deploy 完了"
            }
            description={
              inFlightCount > 0
                ? "deploy は State Machine が非同期に進めます。 数分かかります。"
                : failedCount > 0
                  ? "失敗 deployment は 「失敗分を再実行」 button で個別 retry できます。"
                  : "全 deploy が完了しました。 競技開始の準備ができています。"
            }
            status={failedCount > 0 ? "error" : inFlightCount > 0 ? "in-progress" : "success"}
            additionalInfo={inFlightCount > 0 ? "auto polling" : undefined}
          />
        </Container>
      )}

      {detail && (
        <Container header={<Header variant="h2">Event 概要</Header>}>
          <SpaceBetween size="m">
            {/* #558: 採点 lock 中の警告 banner (= 全体に視覚的に強く出す)。表彰フェーズの
             *   競技者 / operator 双方への明示的通知。unlock するまで lock 中であることが
             *   一目で分かるよう dismissible は付けない。 */}
            {detail.scoringLocked === true && (
              <Alert
                type="warning"
                statusIconAriaLabel="scoring locked"
                header="採点 lock 中 (表彰フェーズ)"
              >
                加点経路 (flag 提出 / HealthCheck uptime) は全停止しています。leaderboard / score
                events の閲覧は可能です。
                {detail.scoringLockedAt && ` Locked at: ${detail.scoringLockedAt}`}
              </Alert>
            )}
            <ColumnLayout columns={4} variant="text-grid">
              <Field label="ステータス">
                <SpaceBetween direction="horizontal" size="xxs">
                  <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>
                  {detail.scoringLocked === true && <Badge color="red">SCORING LOCKED</Badge>}
                </SpaceBetween>
              </Field>
              <Field label="チーム数">{detail.teamCount}</Field>
              <Field label="問題数">{detail.problems.length}</Field>
              <Field label="作成">{detail.createdAt}</Field>
            </ColumnLayout>
          </SpaceBetween>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="開始時刻を指定すると HealthCheck が probe / 採点を開始、終了時刻を指定すると status は変えずに採点 gate を閉じます。"
            >
              競技スケジュール
            </Header>
          }
        >
          <ColumnLayout columns={2} variant="text-grid">
            <Field label="開始時刻 (UTC)">
              <SpaceBetween size="xs">
                {detail.startsAt ? (
                  <code>{detail.startsAt}</code>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    未設定 (採点停止中)
                  </Box>
                )}
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => setScheduleModalOpen(true)}
                    disabled={!apiClient || scheduleInFlight !== null}
                  >
                    日時を指定して開始
                  </Button>
                  <Button
                    variant={wizard?.primary === "start" ? "primary" : "normal"}
                    loading={scheduleInFlight === "now"}
                    disabled={!apiClient || scheduleInFlight === "scheduled"}
                    onClick={handleStartNow}
                  >
                    即座に開始
                  </Button>
                </SpaceBetween>
              </SpaceBetween>
            </Field>
            {/* #536: 終了時刻 column (= 予約終了)。「Event を終了」 button (= 即終了) は
             *   Header actions に既存、こちらは未来時刻を予約する経路。両方とも endsAt
             *   field を書き、HealthCheck が `now >= endsAt` で gate を閉じる。 */}
            <Field label="終了時刻 (UTC)">
              <SpaceBetween size="xs">
                {detail.endsAt ? (
                  <code>{detail.endsAt}</code>
                ) : (
                  <Box variant="small" color="text-status-inactive">
                    未設定 (= 手動「Event を終了」まで採点継続)
                  </Box>
                )}
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => setEndsAtModalOpen(true)}
                    disabled={!apiClient || endsAtInFlight}
                  >
                    日時を指定して終了
                  </Button>
                  <Button
                    loading={endsAtInFlight}
                    disabled={!apiClient}
                    onClick={handleEndNowSchedule}
                  >
                    即座に終了
                  </Button>
                </SpaceBetween>
              </SpaceBetween>
            </Field>
          </ColumnLayout>
          <Box margin={{ top: "m" }}>
            <Field label="採点ステータス">{scoringBadge(detail.startsAt)}</Field>
          </Box>
          {/* Issue #1038 P1 #9 follow-up: scoreboard freeze 分数 (= 終了 N 分前から順位非公開) */}
          <Box margin={{ top: "m" }}>
            <Field label="Scoreboard freeze 分数 (= 終了 N 分前から順位を隠す、 0 で無効)">
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Box variant="small" color="text-status-inactive">
                  現在:{" "}
                  {detail.scoreboardFreezeMinutes !== undefined
                    ? `${detail.scoreboardFreezeMinutes} 分`
                    : "default 30 分"}
                </Box>
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder="0〜180"
                  value={freezeMinutesInput}
                  onChange={({ detail: d }) => setFreezeMinutesInput(d.value)}
                  disabled={freezeMinutesInFlight}
                />
                <Button
                  loading={freezeMinutesInFlight}
                  disabled={!apiClient || freezeMinutesInput.trim() === ""}
                  onClick={handleSaveFreezeMinutes}
                >
                  保存
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
              description="競技中の全チームの Participant Portal にアナウンスを送ります。Portal の Notifications page に表示され、競技者は赤バッジで未読件数を確認できます。"
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
                  通知を送る
                </Button>
              }
            >
              通知 (お知らせ)
            </Header>
          }
        >
          <SpaceBetween size="s">
            <Box variant="small" color="text-status-inactive">
              送信タイミング例: 「競技開始 5 分前」「Battle で攻撃検知が増えた」「問題ファイルに
              typo があった」など。 送信内容は競技者全員に同時配信されます (=
              チーム選択は不可、ADR-006)。
            </Box>
            {detail.status === "DRAFT" && (
              <Alert type="info">
                Event 作成直後 (DRAFT) は通知できません。Deploy 後に有効化されます。
              </Alert>
            )}
            {(detail.status === "TEARDOWN" || detail.status === "ARCHIVED") && (
              <Alert type="info">
                {detail.status === "TEARDOWN" ? "削除中" : "アーカイブ済"} の Event
                には通知できません。
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="このイベントで使う問題と、各問題の deploy 先 (account / region)"
            >
              問題セット ({detail.problems.length} 問)
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={[...detail.problems]}
            columnDefinitions={[
              { id: "id", header: "Problem ID", cell: (p) => <code>{p.problemId}</code> },
              { id: "account", header: "Default AWS Account", cell: (p) => p.defaultAwsAccountId },
              { id: "region", header: "Default Region", cell: (p) => p.defaultRegion },
              {
                id: "status",
                header: "Deploy Status",
                cell: (p) => renderProblemDeployStatus(detail.deploymentsByProblem[p.problemId]),
              },
              {
                id: "jobs",
                header: "Job Links",
                cell: (p) => renderProblemJobLinks(detail.deploymentsByProblem[p.problemId]),
              },
            ]}
            empty={<Box>未設定 — Event 編集 (Phase 2c+) で追加できる予定</Box>}
          />
        </Container>
      )}

      {detail?.scoreEventsByTeam && <TeamScoreEventsPanel teams={detail.scoreEventsByTeam} />}

      {/* Issue #1071: 現在の順位 table。 score 推移 chart と同 data source、 backend 不要。 */}
      {detail?.scoreEventsByTeam && <TeamRankingPanel teams={detail.scoreEventsByTeam} />}

      {detail && (
        <Container header={<Header variant="h2">参加者向け配布</Header>}>
          <SpaceBetween size="m">
            {config.participantPortalUrl ? (
              <ColumnLayout columns={2} variant="text-grid">
                <Box>
                  <Box variant="awsui-key-label">Participant Portal URL</Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <a href={config.participantPortalUrl} target="_blank" rel="noreferrer noopener">
                      <code>{config.participantPortalUrl}</code>
                    </a>
                    <Button
                      iconName="copy"
                      ariaLabel="Portal URL をコピー"
                      onClick={() =>
                        void navigator.clipboard?.writeText(config.participantPortalUrl ?? "")
                      }
                    >
                      コピー
                    </Button>
                  </SpaceBetween>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">配布手順</Box>
                  <Box variant="small">
                    1. 下のチーム表から各 team の <code>teamLoginKey</code> をコピー
                    <br />
                    2. 上の Portal URL と一緒に各チームへ共有
                    <br />
                    3. <strong>Deploy</strong> で全チームの問題環境を起動 (Status が READY
                    になったら競技開始)
                    <br />
                    4. 終了後は <strong>Delete</strong> で全環境を一括削除
                  </Box>
                </Box>
              </ColumnLayout>
            ) : (
              <Alert type="info" header="Participant Portal URL 未注入">
                runtime-config.json に <code>participantPortalUrl</code> が無いため URL を表示
                できません。ProblemDeployBackendStack の <code>ParticipantPortalUrl</code> Output を
                application-admin-console hosting に注入する CDK 改修が必要です。 URL は{" "}
                <code>
                  aws cloudformation describe-stacks --stack-name tenkacloud-problem-deploy
                </code>{" "}
                で取得できます。
              </Alert>
            )}
          </SpaceBetween>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="teamLoginKey は競技者に配布する Bearer 認証キーです。漏洩した場合は該当チームの環境を再 deploy してキーを更新してください。"
            >
              チーム ({detail.teams.length})
            </Header>
          }
        >
          <Table
            variant="embedded"
            items={[...detail.teams]}
            columnDefinitions={[
              { id: "slug", header: "Internal Slug", cell: (t) => <code>{t.internalSlug}</code> },
              {
                id: "displayName",
                header: "表示名 (競技者選択)",
                cell: (t) =>
                  t.displayName ?? (
                    <Box variant="small" color="text-status-inactive">
                      (未設定)
                    </Box>
                  ),
              },
              {
                // #528: team 単位の deploy 先 AWS Account ID。旧 Event は undefined。
                id: "account",
                header: "AWS Account ID",
                cell: (t) =>
                  t.awsAccountId ? (
                    <code>{t.awsAccountId}</code>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      (旧 Event: problem 既定値を使用)
                    </Box>
                  ),
              },
              {
                id: "key",
                header: "teamLoginKey",
                // #554: copy button を併設して text 選択 + Ctrl-C より早く配布できるように。
                // Cloudscape Button の iconName="copy" + ariaLabel で a11y も担保。
                cell: (t) =>
                  t.teamLoginKey ? (
                    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                      <Box variant="code" fontSize="body-s">
                        {t.teamLoginKey}
                      </Box>
                      <Button
                        iconName="copy"
                        variant="inline-icon"
                        ariaLabel={`${t.internalSlug} の teamLoginKey をコピー`}
                        onClick={() => void navigator.clipboard?.writeText(t.teamLoginKey ?? "")}
                      />
                    </SpaceBetween>
                  ) : (
                    <Box variant="small" color="text-status-inactive">
                      (詳細で再表示可)
                    </Box>
                  ),
              },
            ]}
            empty={<Box>チームがありません</Box>}
          />
        </Container>
      )}

      <Modal
        visible={confirmEnd}
        header="Event を終了しますか?"
        onDismiss={() => setConfirmEnd(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmEnd(false)}>キャンセル</Button>
              <Button variant="primary" onClick={handleEndEvent}>
                終了
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            Event を <code>ENDED</code> に遷移し、HealthCheck の採点を停止します (deployment
            は残るので Bulk Teardown は別途必要)。
          </Box>
          <Box variant="small" color="text-status-warning">
            ENDED 状態から READY に戻すことはできません。再開するには Event を作り直して下さい。
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmForceArchive}
        header="Event を Force ARCHIVED に倒しますか?"
        onDismiss={() => setConfirmForceArchive(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmForceArchive(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={forceArchiveInFlight}
                onClick={handleForceArchive}
                data-testid="force-archive-confirm"
              >
                Force ARCHIVED 実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            Event を <code>ARCHIVED</code> に遷移し、 一覧の default view から外します。
          </Box>
          <Alert type="warning" header="物理 stack は別途競技者の手動削除が必要">
            本 button は <strong>DDB の Event row を ARCHIVED に倒すだけ</strong> です。 競技者
            account に残った <code>ROLLBACK_COMPLETE</code> 等の CFn stack は競技者が CFn console
            で手動 Delete する必要があります。 競技者へ事前に依頼してから実行してください。
          </Alert>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={confirmTeardown}
        header="Event 全 deployment を削除しますか?"
        onDismiss={() => setConfirmTeardown(false)}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setConfirmTeardown(false)}>キャンセル</Button>
              <Button variant="primary" onClick={handleBulkTeardown}>
                実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            このイベント配下の全 deployment を <code>DELETING</code> 状態に倒し、CFn DeleteStack
            を非同期実行します。teams × problems の組み合わせ全てが対象です。
          </Box>
          <Box variant="small" color="text-status-warning">
            既に DELETING / DELETED な行は idempotent で skip されます。Phase 3+ で
            「失敗した行のみ再試行」を追加予定です。
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={scheduleModalOpen}
        onDismiss={() => setScheduleModalOpen(false)}
        header="競技開始日時を指定"
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setScheduleModalOpen(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={scheduleInFlight === "scheduled"}
                onClick={handleScheduledStart}
              >
                設定
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            指定時刻を超えると HealthCheck が採点を開始します。ブラウザのローカル時刻で入力した値を
            UTC に変換して保存します (分精度)。
          </Box>
          <FormField label="日付 (YYYY-MM-DD)">
            <DatePicker
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
            />
          </FormField>
          <FormField label="時刻 (HH:mm)">
            <TimeInput
              value={scheduleTime}
              format="hh:mm"
              placeholder="hh:mm"
              onChange={(e) => setScheduleTime(e.detail.value)}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* #536: 競技終了予約 modal。開始 modal とは独立 (= 単一目的の方が初見でも分かる)。
       *   未来時刻のみ受理、past_ends_at / ends_before_starts は backend で第二防衛線。 */}
      <Modal
        visible={endsAtModalOpen}
        onDismiss={() => setEndsAtModalOpen(false)}
        header="競技終了日時を指定 (予約)"
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setEndsAtModalOpen(false)}>キャンセル</Button>
              <Button
                variant="primary"
                loading={endsAtInFlight}
                disabled={!endsAtValidation.canSubmit || endsAtInFlight}
                onClick={handleScheduleEnd}
              >
                設定
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box>
            指定時刻を超えると HealthCheck が採点を停止します。「Event を終了」 button (= 即時)
            と違い、status は READY のまま (= operator は手動で「Event を終了」
            を押す必要なし)。ブラウザのローカル時刻で入力した値を UTC に変換します (分精度)。
          </Box>
          {detail?.startsAt && (
            <Box variant="small" color="text-status-inactive">
              開始時刻: <code>{detail.startsAt}</code>
            </Box>
          )}
          <FormField label="日付 (YYYY-MM-DD)" errorText={endsAtValidation.errorText}>
            <DatePicker
              value={endsAtDate}
              onChange={(e) => setEndsAtDate(e.detail.value)}
              placeholder="YYYY/MM/DD"
              invalid={endsAtInvalid}
            />
          </FormField>
          <FormField label="時刻 (HH:mm)" errorText={endsAtValidation.errorText}>
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
          header="通知を送信しました"
        >
          競技者の Participant Portal /notifications で 60 秒以内に表示されます。
        </Alert>
      )}
    </SpaceBetween>
  );
}

/**
 * Event の採点状況バッジ。3 分岐: 未設定 / 開始予定 / 採点中。
 * 時刻判定は新しいレンダ時の `Date.now()` を使うので polling refresh で自然に更新される。
 */
function scoringBadge(startsAt: string | undefined) {
  if (!startsAt) return <Badge color="grey">未開始</Badge>;
  if (new Date(startsAt).getTime() > Date.now()) return <Badge color="blue">開始予定</Badge>;
  return <Badge color="green">採点中</Badge>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <div>{children}</div>
    </div>
  );
}
