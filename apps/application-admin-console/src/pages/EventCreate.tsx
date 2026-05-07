import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Multiselect, { type MultiselectProps } from "@cloudscape-design/components/multiselect";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Table from "@cloudscape-design/components/table";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import {
  type CreateEventResponse,
  createEvent,
  type EventProblemTarget,
} from "../api/events-client";
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

interface ProblemRow extends EventProblemTarget {
  problemName: string;
}

/**
 * Event 作成 form。
 *
 * 入力:
 *   - Event 名 (1〜120 文字)
 *   - チーム数 (1〜99) — 作成時に `team-1`, `team-2` ... の internalSlug が自動付番される
 *   - 問題セット (`Multiselect`) — 各問題ごとに deploy 先 account / region を入力
 *
 * 提出後、レスポンスの `teams[].teamLoginKey` を Modal で 1 度だけ表示する (= operator が
 * 控える / CSV ダウンロードする)。
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
  const [teamCount, setTeamCount] = useState("3");
  const [selectedProblems, setSelectedProblems] = useState<readonly MultiselectProps.Option[]>([]);
  const [problemRows, setProblemRows] = useState<ProblemRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<CreateEventResponse | null>(null);

  // Multiselect 変更時は problemRows を sync (既存行は値保持、新規分は default)。
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
            defaultAwsAccountId: "",
            defaultRegion: DEFAULT_AWS_REGION.code,
          };
        });
    });
  };

  const updateProblemRow = (problemId: string, patch: Partial<ProblemRow>) => {
    setProblemRows((rows) => rows.map((r) => (r.problemId === problemId ? { ...r, ...patch } : r)));
  };

  const teamCountNum = Number.parseInt(teamCount, 10);
  const teamCountInvalid =
    !Number.isFinite(teamCountNum) || teamCountNum < TEAMS_MIN || teamCountNum > TEAMS_MAX;
  const nameInvalid = name.length === 0 || name.length > NAME_MAX;
  const allAccountsValid = problemRows.every((r) => ACCOUNT_ID_RE.test(r.defaultAwsAccountId));
  const canSubmit =
    !!apiClient &&
    !submitting &&
    !nameInvalid &&
    !teamCountInvalid &&
    problemRows.length > 0 &&
    allAccountsValid;

  const handleSubmit = async () => {
    if (!canSubmit || !apiClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const teams = Array.from({ length: teamCountNum }, (_, i) => ({
        internalSlug: `team-${i + 1}`,
      }));
      // SLUG_RE 違反は zod / 受け側でも弾かれるが UX 的に事前 validate
      const slugInvalid = teams.find((t) => !SLUG_RE.test(t.internalSlug));
      if (slugInvalid) {
        throw new Error(`team slug の形式が不正: ${slugInvalid.internalSlug}`);
      }
      const res = await createEvent(apiClient, {
        name,
        teams,
        problems: problemRows.map((r) => ({
          problemId: r.problemId,
          defaultAwsAccountId: r.defaultAwsAccountId,
          defaultRegion: r.defaultRegion,
        })),
      });
      setResponse(res);
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
        description="チーム数と問題セットを指定して Event を作成します。teamLoginKey は完了画面で 1 度だけ表示されます。"
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
                  value={teamCount}
                  onChange={({ detail }) =>
                    setTeamCount(detail.value.replace(/\D/g, "").slice(0, 3))
                  }
                  invalid={teamCountInvalid}
                />
              </FormField>
            </ColumnLayout>
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
                      id: "account",
                      header: "AWS Account ID",
                      cell: (r) => (
                        <Input
                          value={r.defaultAwsAccountId}
                          placeholder="123456789012"
                          inputMode="numeric"
                          invalid={
                            r.defaultAwsAccountId.length > 0 &&
                            !ACCOUNT_ID_RE.test(r.defaultAwsAccountId)
                          }
                          onChange={({ detail }) =>
                            updateProblemRow(r.problemId, {
                              defaultAwsAccountId: detail.value.replace(/\D/g, "").slice(0, 12),
                            })
                          }
                        />
                      ),
                    },
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

      <Modal
        visible={response !== null}
        header="Event 作成完了 — チームログインキーを控えてください"
        size="large"
        onDismiss={() => {
          if (!response) return;
          navigate(`/events/${response.eventId}`);
        }}
        footer={
          <Box float="right">
            <Button
              variant="primary"
              onClick={() => response && navigate(`/events/${response.eventId}`)}
            >
              Event 詳細へ
            </Button>
          </Box>
        }
      >
        {response && (
          <SpaceBetween size="m">
            <Alert type="warning" header="teamLoginKey はこの画面でしか表示されません">
              安全な手段で各チームに hand-off してください。閉じた後は再表示できません (= Phase 2c
              で operator 用の再取得 API を検討)。
            </Alert>
            <Box>
              Event ID: <Box variant="code">{response.eventId}</Box>
            </Box>
            <Table
              items={[...response.teams]}
              columnDefinitions={[
                { id: "team", header: "Team", cell: (t) => t.internalSlug },
                {
                  id: "key",
                  header: "teamLoginKey",
                  cell: (t) => <Box variant="code">{t.teamLoginKey}</Box>,
                },
              ]}
            />
          </SpaceBetween>
        )}
      </Modal>
    </SpaceBetween>
  );
}
