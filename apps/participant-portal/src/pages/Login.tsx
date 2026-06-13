import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";
import { clearInviteHash, readInviteKeyFromHash } from "../lib/invite";

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
  // #1772: 招待リンク (`/login#invite=<key>`) で開いたときは key を prefill する。
  // auto-submit はしない (= #496 の「黙って team が切り替わる」事故防止と同じ思想で、
  // ログインは必ず competitor の 1 クリックを挟む)。
  const [teamLoginKey, setTeamLoginKey] = useState(
    () => readInviteKeyFromHash(window.location.hash) ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 読み取り後は fragment を落とし、 login key をアドレスバー / 履歴に残さない。
  useEffect(() => {
    clearInviteHash();
  }, []);
  // LP 「モックで試す」 動線では backend が存在せず login key 文字列 が任意 (= 競技
  // 主催者が発行する短命キーは無い)。 ユーザーに 「何を入れればいいか分からない」 と
  // 思わせないために info banner / placeholder / description を dev-mock 用に出し分ける。
  // 旧: const isMock = config.mode !== "backend"; → useIsMock() (Thermo-Nuclear review P1)
  const isMock = useIsMock();

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
      const raw = err instanceof Error ? err.message : t("login.failed_generic");
      const translated =
        raw === "EMPTY_TEAM_LOGIN_KEY"
          ? t("home.auth_error_empty_key")
          : raw === "BACKEND_UNREACHABLE"
            ? t("home.auth_error_backend")
            : raw;
      setError(translated);
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
            <Alert
              type="info"
              header={isMock ? t("login.mock_info_header") : t("login.info_header")}
            >
              {isMock ? t("login.mock_info_body") : t("login.info_body")}
            </Alert>
            <FormField
              label={t("login.field_label")}
              description={
                isMock ? t("login.mock_field_description") : t("login.field_description")
              }
            >
              <Input
                value={teamLoginKey}
                type={isMock ? "text" : "password"}
                onChange={({ detail }) => setTeamLoginKey(detail.value)}
                placeholder={
                  isMock ? t("login.mock_field_placeholder") : t("login.field_placeholder")
                }
                disabled={submitting}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Container>
    </Box>
  );
}
