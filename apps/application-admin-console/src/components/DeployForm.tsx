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
import { AWS_REGIONS, DEFAULT_AWS_REGION } from "../data/aws-regions";
import { buildStackPrefix } from "../lib/resource-naming";

const AWS_ACCOUNT_ID_RE = /^\d{12}$/;
const TEAM_NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;

export interface DeployFormValues {
  region: string;
  awsAccountId: string;
  teamName: string;
}

interface Props {
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
 * 問題を競技アカウントへデプロイする際の Form Modal。
 *
 * 入力:
 *   - region: AWS Region (deploy 先)
 *   - awsAccountId: 12 桁の AWS アカウント ID (deploy 先)
 *   - teamName: チーム名 (stack 名 + ログインキーラベルに使う)
 *
 * 送信:
 *   現状は backend 未実装なので、入力値を確認 Alert に表示して止める。
 *   backend 実装時には POST /problems/:id/deploy を呼び、ジョブ ID を返して
 *   /deployments/:jobId に遷移する。
 *
 * 認証モデル:
 *   参加者個別アカウントは作らず、各チームに 1 つの短命ログインキーを発行する。
 *   teamName が同じデプロイは別 stack として扱う (= 別チーム = 別キー)。
 */
export function DeployFormModal({ problemId, problemName, visible, onDismiss }: Props) {
  const [region, setRegion] = useState<SelectProps.Option>({
    value: DEFAULT_AWS_REGION.code,
    label: DEFAULT_AWS_REGION.label,
  });
  const [awsAccountId, setAwsAccountId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [submitted, setSubmitted] = useState<DeployFormValues | null>(null);

  const accountIdInvalid = awsAccountId.length > 0 && !AWS_ACCOUNT_ID_RE.test(awsAccountId);
  const teamNameInvalid = teamName.length > 0 && !TEAM_NAME_RE.test(teamName);
  const canSubmit =
    !!region.value && AWS_ACCOUNT_ID_RE.test(awsAccountId) && TEAM_NAME_RE.test(teamName);

  const handleSubmit = () => {
    if (!canSubmit || !region.value) return;
    setSubmitted({
      region: region.value,
      awsAccountId,
      teamName,
    });
    // backend 実装後は: POST /problems/:problemId/deploy ボディに上記を送り、
    // ジョブ ID を受け取って navigate(`/deployments/${jobId}`)
  };

  const reset = () => {
    setSubmitted(null);
    setAwsAccountId("");
    setTeamName("");
    setRegion({ value: DEFAULT_AWS_REGION.code, label: DEFAULT_AWS_REGION.label });
  };

  return (
    <Modal
      visible={visible}
      onDismiss={() => {
        reset();
        onDismiss();
      }}
      header={`「${problemName}」を競技アカウントへデプロイ`}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              onClick={() => {
                reset();
                onDismiss();
              }}
            >
              閉じる
            </Button>
            <Button
              variant="primary"
              disabled={!canSubmit || submitted !== null}
              onClick={handleSubmit}
            >
              デプロイを開始
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form>
        <SpaceBetween size="l">
          {submitted ? (
            <Alert type="warning" header="backend 未実装 — デプロイは送信されていません">
              入力された値は次の通りです (実装完了後、これらが POST /problems/{problemId}
              /deploy に送られ、CloudFormation 起動 + チームログインキー発行が走ります)。
              <ul>
                <li>Region: {submitted.region}</li>
                <li>AWS Account ID: {submitted.awsAccountId}</li>
                <li>Team Name: {submitted.teamName}</li>
                <li>
                  Stack 名 prefix: <code>{buildStackPrefix(problemId, submitted.teamName)}</code>
                </li>
              </ul>
            </Alert>
          ) : (
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
          )}

          <FormField
            label="AWS Region"
            description="問題スタックを deploy するリージョン"
            constraintText="リージョン跨ぎは未対応 (近接プレイヤーのレイテンシ最適化を優先)"
          >
            <Select
              selectedOption={region}
              options={REGION_OPTIONS}
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
              onChange={({ detail }) => setTeamName(detail.value)}
              invalid={teamNameInvalid}
            />
          </FormField>

          {teamName.length > 0 && !teamNameInvalid && (
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
