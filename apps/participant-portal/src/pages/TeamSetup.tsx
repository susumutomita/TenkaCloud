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
import { PortalAuthError, PortalValidationError, updateTeamName } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

/**
 * 競技者がログイン直後に通る team name 入力ページ。`PATCH /portal/me` でサーバ側
 * `displayTeamName` を設定し、AuthProvider のセッションを更新して `/` に戻る。
 *
 * dev-mock モードはこのページに到達しない (AuthProvider が初期 session に
 * `teamNameSetByCompetitor=true` を入れる)。
 */
export function TeamSetupPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [teamName, setTeamName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = teamName.trim();
  const invalid = teamName.length > 0 && !TEAM_NAME_RE.test(trimmed);
  const canSubmit = !!auth.session?.sessionToken && trimmed.length > 0 && !invalid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !auth.session) return;
    setSubmitting(true);
    setError(null);
    try {
      const view = await updateTeamName(config.apiBaseUrl, auth.session.sessionToken, trimmed);
      auth.updateSession({
        teamName: view.team.teamName,
        teamNameSetByCompetitor: view.team.teamNameSetByCompetitor,
      });
      navigate("/");
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        navigate("/login");
        return;
      }
      if (err instanceof PortalValidationError) {
        setError(
          "チーム名の形式が無効です。1〜40 文字、英数字 / 半角スペース / _ / - / 日本語のみ。",
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box padding="l" textAlign="center">
      <Container
        header={
          <Header
            variant="h1"
            description="このイベント中にあなたのチームを呼ぶ名前を入力してください"
          >
            チーム名を決めよう
          </Header>
        }
      >
        <Form>
          <SpaceBetween size="l">
            {error && (
              <Alert type="error" header="チーム名を保存できませんでした">
                {error}
              </Alert>
            )}
            <FormField
              label="チーム名"
              description="プロフィールやスコアボードに表示される名前。後から変更できます。"
              constraintText="1〜40 文字、英数字 / 半角スペース / _ / - / 日本語"
              errorText={invalid ? "形式が無効です" : undefined}
            >
              <Input
                value={teamName}
                placeholder="例: わたしたちのチーム"
                disabled={submitting}
                onChange={({ detail }) => setTeamName(detail.value)}
                invalid={invalid}
              />
            </FormField>
            <Button
              variant="primary"
              loading={submitting}
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              この名前で始める
            </Button>
          </SpaceBetween>
        </Form>
      </Container>
    </Box>
  );
}
