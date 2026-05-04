import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * 競技者ログイン画面。チーム単位で発行されたログインキーを入力すると、
 * backend (現状 mock) が session を発行する。
 */
export function LoginPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [teamLoginKey, setTeamLoginKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(teamLoginKey);
      navigate("/");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "サインインに失敗しました。もう一度お試しください。";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = teamLoginKey.trim().length > 0 && !submitting;

  return (
    <Box padding="xxl">
      <Container
        header={
          <Header variant="h1" description={config.eventTitle}>
            TenkaCloud Participant Portal
          </Header>
        }
      >
        <Form
          actions={
            <Button variant="primary" disabled={!canSubmit} loading={submitting} onClick={onSubmit}>
              サインイン
            </Button>
          }
        >
          <SpaceBetween size="l">
            {error && (
              <Alert type="error" header="サインインに失敗しました">
                {error}
              </Alert>
            )}
            <Alert type="info" header="チームログインキーで認証します">
              運営から共有されたチーム単位のログインキーを入力してください。個人ごとのアカウントは作成されません。
            </Alert>
            <FormField
              label="チームログインキー"
              description="問題 deploy 時に運営が発行する短命キー (例: 32 文字の base64)"
            >
              <Input
                value={teamLoginKey}
                type="password"
                onChange={({ detail }) => setTeamLoginKey(detail.value)}
                placeholder="チームに配布されたキー"
                disabled={submitting}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Container>
    </Box>
  );
}
