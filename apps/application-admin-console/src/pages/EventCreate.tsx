import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Link from "@cloudscape-design/components/link";
import Modal from "@cloudscape-design/components/modal";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { type ApiClient, useApiClient } from "../api/client";
import {
  type CompetitorAccountSummary,
  listCompetitorAccounts,
} from "../api/competitor-accounts-client";
import { bulkDeployEvent, createEvent } from "../api/events-client";
import type { AppConfig } from "../config";
import { AWS_REGIONS, DEFAULT_AWS_REGION } from "../data/aws-regions";
import { listProblemSummaries } from "../data/problems";
import { useT } from "../i18n";
import {
  filterVerifiedAccounts,
  formatCompetitorAccountsLoadError,
} from "../lib/competitor-accounts-filter";

const NAME_MAX = 120;
// MUST match infrastructure/lib/problem-deploy/handlers/event-handler/types.ts (zod schema)。
// drift すると frontend が通した値を backend が reject する。
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ACCOUNT_ID_RE = /^\d{12}$/;
const TEAMS_MIN = 1;
const TEAMS_MAX = 99;
const TEAM_COUNT_INPUT_MAX_LEN = 3; // TEAMS_MAX が 99 = 2 桁、+1 余裕で 3 桁まで入力受理
const INITIAL_TEAM_COUNT = 3;

const REGION_OPTIONS: SelectProps.Option[] = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

export function buildVerifiedAccountOption(a: CompetitorAccountSummary): SelectProps.Option {
  const descriptionParts = [a.alias, a.region, a.competitorRoleName].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return {
    value: a.awsAccountId,
    label: a.awsAccountId,
    labelTag: a.alias,
    description: descriptionParts.join(" / "),
    filteringTags: descriptionParts,
  };
}

export function formatVerifiedAccountSummary(a: CompetitorAccountSummary): string {
  return a.alias ? `${a.awsAccountId} (${a.alias})` : a.awsAccountId;
}

interface ProblemRow {
  problemId: string;
  problemName: string;
  defaultRegion: string;
  /** Issue #1201 Phase 2: 問題が動作確認済 region 集合。 wizard picker の選択肢を絞る。 */
  supportedRegions?: readonly string[];
}

/**
 * Issue #1201 Phase 2: region picker の選択肢を `supportedRegions` で絞る純関数。
 *
 * - `supportedRegions` が undefined / 空 → 全 region (= 後方互換)
 * - 宣言されていれば、 集合と AWS_REGIONS の intersection で picker を構築
 * - 未知 region code (= AWS_REGIONS に無い文字列) は無視 (= UI に壊れた option を出さない)
 */
export function resolveRegionOptions(
  supportedRegions: readonly string[] | undefined,
  baseOptions: readonly SelectProps.Option[],
): readonly SelectProps.Option[] {
  if (!supportedRegions || supportedRegions.length === 0) return baseOptions;
  const allowed = new Set(supportedRegions);
  const intersection = baseOptions.filter((o) => o.value && allowed.has(o.value));
  // 宣言が無効 (= AWS_REGIONS と 1 件もマッチしない) のときは base に倒す。
  // ここで空配列を返すと wizard が壊れるので fail-safe。
  return intersection.length > 0 ? intersection : baseOptions;
}

/**
 * #528: 各 team の deploy 先 AWS Account ID は **team 単位** に。region は問題テンプレが
 * 特定 region 依存の場合があるので問題単位を維持。
 */
interface TeamRow {
  internalSlug: string;
  awsAccountId: string;
}

interface TeamValidation {
  readonly allSlugsValid: boolean;
  readonly allAccountsValid: boolean;
  readonly hasDuplicateSlug: boolean;
}

/**
 * Issue #1201: 問題行の初期 region を決める純関数。
 *
 * - 問題 metadata に `defaultRegion` が宣言されていればそれを採用
 * - 未宣言なら `globalDefault` (= 通常 `DEFAULT_AWS_REGION.code`) にフォールバック
 *
 * 「全 event が ap-northeast-1 に集中して quota 上限に到達する」 問題を、 問題側
 * (= 動作確認済 region を一番よく知っている人) の宣言で散らすための仕掛け。
 */
