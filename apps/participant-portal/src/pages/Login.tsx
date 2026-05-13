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
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

/**
 * 競技者ログイン画面。チーム単位で発行されたログインキーを入力すると、
 * backend (現状 mock) が session を発行する。
 *
 * 既存 session がある状態で /login に来た場合は **無条件で / にリダイレクト** する
 * (Issue #496)。これにより「同 browser でログイン中のまま別 team key を黙って入力 →
 * 黙って team が切り替わる」事故を防ぐ。team 切替には TopNav の「サインアウト」を
 * 経由する必要がある。
 */
export function LoginPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const [teamLoginKey, setTeamLoginKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 既ログイン状態で /login に来た場合は home に redirect (= 別 key 黙々上書き防止)。
  // ready=false の間は loadSession の結果待ちで何も決められないので render を保留。
  if (auth.ready && auth.session) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(teamLoginKey);
      navigate("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : t("login.failed_generic");
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
            {t("login.header")}
          </Header>
        }
      >
        <Form
          actions={
            <Button variant="primary" disabled={!canSubmit} loading={submitting} onClick={onSubmit}>
              {t("login.submit")}
            </Button>
          }
        >
          <SpaceBetween size="l">
            {error && (
              <Alert type="error" header={t("login.failed_header")}>
                {error}
              </Alert>
            )}
            <Alert type="info" header={t("login.info_header")}>
              {t("login.info_body")}
            </Alert>
            <FormField label={t("login.field_label")} description={t("login.field_description")}>
              <Input
                value={teamLoginKey}
                type="password"
                onChange={({ detail }) => setTeamLoginKey(detail.value)}
                placeholder={t("login.field_placeholder")}
                disabled={submitting}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Container>
    </Box>
  );
}
