import Alert from "@cloudscape-design/components/alert";
import Badge from "@cloudscape-design/components/badge";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import DatePicker from "@cloudscape-design/components/date-picker";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Spinner from "@cloudscape-design/components/spinner";
import Table from "@cloudscape-design/components/table";
import TimeInput from "@cloudscape-design/components/time-input";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ApiError, useApiClient } from "../api/client";
import {
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
  setEventSchedule,
} from "../api/events-client";
import { SendNotificationModal } from "../components/SendNotificationModal";
import type { AppConfig } from "../config";

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
 * 1 problem 行の deploy job click-through link 列。各 jobId を /deployments/:jobId に
 * 飛ばす (= per-team の deploy 詳細ページ)。
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
    <SpaceBetween direction="horizontal" size="xxs">
      {deployments.map((d) => (
        <Link
          key={d.jobId}
          href={`/deployments/${encodeURIComponent(d.jobId)}`}
          ariaLabel={`Deploy job ${d.jobId} (status: ${d.status})`}
        >
          <Badge color={DEPLOY_STATUS_COLOR[d.status]}>{d.status}</Badge>
        </Link>
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

export function EventDetailPage({ config }: { config: AppConfig }) {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const apiClient = useApiClient(config);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [bulkInFlight, setBulkInFlight] = useState<"deploy" | "teardown" | null>(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduleInFlight, setScheduleInFlight] = useState<"now" | "scheduled" | null>(null);
  const [endInFlight, setEndInFlight] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [notifyModalOpen, setNotifyModalOpen] = useState(false);
  const [notifyJustSent, setNotifyJustSent] = useState(false);

  const eventIdValid = !!eventId && EVENT_ID_RE.test(eventId);

  const refresh = useCallback(async () => {
    if (!apiClient || !eventIdValid || !eventId) return;
    try {
      const d = await getEvent(apiClient, eventId);
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

  const handleBulkDeploy = async () => {
    if (!apiClient || bulkInFlight) return;
    setBulkInFlight("deploy");
    setError(null);
    try {
      const res = await bulkDeployEvent(apiClient, eventId);
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
      if (err instanceof ApiError && err.status === 409) {
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

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`Event ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => navigate("/events")}>一覧へ戻る</Button>
            <Button
              variant="primary"
              loading={bulkInFlight === "deploy"}
              disabled={
                !detail ||
                detail.problems.length === 0 ||
                detail.teams.length === 0 ||
                detail.status === "ENDED" ||
                detail.status === "TEARDOWN" ||
                detail.status === "ARCHIVED"
              }
              onClick={handleBulkDeploy}
            >
              Bulk Deploy
            </Button>
            <Button
              disabled={
                !detail ||
                detail.status === "DRAFT" ||
                detail.status === "TEARDOWN" ||
                detail.status === "ARCHIVED"
              }
              onClick={() => setNotifyModalOpen(true)}
            >
              通知を送る
            </Button>
            <Button
              loading={endInFlight}
              disabled={!detail || detail.status !== "READY"}
              onClick={() => setConfirmEnd(true)}
            >
              Event を終了
            </Button>
            <Button
              loading={bulkInFlight === "teardown"}
              disabled={!detail}
              onClick={() => setConfirmTeardown(true)}
            >
              Bulk Teardown
            </Button>
          </SpaceBetween>
        }
      >
        {detail?.name ?? "(loading)"}
      </Header>

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
          header="Bulk 操作 受付"
        >
          受付: {bulkResult.enqueued} 件 / skipped: {bulkResult.skipped} 件 (実 deploy / delete は
          State Machine が非同期に進めます。数分後に再読み込みしてください)
        </Alert>
      )}

      {detail && (
        <Container header={<Header variant="h2">Event 概要</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            <Field label="ステータス">
              <Badge color={STATUS_COLOR[detail.status]}>{detail.status}</Badge>
            </Field>
            <Field label="チーム数">{detail.teamCount}</Field>
            <Field label="問題数">{detail.problems.length}</Field>
            <Field label="作成">{detail.createdAt}</Field>
          </ColumnLayout>
        </Container>
      )}

      {detail && (
        <Container
          header={
            <Header
              variant="h2"
              description="競技開始時刻を指定するまで Health Check は probe / 採点を skip します (deploy 直後の誤加算を防ぎ、Lambda 呼出 / outbound 通信コストも抑制)。"
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => setScheduleModalOpen(true)}
                    disabled={!apiClient || scheduleInFlight !== null}
                  >
                    日時を指定して開始
                  </Button>
                  <Button
                    variant="primary"
                    loading={scheduleInFlight === "now"}
                    disabled={!apiClient || scheduleInFlight === "scheduled"}
                    onClick={handleStartNow}
                  >
                    即座に開始
                  </Button>
                </SpaceBetween>
              }
            >
              競技スケジュール
            </Header>
          }
        >
          <ColumnLayout columns={2} variant="text-grid">
            <Field label="開始時刻 (UTC)">
              {detail.startsAt ? (
                <code>{detail.startsAt}</code>
              ) : (
                <Box variant="small" color="text-status-inactive">
                  未設定 (採点停止中)
                </Box>
              )}
            </Field>
            <Field label="採点ステータス">{scoringBadge(detail.startsAt)}</Field>
          </ColumnLayout>
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
                    3. <strong>Bulk Deploy</strong> で全チームの問題環境を起動 (Status が READY
                    になったら競技開始)
                    <br />
                    4. 終了後は <strong>Bulk Teardown</strong> で全環境を一括削除
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
                id: "key",
                header: "teamLoginKey",
                cell: (t) =>
                  t.teamLoginKey ? (
                    <Box variant="code" fontSize="body-s">
                      {t.teamLoginKey}
                    </Box>
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
        visible={confirmTeardown}
        header="Bulk Teardown を実行しますか?"
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
