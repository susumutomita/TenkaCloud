import type { MultiselectProps, SelectProps } from "@cloudscape-design/components";
import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Form from "@cloudscape-design/components/form";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { canMutateTenant, useApiClient } from "../api/client";
import { bulkDeployEvent, type CreateEventResponse, createEvent } from "../api/events-client";
import type { AppConfig } from "../config";
import { DEFAULT_AWS_REGION } from "../data/aws-regions";
import { listProblemSummaries, type ProblemSummary, runtimeProviders } from "../data/problems";
import { useT } from "../i18n";
import { filterVerifiedAccounts } from "../lib/competitor-accounts-filter";
import { liteDrillCheckpointCode, markLiteDrillCheckpointShown } from "../lib/lite-drill";
import { EventCreateAccountsAlerts } from "./event-create/EventCreateAccountsAlerts";
import { EventCreateBasicInfoSection } from "./event-create/EventCreateBasicInfoSection";
import { EventCreateDeployPromptModal } from "./event-create/EventCreateDeployPromptModal";
import { EventCreateProblemsetSection } from "./event-create/EventCreateProblemsetSection";
import { EventCreateTeamsSection } from "./event-create/EventCreateTeamsSection";
import {
  buildVerifiedAccountOption,
  INITIAL_TEAM_COUNT,
  NAME_MAX,
  type ProblemRow,
  resizeTeamRows,
  resolveEventProviderMode,
  TEAMS_MAX,
  TEAMS_MIN,
  type TeamRow,
  validateTeamRows,
} from "./event-create/helpers";
import { useCompetitorAccountsLoader } from "./event-create/useCompetitorAccountsLoader";

// 既存テストが `from "./EventCreate"` で import している pure helpers / 型は
// 後方互換のため re-export する。 Issue #1241 の分割は API breaking でないことが要件。
export {
  buildVerifiedAccountOption,
  formatVerifiedAccountSummary,
  parseTeamCountInput,
  resizeTeamRows,
  resolveEventProviderMode,
  resolveInitialRegion,
  resolveRegionOptions,
  validateTeamRows,
} from "./event-create/helpers";

function newProblemRow(meta: ProblemSummary, problemId: string): ProblemRow {
  const runtimeFields =
    "provider" in meta.runtime
      ? { runtimeProvider: meta.runtime.provider }
      : { composite: true, runtimeProviders: runtimeProviders(meta.runtime) };
  return {
    problemId,
    problemName: meta.name,
    defaultRegion: meta.defaultRegion ?? DEFAULT_AWS_REGION.code,
    ...runtimeFields,
    ...(meta.costEstimate ? { costEstimate: meta.costEstimate } : {}),
    ...(meta.supportedRegions ? { supportedRegions: meta.supportedRegions } : {}),
  };
}

/**
 * Event 作成 form。
 *
 * 入力:
 *   - Event 名 (1〜120 文字)
 *   - チーム数 (1〜99) を変えると Teams table の行が動的に増減
 *   - **Teams table** (#528): 各 team の internalSlug + AWS Account ID を入力
 *   - 問題セット (`Multiselect`) — 各問題ごとに deploy region を選ぶ (account は team 単位)
 *
 * teamLoginKey is returned only by createEvent. The success modal keeps that
 * response in React state long enough for the operator to copy it, then drops
 * it on navigation; it is never written to browser storage.
 *
 * Issue #1241: section components (`event-create/*`) に分割。 このファイルは
 * state / handler / 子 section への配線だけを担う orchestrator。
 */