export function resolveInitialRegion(
  metaDefaultRegion: string | undefined,
  globalDefault: string,
): string {
  return metaDefaultRegion ?? globalDefault;
}

export function resizeTeamRows(prev: TeamRow[], next: number): TeamRow[] {
  if (next === prev.length) return prev;
  if (next < prev.length) return prev.slice(0, Math.max(next, 0));
  const additions = Array.from({ length: next - prev.length }, (_, i) => ({
    internalSlug: `team-${prev.length + i + 1}`,
    awsAccountId: "",
  }));
  return [...prev, ...additions];
}

export function validateTeamRows(teamRows: readonly TeamRow[]): TeamValidation {
  let allSlugsValid = true;
  let allAccountsValid = true;
  const slugs = new Set<string>();
  let hasDuplicateSlug = false;
  for (const t of teamRows) {
    if (!SLUG_RE.test(t.internalSlug)) allSlugsValid = false;
    if (!ACCOUNT_ID_RE.test(t.awsAccountId)) allAccountsValid = false;
    if (slugs.has(t.internalSlug)) hasDuplicateSlug = true;
    else slugs.add(t.internalSlug);
  }
  return { allSlugsValid, allAccountsValid, hasDuplicateSlug };
}

export function parseTeamCountInput(value: string): number | undefined {
  const next = Number.parseInt(value.replace(/\D/g, "").slice(0, TEAM_COUNT_INPUT_MAX_LEN), 10);
  return Number.isFinite(next) ? Math.max(0, Math.min(TEAMS_MAX, next)) : undefined;
}

function getNameErrorText(t: ReturnType<typeof useT>, name: string, nameInvalid: boolean) {
  return nameInvalid && name.length > 0
    ? t("event_create.name_invalid", { max: NAME_MAX })
    : undefined;
}

