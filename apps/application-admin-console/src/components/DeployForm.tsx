import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Input from "@cloudscape-design/components/input";
import Modal from "@cloudscape-design/components/modal";
import Select, { type SelectProps } from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { type DeployResponse, startDeployment } from "../api/deploy-client";
import type { AppConfig } from "../config";
import { AWS_REGIONS, DEFAULT_AWS_REGION } from "../data/aws-regions";
import { buildStackPrefix } from "../lib/resource-naming";

const AWS_ACCOUNT_ID_RE = /^\d{12}$/;
const TEAM_NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;

interface Props {
  config: AppConfig;
  problemId: string;
  problemName: string;
  visible: boolean;
  onDismiss: () => void;
}

const REGION_OPTIONS: SelectProps.Option[] = AWS_REGIONS.map((r) => ({
  value: r.code,
  label: r.label,
}));

/**
 * `teamLoginKey` はレスポンスで 1 度だけ露出する短命キー。Modal 上で表示し
 * 利用者が控えるまで閉じない (navigate も明示クリック後)。
 */
export function DeployFormModal({ config, problemId, problemName, visible, onDismiss }: Props) {
  const apiClient = useApiClient(config);
  const navigate = useNavigate();
  const [region, setRegion] = useState<SelectProps.Option>({
    value: DEFAULT_AWS_REGION.code,
    label: DEFAULT_AWS_REGION.label,
  });
  const [awsAccountId, setAwsAccountId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountIdInvalid = awsAccountId.length > 0 && !AWS_ACCOUNT_ID_RE.test(awsAccountId);
  const teamNameInvalid = teamName.length > 0 && !TEAM_NAME_RE.test(teamName);
  const inputsLocked = response !== null || submitting;
  const canSubmit =
    !!apiClient &&
    !!region.value &&
    AWS_ACCOUNT_ID_RE.test(awsAccountId) &&
    TEAM_NAME_RE.test(teamName) &&
    !inputsLocked;

  const handleSubmit = async () => {
    if (!canSubmit || !region.value || !apiClient) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await startDeployment(apiClient, problemId, {
        region: region.value,
        awsAccountId,
        teamName,
      });
      setResponse(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setResponse(null);
    setError(null);
    setSubmitting(false);
    setAwsAccountId("");
    setTeamName("");
    setRegion({ value: DEFAULT_AWS_REGION.code, label: DEFAULT_AWS_REGION.label });
  };

  const close = () => {
    reset();
    onDismiss();
  };

  const goToDetail = () => {
    if (!response) return;
    const jobId = response.jobId;
    reset();
    onDismiss();
    navigate(`/deployments/${jobId}`);
  };

  return (
    <Modal
      visible={visible}
      onDismiss={close}
      header={`「${problemName}」を競技アカウントへデプロイ`}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={close}>閉じる</Button>
            {response ? (
              <Button variant="primary" onClick={goToDetail}>
                ジョブ詳細を見る
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={submitting}
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                デプロイを開始
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <Form>
        <SpaceBetween size="l">
          {response ? (
            <Alert type="success" header="デプロイ受付完了 — チームログインキーを控えてください">
              <SpaceBetween size="s">
                <Box>
                  Job ID: <code>{response.jobId}</code>
                </Box>
                <Box>
                  Stack 名 prefix: <code>{response.namePrefix}</code>
                </Box>
                <Box>
                  チームログインキー (この画面でしか表示されません): <br />
                  <Box variant="code" fontSize="heading-s">
                    {response.teamLoginKey}
                  </Box>
                </Box>
                <Box variant="small" color="text-status-warning">
                  このキーは一度だけ表示されます。安全な場所に控えてからジョブ詳細に進んでください。
                </Box>
              </SpaceBetween>
            </Alert>
          ) : (
            <>
              {error && (
                <Alert type="error" header="デプロイ送信に失敗しました">
                  {error}
                </Alert>
              )}
              <Alert type="info" header="デプロイ contract">
                入力された AWS アカウント / リージョンに問題スタックを CFn で展開し、Team Name
                ごとに短命ログインキーを 1 つ発行します。参加者個別の Cognito ユーザは作成しません。
                <br />
                同一 (Account, Region)
                に複数のチームのスタックを並べる運用を許容するため、各リソース名には
                <code>
                  {" "}
                  tc-{"{problemId}"}-{"{teamName}"}{" "}
                </code>
                を共通 prefix として付与し、衝突を回避します。
              </Alert>
            </>
          )}

          <FormField
            label="AWS Region"
            description="問題スタックを deploy するリージョン"
            constraintText="リージョン跨ぎは未対応 (近接プレイヤーのレイテンシ最適化を優先)"
          >
            <Select
              selectedOption={region}
              options={REGION_OPTIONS}
              disabled={inputsLocked}
              onChange={({ detail }) => detail.selectedOption && setRegion(detail.selectedOption)}
            />
          </FormField>

          <FormField
            label="AWS Account ID"
            description="deploy 先の競技アカウント (12 桁の数字)"
            errorText={accountIdInvalid ? "12 桁の数字で入力してください" : undefined}
          >
            <Input
              value={awsAccountId}
              type="text"
              inputMode="numeric"
              placeholder="123456789012"
              disabled={inputsLocked}
              onChange={({ detail }) =>
                setAwsAccountId(detail.value.replace(/\D/g, "").slice(0, 12))
              }
              invalid={accountIdInvalid}
            />
          </FormField>

          <FormField
            label="Team Name"
            description="チーム識別子。スタック名・ログインキーラベル・各リソース prefix に使う"
            constraintText="英数字 / スペース / _ / - のみ、40 文字以内"
            errorText={teamNameInvalid ? "英数字 / スペース / _ / - のみ、40 文字以内" : undefined}
          >
            <Input
              value={teamName}
              placeholder="例: alpha-team"
              disabled={inputsLocked}
              onChange={({ detail }) => setTeamName(detail.value)}
              invalid={teamNameInvalid}
            />
          </FormField>

          {teamName.length > 0 && !teamNameInvalid && response === null && (
            <FormField
              label="生成される Stack 名 prefix (preview)"
              description="同一 (Account, Region) に複数チームのスタックが共存できるよう、リソース名はこの prefix で衝突回避します"
            >
              <Box variant="code">{buildStackPrefix(problemId, teamName)}</Box>
            </FormField>
          )}
        </SpaceBetween>
      </Form>
    </Modal>
  );
}