export function EventCreatePage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const navigate = useNavigate();
  const t = useT();

  // 問題 option 化 (#1414 の disabled 出し分け) と検索 / filter (#1776) は
  // EventCreateProblemsetSection 側の責務。 ここは catalog 全件を渡すだけ。
  const allProblems = useMemo(() => listProblemSummaries(), []);

  // Phase 2.2 (Issue #459): verified=true な CompetitorAccounts のみを Select の選択肢にする。
  // fetch + window focus 再取得は hook に切り出し済 (Issue #1241)。
  const { competitorAccounts, accountsLoadError, accountsLoading, fetchAccounts } =
    useCompetitorAccountsLoader(config);

  const verifiedAccounts = useMemo(
    () => filterVerifiedAccounts(competitorAccounts),
    [competitorAccounts],
  );
  const noVerifiedAccounts = competitorAccounts !== null && verifiedAccounts.length === 0;
  const showNoVerifiedAccountsHint = noVerifiedAccounts && !accountsLoadError;
  const accountOptions: SelectProps.Option[] = useMemo(
    () => verifiedAccounts.map((a) => buildVerifiedAccountOption(a)),
    [verifiedAccounts],
  );
  const accountById = useMemo(
    () => new Map(verifiedAccounts.map((a) => [a.awsAccountId, a])),
    [verifiedAccounts],
  );

  const [name, setName] = useState("");
  // チーム数を変えると teamRows が動的に伸縮 (= 初期 INITIAL_TEAM_COUNT 行)。
  const [teamRows, setTeamRows] = useState<TeamRow[]>(() =>
    Array.from({ length: INITIAL_TEAM_COUNT }, (_, i) => ({
      internalSlug: `team-${i + 1}`,
      awsAccountId: "",
      nonAwsCredentialTeamSlug: `team-${i + 1}`,
    })),
  );
  const [selectedProblems, setSelectedProblems] = useState<readonly MultiselectProps.Option[]>([]);
  const [problemRows, setProblemRows] = useState<ProblemRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** チーム数の Input 変更で teamRows を伸縮。同数なら same-reference を返して
   *  無駄な再 render を防ぐ。減るとき末尾捨て、増えるとき新 row 追加。 */
  const handleTeamCountChange = useCallback((next: number) => {
    setTeamRows((prev) => resizeTeamRows(prev, next));
  }, []);

  const updateTeamRow = useCallback((idx: number, patch: Partial<TeamRow>) => {
    setTeamRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);

  // Multiselect 変更時は problemRows を sync (既存行は値保持、新規分は default region)。
  const onProblemsChange = useCallback(
    (next: readonly MultiselectProps.Option[]) => {
      setSelectedProblems(next);
      setProblemRows((prev) => {
        const byId = new Map(prev.map((r) => [r.problemId, r]));
        return next
          .filter((o): o is MultiselectProps.Option & { value: string } => !!o.value)
          .map((opt) => {
            const existing = byId.get(opt.value);
            if (existing) return existing;
            const meta = allProblems.find((p) => p.id === opt.value);
            // selected options are built from this exact catalog, so a miss is unreachable.
            /* v8 ignore next */
            if (!meta) throw new Error(`selected problem is missing from catalog: ${opt.value}`);
            return newProblemRow(meta, opt.value);
          });
      });
    },
    [allProblems],
  );

  const updateProblemRow = useCallback((problemId: string, patch: Partial<ProblemRow>) => {
    setProblemRows((rows) => rows.map((r) => (r.problemId === problemId ? { ...r, ...patch } : r)));
  }, []);

  // teamRows ベースの validation を 1 pass に集約 (= 4 つ .every() / IIFE を回す代わり)。
  // teamRows 変更時のみ再評価され、render path の負担を減らす。
  const providerMode = useMemo(() => resolveEventProviderMode(problemRows), [problemRows]);
  const teamValidation = useMemo(
    () => validateTeamRows(teamRows, providerMode),
    [teamRows, providerMode],
  );
  // Table の items に渡す配列を teamRows ベースで memo 化。Cloudscape Table は items の
  // shallow identity で再 render 判定するので、毎 render 新 array を渡すと無駄に重い
  // (= 99 行 × 2 column の Input が全部 reconcile される)。
  const teamTableItems = useMemo(() => teamRows.map((tr, i) => ({ ...tr, idx: i })), [teamRows]);
  const teamCountInvalid = teamRows.length < TEAMS_MIN || teamRows.length > TEAMS_MAX;
  const nameInvalid = name.length === 0 || name.length > NAME_MAX;
  const canSubmit =
    !!apiClient &&
    canMutate &&
    !submitting &&
    !nameInvalid &&
    !teamCountInvalid &&
    problemRows.length > 0 &&
    teamValidation.allSlugsValid &&
    teamValidation.allAccountsValid &&
    teamValidation.allNonAwsCredentialSlugsValid &&
    teamValidation.providerMode?.kind !== "mixed" &&
    !teamValidation.hasDuplicateSlug;

  // Issue #1067: 作成成功後、 EventDetail へ自動遷移する前に 「Deploy する? あとで?」 modal を出す。
  // 旧挙動は即遷移だったが、 「Deploy が必要」 と operator が気付かないまま放置されるケースが
  // 多発していた (= participant 側で問題が見えない silent failure)。 modal で明示促す。
  const [deployPromptTarget, setDeployPromptTarget] = useState<{
    eventId: string;
    teams: CreateEventResponse["teams"];
    // [Issue #3169] Kept alongside the login keys because it has the same
    // one-shot character: this modal is the last screen before the operator
    // leaves the creation flow, and a warning dropped here is a deploy that
    // gets refused later for a reason nobody was told about.
    warnings: readonly string[];
  } | null>(null);
  const [deployStarting, setDeployStarting] = useState(false);

  // Issue #2696: Lite mode でだけ 「初回イベント作成」 ドリルのチェックポイントを出す。
  // 一度表示したら二度と出さない (2026-07-21) — 毎回の event 作成で再表示されていたため。
  // 表示可否の判定は deployPromptTarget が立った瞬間に 1 回だけ effect 内で行い、 結果を
  // local state に固定する。 modal 表示中の再 render (例: handleDeployNow の
  // setDeployStarting) で liteDrillCheckpointCode() を呼び直すと、 既に「表示済み」
  // 判定が効いて modal が開いたまま Alert だけ消えてしまうため (CompetitorAccountsPage
  // と同じ race)。
  const [revealedFirstEventDrillCode, setRevealedFirstEventDrillCode] = useState<
    string | undefined
  >(undefined);
  useEffect(() => {
    if (!deployPromptTarget) return;
    const code = liteDrillCheckpointCode(config, "firstEventCreated");
    if (code) {
      setRevealedFirstEventDrillCode(code);
      markLiteDrillCheckpointShown("firstEventCreated");
    }
  }, [deployPromptTarget, config]);

  const handleSubmit = async () => {
    // submit button は disabled={!canSubmit} なので canSubmit 偽では発火し得ず、 canSubmit 真なら
    // apiClient は非 null (canSubmit に含む)。 = この guard の return は UI 経路では不到達 (防御)。
    /* v8 ignore next */
    if (!canSubmit || !apiClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createEvent(apiClient, {
        name,
        teams: teamRows.map((tr) => ({
          internalSlug: tr.internalSlug,
          ...(providerMode.kind === "aws" ||
          (providerMode.kind === "composite" && providerMode.providers.includes("aws"))
            ? { awsAccountId: tr.awsAccountId }
            : {}),
          ...(providerMode.kind === "nonAws" ||
          (providerMode.kind === "composite" && providerMode.providers.some((p) => p !== "aws"))
            ? { nonAwsCredentialTeamSlug: tr.nonAwsCredentialTeamSlug }
            : {}),
        })),
        problems: problemRows.map((r) => ({
          problemId: r.problemId,
          defaultRegion: r.defaultRegion,
        })),
      });
      // Issue #1067: 即 navigate せず deploy 促し modal を出す。
      setDeployPromptTarget({
        eventId: res.eventId,
        teams: res.teams,
        warnings: res.warnings ?? [],
      });
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeployNow = async () => {
    // modal は deployPromptTarget!==null のときだけ表示され、 そのとき apiClient も非 null。
    // = この guard の return は不到達 (防御)。
    /* v8 ignore next */
    if (!deployPromptTarget || !apiClient || !canMutate) return;
    setDeployStarting(true);
    try {
      // 全 team × 全 problem を bulk deploy (= 既存 Issue #910 経路)。
      await bulkDeployEvent(apiClient, deployPromptTarget.eventId);
      navigate(`/events/${deployPromptTarget.eventId}`);
    } catch (err) {
      // bulk deploy 失敗時も Event 自体は作成済なので EventDetail に navigate して
      // operator が手動 deploy できる経路を残す。 error 表示は EventDetail 側 polling で拾われる。
      setError(toErrorMessage(err));
      navigate(`/events/${deployPromptTarget.eventId}`);
    } finally {
      setDeployStarting(false);
      setDeployPromptTarget(null);
    }
  };

  const handleDeployLater = () => {
    // modal は deployPromptTarget!==null のときだけ表示されるので return は不到達 (防御)。
    /* v8 ignore next */
    if (!deployPromptTarget) return;
    navigate(`/events/${deployPromptTarget.eventId}`);
    setDeployPromptTarget(null);
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("event_create.description")}>
        {t("event_create.title")}
      </Header>

      <Form>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" header={t("event_create.error_header")}>
              {error}
            </Alert>
          )}

          <EventCreateBasicInfoSection
            name={name}
            onNameChange={setName}
            nameInvalid={nameInvalid}
            teamCount={teamRows.length}
            onTeamCountChange={handleTeamCountChange}
            teamCountInvalid={teamCountInvalid}
          />

          {/* #528 / Phase 2.2 (Issue #459): Teams 入力の上に置く 3 種 Alert。
           *   load error / loading / 0-verified hint をまとめた小 component。 */}
          <EventCreateAccountsAlerts
            accountsLoadError={accountsLoadError}
            accountsLoading={accountsLoading}
            showLoadingHint={competitorAccounts === null && accountsLoading && !accountsLoadError}
            showNoVerifiedAccountsHint={showNoVerifiedAccountsHint}
            onReload={() => void fetchAccounts()}
          />

          <EventCreateTeamsSection
            teamTableItems={teamTableItems}
            teamCount={teamRows.length}
            teamValidation={teamValidation}
            accountOptions={accountOptions}
            accountById={accountById}
            noVerifiedAccounts={noVerifiedAccounts}
            apiClient={apiClient}
            onUpdateTeamRow={updateTeamRow}
          />

          <EventCreateProblemsetSection
            problems={allProblems}
            selectedProblems={selectedProblems}
            problemRows={problemRows}
            nonAwsRuntimeEnabled={config.features?.nonAwsRuntime ?? false}
            onProblemsChange={onProblemsChange}
            onUpdateProblemRow={updateProblemRow}
          />

          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => navigate("/events")}>{t("event_create.cancel")}</Button>
              <Button
                variant="primary"
                loading={submitting}
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {t("event_create.submit")}
              </Button>
            </SpaceBetween>
          </Box>
        </SpaceBetween>
      </Form>

      <EventCreateDeployPromptModal
        visible={deployPromptTarget !== null}
        canMutateTenant={canMutate}
        deployStarting={deployStarting}
        bulkDeploySupported={providerMode.kind === "aws"}
        participantPortalUrl={config.participantPortalUrl}
        teams={deployPromptTarget?.teams ?? []}
        capacityWarnings={deployPromptTarget?.warnings ?? []}
        liteDrillCheckpointCode={revealedFirstEventDrillCode}
        onDeployNow={() => void handleDeployNow()}
        onDeployLater={handleDeployLater}
      />
    </SpaceBetween>
  );
}
