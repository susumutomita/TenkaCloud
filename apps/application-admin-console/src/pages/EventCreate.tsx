import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { createEvent } from "../api/events-client";
import type { AppConfig } from "../config";
import { AWS_REGIONS, DEFAULT_AWS_REGION } from "../data/aws-regions";
import { listProblemSummaries } from "../data/problems";

const NAME_MAX = 120;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ACCOUNT_ID_RE = /^\d{12}$/;
const TEAMS_MIN = 1;
const TEAMS_MAX = 99;

const REGION_OPTIONS: SelectProps.Option[] = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

interface ProblemRow {
  problemId: string;
  problemName: string;
  defaultRegion: string;
}

/**
 * #528: 各 team の deploy 先 AWS Account ID は **team 単位** に。region は問題テンプレが
 * 特定 region 依存の場合があるので問題単位を維持。
 */
interface TeamRow {
  internalSlug: string;
  awsAccountId: string;
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

  const allProblems = useMemo(() => listProblemSummaries(), []);
  const problemOptions: MultiselectProps.Option[] = useMemo(
    () => allProblems.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })),
    [allProblems],
  );

  const [name, setName] = useState("");
  // #528: チーム数を変えると teamRows が動的に伸縮 (= 初期 3 行)。
  const [teamRows, setTeamRows] = useState<TeamRow[]>(() =>
    Array.from({ length: 3 }, (_, i) => ({ internalSlug: `team-${i + 1}`, awsAccountId: "" })),
  );
  const [selectedProblems, setSelectedProblems] = useState<readonly MultiselectProps.Option[]>([]);
  const [problemRows, setProblemRows] = useState<ProblemRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** #528: チーム数の Input が変わったら teamRows を伸縮する。
   *   - 増えるとき: 既存 row はそのまま、新 row は `team-N` の internalSlug + 空 account
   *   - 減るとき: 末尾を捨てる (= operator が入力した内容を可能な限り保持) */
  const handleTeamCountChange = (next: number) => {
    setTeamRows((prev) => {
      if (next <= prev.length) return prev.slice(0, Math.max(next, 0));
      const additions = Array.from({ length: next - prev.length }, (_, i) => ({
        internalSlug: `team-${prev.length + i + 1}`,
        awsAccountId: "",
      }));
      return [...prev, ...additions];
    });
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
            defaultRegion: DEFAULT_AWS_REGION.code,
          };
        });
    });
  };

  const updateProblemRow = (problemId: string, patch: Partial<ProblemRow>) => {
    setProblemRows((rows) => rows.map((r) => (r.problemId === problemId ? { ...r, ...patch } : r)));
  };

  const teamCountInvalid = teamRows.length < TEAMS_MIN || teamRows.length > TEAMS_MAX;
  const nameInvalid = name.length === 0 || name.length > NAME_MAX;
  const allTeamSlugsValid = teamRows.every((t) => SLUG_RE.test(t.internalSlug));
  const allTeamAccountsValid = teamRows.every((t) => ACCOUNT_ID_RE.test(t.awsAccountId));
  const duplicateSlugs = (() => {
    const seen = new Set<string>();
    for (const t of teamRows) {
      if (seen.has(t.internalSlug)) return true;
      seen.add(t.internalSlug);
    }
    return false;
  })();
  const canSubmit =
    !!apiClient &&
    !submitting &&
    !nameInvalid &&
    !teamCountInvalid &&
    problemRows.length > 0 &&
    allTeamSlugsValid &&
    allTeamAccountsValid &&
    !duplicateSlugs;

  const handleSubmit = async () => {
    if (!canSubmit || !apiClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createEvent(apiClient, {
        name,
        // #528: teams は internalSlug + awsAccountId のペア。
        teams: teamRows.map((t) => ({
          internalSlug: t.internalSlug,
          awsAccountId: t.awsAccountId,
        })),
        // 問題側は region のみ (account は team 側に移動)。
        problems: problemRows.map((r) => ({
          problemId: r.problemId,
          defaultRegion: r.defaultRegion,
        })),
      });
      // #530: 作成直後に EventDetail へ。teamLoginKey は EventDetail で常時表示。
      navigate(`/events/${res.eventId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="チーム数と問題セットを指定して Event を作成します。teamLoginKey は EventDetail でいつでも確認できます。"
      >
        新規 Event 作成
      </Header>

      <Form>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" header="作成に失敗しました">
              {error}
            </Alert>
          )}

          <Container header={<Header variant="h2">基本情報</Header>}>
            <ColumnLayout columns={2}>
              <FormField
                label="Event 名"
                description="例: JAWS-UG 春の陣 2026"
                errorText={nameInvalid && name.length > 0 ? `1〜${NAME_MAX} 文字` : undefined}
              >
                <Input
                  value={name}
                  onChange={({ detail }) => setName(detail.value)}
                  invalid={nameInvalid && name.length > 0}
                />
              </FormField>
              <FormField
                label="チーム数"
                description={`${TEAMS_MIN}〜${TEAMS_MAX} (= TransactWrite 上限から event 1 行を引いた値)`}
                errorText={teamCountInvalid ? `${TEAMS_MIN}〜${TEAMS_MAX} の整数` : undefined}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  value={String(teamRows.length)}
                  onChange={({ detail }) => {
                    const next = Number.parseInt(detail.value.replace(/\D/g, "").slice(0, 3), 10);
                    if (Number.isFinite(next))
                      handleTeamCountChange(Math.max(0, Math.min(TEAMS_MAX, next)));
                  }}
                  invalid={teamCountInvalid}
                />
              </FormField>
            </ColumnLayout>
          </Container>

          {/* #528: Teams section — 各 team の internalSlug + AWS Account ID を per-team で入力。
           *   旧 UX は problem 単位で 1 account 共有だったが、real competition では各 team が
           *   自社 account を持つため per-team 入力にする。 */}
          <Container
            header={
              <Header
                variant="h2"
                description="各 team の deploy 先 AWS Account ID を入力します (12 桁数字)。internalSlug は CFn StackName 由来になり deploy 後 immutable。"
              >
                Teams ({teamRows.length})
              </Header>
            }
          >
            {teamRows.length === 0 ? (
              <Box variant="small" color="text-status-inactive">
                チーム数を 1 以上に設定してください。
              </Box>
            ) : (
              <Table
                variant="embedded"
                items={teamRows.map((t, i) => ({ ...t, idx: i }))}
                columnDefinitions={[
                  {
                    id: "slug",
                    header: "internalSlug",
                    cell: (t) => (
                      <Input
                        value={t.internalSlug}
                        placeholder="team-1"
                        invalid={!SLUG_RE.test(t.internalSlug)}
                        onChange={({ detail }) =>
                          updateTeamRow(t.idx, { internalSlug: detail.value })
                        }
                      />
                    ),
                  },
                  {
                    id: "account",
                    header: "AWS Account ID",
                    cell: (t) => (
                      <Input
                        value={t.awsAccountId}
                        placeholder="123456789012"
                        inputMode="numeric"
                        invalid={t.awsAccountId.length > 0 && !ACCOUNT_ID_RE.test(t.awsAccountId)}
                        onChange={({ detail }) =>
                          updateTeamRow(t.idx, {
                            awsAccountId: detail.value.replace(/\D/g, "").slice(0, 12),
                          })
                        }
                      />
                    ),
                  },
                ]}
              />
            )}
            {duplicateSlugs && (
              <Box variant="small" color="text-status-error" padding={{ top: "xs" }}>
                重複する internalSlug があります。各 team で固有の slug を指定してください。
              </Box>
            )}
          </Container>

          <Container header={<Header variant="h2">問題セット</Header>}>
            <SpaceBetween size="m">
              <FormField label="使用する問題" description="複数選択可。順序は問わない。">
                <Multiselect
                  selectedOptions={selectedProblems}
                  options={problemOptions}
                  placeholder="問題を選んでください"
                  onChange={({ detail }) => onProblemsChange(detail.selectedOptions)}
                />
              </FormField>

              {problemRows.length > 0 && (
                <Table
                  variant="embedded"
                  items={problemRows}
                  columnDefinitions={[
                    { id: "name", header: "問題", cell: (r) => r.problemName },
                    {
                      id: "region",
                      header: "Region",
                      cell: (r) => (
                        <Select
                          selectedOption={
                            REGION_OPTIONS.find((o) => o.value === r.defaultRegion) ??
                            REGION_OPTIONS[0]
                          }
                          options={REGION_OPTIONS}
                          onChange={({ detail }) =>
                            updateProblemRow(r.problemId, {
                              defaultRegion: detail.selectedOption?.value ?? r.defaultRegion,
                            })
                          }
                        />
                      ),
                    },
                  ]}
                />
              )}
            </SpaceBetween>
          </Container>

          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => navigate("/events")}>キャンセル</Button>
              <Button
                variant="primary"
                loading={submitting}
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                Event を作成
              </Button>
            </SpaceBetween>
          </Box>
        </SpaceBetween>
      </Form>
    </SpaceBetween>
  );
}
