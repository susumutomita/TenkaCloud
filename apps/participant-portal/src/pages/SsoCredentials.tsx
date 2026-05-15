import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { getConsoleSigninUrl, PortalAuthError, PortalValidationError } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import type { AppConfig } from "../config";

/**
 * AWS Console ワンクリック login。競技者は自前 AWS ログイン不要で、Portal の button
 * を押すと backend Lambda が STS AssumeRole + signin federation を実行して
 * `signin.aws.amazon.com/federation?Action=login` URL を発行 → 新タブで開く。
 *
 * Lambda が assume するのは `ConsoleViewerRole` (= ReadOnlyAccess managed policy)。
 * 競技者は AWS Console で stack 状態を read-only で確認可能。
 */
export function SsoCredentialsPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error } = useTeamView();
  const isBackend = config.mode === "backend";

  const [pending, setPending] = useState<string | null>(null); // jobId
  const [openError, setOpenError] = useState<string | null>(null);

  const openConsole = async (jobId: string) => {
    if (!sessionToken || pending) return;
    setPending(jobId);
    setOpenError(null);
    try {
      const loginUrl = await getConsoleSigninUrl(config.apiBaseUrl, sessionToken, jobId);
      window.open(loginUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        return;
      }
      if (err instanceof PortalValidationError) {
        setOpenError(`バリデーションエラー: ${err.errorCode}`);
        return;
      }
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="AWS Console にワンクリックで federate ログイン。自前の AWS アカウント不要。"
      >
        SSO Credentials
      </Header>

      {!isBackend && (
        <Alert type="info">
          dev-mock モードで動作中です。実 backend と接続するには runtime-config の <code>mode</code>{" "}
          を <code>backend</code> に設定してください。
        </Alert>
      )}
      {error && (
        <Alert type="error" header="状態の取得に失敗しました">
          {error}
        </Alert>
      )}
      {openError && (
        <Alert
          type="error"
          header="AWS Console を開けませんでした"
          dismissible
          onDismiss={() => setOpenError(null)}
        >
          {openError}
        </Alert>
      )}

      <Alert type="info" header="使い方">
        <Box variant="p">
          下のボタンを押すと新しいタブで AWS Console (CloudFormation スタック画面)
          が自動でログイン状態で開きます。session の TTL は 1 時間です。
        </Box>
      </Alert>

      {isBackend && !view && !error && <Box>状態を取得中…</Box>}

      {view && view.problems.length === 0 && (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">問題がありません</Box>
          </Box>
        </Container>
      )}

      {view?.problems
        .filter((p) => p.awsAccountId)
        .map((problem) => (
          <Container
            key={problem.jobId}
            header={
              <Header
                variant="h2"
                actions={
                  <Button
                    variant="primary"
                    iconName="external"
                    loading={pending === problem.jobId}
                    disabled={pending !== null && pending !== problem.jobId}
                    ariaLabel={`${problem.problemId} の AWS Console を開く`}
                    onClick={() => void openConsole(problem.jobId)}
                  >
                    AWS Console を開く
                  </Button>
                }
              >
                <code>{problem.problemId}</code>
              </Header>
            }
          >
            {/* Issue #821: deploy status (= COMPLETE 等) は競技者には無関係なので
                出さない。 AWS Account ID + Region で足りる。 */}
            <KeyValuePairs
              columns={2}
              items={[
                { label: "AWS Account", value: <code>{problem.awsAccountId}</code> },
                { label: "Region", value: problem.region },
              ]}
            />
          </Container>
        ))}
    </SpaceBetween>
  );
}