function getTeamCountErrorText(t: ReturnType<typeof useT>, teamCountInvalid: boolean) {
  return teamCountInvalid
    ? t("event_create.team_count_invalid", { min: TEAMS_MIN, max: TEAMS_MAX })
    : undefined;
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
 * 提出後は EventDetail に直接 navigate する (#530)。teamLoginKey は EventDetail の
 * 「チーム」 table で常時表示 + 各行にコピー button があるので、modal で 1 度きり露出
 * する旧 UX は不要。
 */
export function EventCreatePage({ config }: { config: AppConfig }) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const t = useT();

  const allProblems = useMemo(() => listProblemSummaries(), []);
  const problemOptions: MultiselectProps.Option[] = useMemo(
    () => allProblems.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })),
    [allProblems],
  );

  // Phase 2.2 (Issue #459): verified=true な CompetitorAccounts のみを Select の選択肢にする。
  // 自由入力の Input は廃止 (= operator が verified 済 account しか選べない fail-closed UX)。
  const [competitorAccounts, setCompetitorAccounts] = useState<
    readonly CompetitorAccountSummary[] | null
  >(null);
  const [accountsLoadError, setAccountsLoadError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);

  const fetchAccounts = useCallback(async () => {
    if (!apiClient) return;
    setAccountsLoading(true);
    setAccountsLoadError(null);
    try {
      const res = await listCompetitorAccounts(apiClient as ApiClient);
      setCompetitorAccounts(res.items);
    } catch (err) {
      // Issue #815: 401 は friendly な「再ログインしてください」 に flip。 silent 空配列で
      // operator が次の一手を見失う UX を防ぐ (= 旧 unknown-tenant fallback の置き換え)。
      setAccountsLoadError(formatCompetitorAccountsLoadError(err));
    } finally {
      setAccountsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  // #671: window focus 時に再取得する。 別タブで Verify した直後に戻ったとき、
  // dropdown が古い空配列のまま動かない問題への対処。
  useEffect(() => {
    const onFocus = () => {
      void fetchAccounts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchAccounts]);

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
    })),
  );
  const [selectedProblems, setSelectedProblems] = useState<readonly MultiselectProps.Option[]>([]);
  const [problemRows, setProblemRows] = useState<ProblemRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** チーム数の Input 変更で teamRows を伸縮。同数なら same-reference を返して
   *  無駄な再 render を防ぐ。減るとき末尾捨て、増えるとき新 row 追加。 */
  const handleTeamCountChange = (next: number) => {
    setTeamRows((prev) => resizeTeamRows(prev, next));
  };

  const updateTeamRow = (idx: number, patch: Partial<TeamRow>) => {
    setTeamRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  // Multiselect 変更時は problemRows を sync (既存行は値保持、新規分は default region)。
  const onProblemsChange = (next: readonly MultiselectProps.Option[]) => {
    setSelectedProblems(next);
    setProblemRows((prev) => {
      const byId = new Map(prev.map((r) => [r.problemId, r]));
      return next
        .filter((o): o is MultiselectProps.Option & { value: string } => !!o.value)
        .map((opt) => {
          const existing = byId.get(opt.value);
          if (existing) return existing;
          const meta = allProblems.find((p) => p.id === opt.value);
          return {
            problemId: opt.value,
            problemName: meta?.name ?? opt.value,
            // Issue #1201: 問題 metadata の defaultRegion を初期値に採用 (= 全 event
            // が ap-northeast-1 に集中するのを防ぐ)。 未宣言なら従来通り
            // DEFAULT_AWS_REGION にフォールバック。 operator は wizard で override 可能。
            defaultRegion: meta?.defaultRegion ?? DEFAULT_AWS_REGION.code,
            ...(meta?.supportedRegions ? { supportedRegions: meta.supportedRegions } : {}),
          };
        });
    });
  };

  const updateProblemRow = (problemId: string, patch: Partial<ProblemRow>) => {
    setProblemRows((rows) => rows.map((r) => (r.problemId === problemId ? { ...r, ...patch } : r)));
  };

  // teamRows ベースの validation を 1 pass に集約 (= 4 つ .every() / IIFE を回す代わり)。
  // teamRows 変更時のみ再評価され、render path の負担を減らす。
  const teamValidation = useMemo(() => validateTeamRows(teamRows), [teamRows]);
  // Table の items に渡す配列を teamRows ベースで memo 化。Cloudscape Table は items の
  // shallow identity で再 render 判定するので、毎 render 新 array を渡すと無駄に重い
  // (= 99 行 × 2 column の Input が全部 reconcile される)。
  const teamTableItems = useMemo(() => teamRows.map((t, i) => ({ ...t, idx: i })), [teamRows]);
  const teamCountInvalid = teamRows.length < TEAMS_MIN || teamRows.length > TEAMS_MAX;
  const nameInvalid = name.length === 0 || name.length > NAME_MAX;
  const canSubmit =
    !!apiClient &&
    !submitting &&
    !nameInvalid &&
    !teamCountInvalid &&
    problemRows.length > 0 &&
    teamValidation.allSlugsValid &&
    teamValidation.allAccountsValid &&
    !teamValidation.hasDuplicateSlug;

  // Issue #1067: 作成成功後、 EventDetail へ自動遷移する前に 「Deploy する? あとで?」 modal を出す。
  // 旧挙動は即遷移だったが、 「Deploy が必要」 と operator が気付かないまま放置されるケースが
  // 多発していた (= participant 側で問題が見えない silent failure)。 modal で明示促す。
  const [deployPromptTarget, setDeployPromptTarget] = useState<{ eventId: string } | null>(null);
  const [deployStarting, setDeployStarting] = useState(false);

  const handleSubmit = async () => {
    if (!canSubmit || !apiClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createEvent(apiClient, {
        name,
        teams: teamRows.map((t) => ({
          internalSlug: t.internalSlug,
          awsAccountId: t.awsAccountId,
        })),
        problems: problemRows.map((r) => ({
          problemId: r.problemId,
          defaultRegion: r.defaultRegion,
        })),
      });
      // Issue #1067: 即 navigate せず deploy 促し modal を出す。
      setDeployPromptTarget({ eventId: res.eventId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeployNow = async () => {
    if (!deployPromptTarget || !apiClient) return;
    setDeployStarting(true);
    try {
      // 全 team × 全 problem を bulk deploy (= 既存 Issue #910 経路)。
      await bulkDeployEvent(apiClient, deployPromptTarget.eventId);
      navigate(`/events/${deployPromptTarget.eventId}`);
    } catch (err) {
      // bulk deploy 失敗時も Event 自体は作成済なので EventDetail に navigate して
      // operator が手動 deploy できる経路を残す。 error 表示は EventDetail 側 polling で拾われる。
      setError(err instanceof Error ? err.message : String(err));
      navigate(`/events/${deployPromptTarget.eventId}`);
    } finally {
      setDeployStarting(false);
      setDeployPromptTarget(null);
    }
  };

  const handleDeployLater = () => {
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

          <Container header={<Header variant="h2">{t("event_create.basic_info_header")}</Header>}>
            <ColumnLayout columns={2}>
              <FormField
                label={t("event_create.name_label")}
                description={t("event_create.name_placeholder_example")}
                errorText={getNameErrorText(t, name, nameInvalid)}
              >
                <Input
                  value={name}
                  onChange={({ detail }) => setName(detail.value)}
                  invalid={nameInvalid && name.length > 0}
                />
              </FormField>
              <FormField
                label={t("event_create.team_count_label")}
                description={t("event_create.team_count_description", {
                  min: TEAMS_MIN,
                  max: TEAMS_MAX,
                })}
                errorText={getTeamCountErrorText(t, teamCountInvalid)}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  value={String(teamRows.length)}
                  onChange={({ detail }) => {
                    const next = parseTeamCountInput(detail.value);
                    if (next !== undefined) handleTeamCountChange(next);
                  }}
                  invalid={teamCountInvalid}
                />
              </FormField>
            </ColumnLayout>
          </Container>

          {/* #528: Teams section — 各 team の internalSlug + AWS Account ID を per-team で入力。
           *   旧 UX は problem 単位で 1 account 共有だったが、real competition では各 team が
           *   自社 account を持つため per-team 入力にする。
           *   Phase 2.2 (Issue #459): account は verified=true な CompetitorAccounts のみ選択
           *   できる drop-down。0 件のときは Competitor Accounts ページへの導線を出す。 */}
          {accountsLoadError && (
            <Alert
              type="error"
              header={t("event_create.accounts_load_error_header")}
              action={
                <Button
                  iconName="refresh"
                  onClick={() => void fetchAccounts()}
                  loading={accountsLoading}
                >
                  {t("event_create.accounts_reload")}
                </Button>
              }
            >
              {accountsLoadError}
            </Alert>
          )}
          {competitorAccounts === null && accountsLoading && !accountsLoadError && (
            <Alert type="info" header={t("event_create.accounts_loading_header")}>
              {t("event_create.accounts_loading_body")}
            </Alert>
          )}
          {showNoVerifiedAccountsHint && (
            <Alert
              type="warning"
              header={t("event_create.no_verified_header")}
              action={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="refresh"
                    onClick={() => void fetchAccounts()}
                    loading={accountsLoading}
                  >
                    {t("event_create.accounts_reload")}
                  </Button>
                  <Link
                    href="/competitor-accounts"
                    external={false}
                    onFollow={(e) => {
                      e.preventDefault();
                      navigate("/competitor-accounts");
                    }}
                  >
                    {t("event_create.go_to_competitor_accounts")}
                  </Link>
                </SpaceBetween>
              }
            >
              {t("event_create.no_verified_body")}
            </Alert>
          )}
          <Container
            header={
              <Header variant="h2" description={t("event_create.teams_description")}>
                {t("event_create.teams_header", { count: teamRows.length })}
              </Header>
            }
          >
            {teamRows.length === 0 ? (
              <Box variant="small" color="text-status-inactive">
                {t("event_create.teams_empty")}
              </Box>
            ) : (
              <Table
                variant="embedded"
                items={teamTableItems}
                columnDefinitions={[
                  {
                    id: "slug",
                    header: t("event_create.col_internal_slug"),
                    cell: (tr) => (
                      <Input
                        value={tr.internalSlug}
                        placeholder="team-1"
                        invalid={!SLUG_RE.test(tr.internalSlug)}
                        onChange={({ detail }) =>
                          updateTeamRow(tr.idx, { internalSlug: detail.value })
                        }
                      />
                    ),
                  },
                  {
                    id: "account",
                    header: t("event_create.col_aws_account"),
                    cell: (tr) => {
                      const selected =
                        accountOptions.find((o) => o.value === tr.awsAccountId) ?? null;
                      const selectedAccount = accountById.get(tr.awsAccountId);
                      return (
                        <SpaceBetween size="xxs">
                          <Select
                            selectedOption={selected}
                            options={accountOptions}
                            placeholder={
                              noVerifiedAccounts
                                ? t("event_create.no_verified_helper")
                                : t("event_create.select_verified_placeholder")
                            }
                            disabled={accountOptions.length === 0}
                            empty={t("event_create.select_empty_message")}
                            onChange={({ detail }) =>
                              updateTeamRow(tr.idx, {
                                awsAccountId: detail.selectedOption?.value ?? "",
                              })
                            }
                            invalid={
                              tr.awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(tr.awsAccountId)
                            }
                            expandToViewport
                            filteringType="auto"
                          />
                          {selectedAccount && (
                            <Box variant="small" color="text-status-inactive">
                              <span title={formatVerifiedAccountSummary(selectedAccount)}>
                                {formatVerifiedAccountSummary(selectedAccount)}
                              </span>
                            </Box>
                          )}
                          {noVerifiedAccounts && (
                            <Box variant="small" color="text-status-inactive">
                              {t("event_create.no_verified_helper")}
                            </Box>
                          )}
                        </SpaceBetween>
                      );
                    },
                  },
                ]}
              />
            )}
            {teamValidation.hasDuplicateSlug && (
              <Box variant="small" color="text-status-error" padding={{ top: "xs" }}>
                {t("event_create.duplicate_slug_error")}
              </Box>
            )}
          </Container>

          <Container header={<Header variant="h2">{t("event_create.problemset_header")}</Header>}>
            <SpaceBetween size="m">
              <FormField
                label={t("event_create.use_problems_label")}
                description={t("event_create.use_problems_description")}
              >
                <Multiselect
                  selectedOptions={selectedProblems}
                  options={problemOptions}
                  placeholder={t("event_create.problemset_placeholder")}
                  onChange={({ detail }) => onProblemsChange(detail.selectedOptions)}
                />
              </FormField>

              {problemRows.length > 0 && (
                <Table
                  variant="embedded"
                  items={problemRows}
                  columnDefinitions={[
                    {
                      id: "name",
                      header: t("event_create.col_problem"),
                      cell: (r) => r.problemName,
                    },
                    {
                      id: "region",
                      header: t("event_create.col_region"),
                      cell: (r) => {
                        const options = resolveRegionOptions(r.supportedRegions, REGION_OPTIONS);
                        return (
                          <Select
                            selectedOption={
                              options.find((o) => o.value === r.defaultRegion) ?? options[0]
                            }
                            options={[...options]}
                            onChange={({ detail }) =>
                              updateProblemRow(r.problemId, {
                                defaultRegion: detail.selectedOption?.value ?? r.defaultRegion,
                              })
                            }
                            expandToViewport
                          />
                        );
                      },
                    },
                  ]}
                />
              )}
            </SpaceBetween>
          </Container>

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

      {/* Issue #1067: Event 作成後の deploy 必要性を operator に明示する modal。
          旧挙動 (= 即 navigate) では operator が deploy 必要に気付かず participant 側
          で問題が見えない silent failure が頻発していた。 */}
      <Modal
        visible={deployPromptTarget !== null}
        onDismiss={() => (deployStarting ? undefined : handleDeployLater())}
        header={t("event_create.deploy_modal_header")}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={handleDeployLater} disabled={deployStarting}>
                {t("event_create.deploy_modal_later")}
              </Button>
              <Button
                variant="primary"
                loading={deployStarting}
                onClick={() => void handleDeployNow()}
                data-testid="deploy-prompt-now"
              >
                {t("event_create.deploy_modal_now")}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="info" header={t("event_create.deploy_modal_alert_header")}>
            {t("event_create.deploy_modal_alert_body")}
          </Alert>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
