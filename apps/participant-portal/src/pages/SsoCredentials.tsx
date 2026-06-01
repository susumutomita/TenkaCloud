import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import {
  getConsoleSigninUrl,
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { CliCredentialsPanel } from "../components/CliCredentialsPanel";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";

type TranslateFn = (key: string, vars?: Record<string, string>) => string;

/**
 * 「Console 開く」 ボタン押下時の error → 表示文字列 / 動作 への変換。
 * 戻り値が `"auth_logout"` のときは 「session 期限切れにつき logout する」 シグナル。
 * それ以外の文字列は Alert に出すメッセージ。
 */
function describeOpenConsoleError(err: unknown, t: TranslateFn): string {
  if (err instanceof PortalAuthError) return "auth_logout";
  if (err instanceof PortalAssumeRoleError) {
    // Issue #1197: stage を翻訳して 「どちらの段が落ちたか」 を表示する。
    return t("sso_credentials.cli.assume_role_failed", {
      stage: t(`sso_credentials.cli.stage_${err.stage}`),
      reason: err.reason,
    });
  }
  if (err instanceof PortalValidationError) {
    return t("sso_credentials.validation_error", { errorCode: err.errorCode });
  }
  return toErrorMessage(err);
}

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
  const t = useT();
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error } = useTeamView();
  const isMock = useIsMock();

  const [pending, setPending] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const openConsole = async (jobId: string) => {
    if (!sessionToken || pending) return;
    // dev-mock mode: backend を呼ぶと localhost への fetch が "Failed to fetch" になるため、
    // 試行せず info メッセージで「モックでは AWS Console を開けません」 を表示する (= LP demo
    // 訪問者が clicked して赤い error alert に驚かないようにする)。
    if (isMock) {
      setOpenError(t("sso_credentials.mock_open_blocked"));
      return;
    }
    setPending(jobId);
    setOpenError(null);
    try {
      const loginUrl = await getConsoleSigninUrl(config.apiBaseUrl, sessionToken, jobId);
      window.open(loginUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      const message = describeOpenConsoleError(err, t);
      if (message === "auth_logout") {
        auth.logout();
        return;
      }
      setOpenError(message);
    } finally {
      setPending(null);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t("sso_credentials.description")}>
        {t("sso_credentials.title")}
      </Header>

      {error && (
        <Alert type="error" header={t("app.fetch_status_failed")}>
          {error}
        </Alert>
      )}
      {openError && (
        <Alert
          type={isMock ? "info" : "error"}
          header={
            isMock ? t("sso_credentials.mock_open_header") : t("sso_credentials.open_failed_header")
          }
          dismissible
          onDismiss={() => setOpenError(null)}
        >
          {openError}
        </Alert>
      )}

      <Alert type="info" header={t("sso_credentials.howto_header")}>
        <Box variant="p">{t("sso_credentials.howto_body")}</Box>
      </Alert>

      {!isMock && !view && !error && <Box>{t("app.loading")}</Box>}

      {view && view.problems.length === 0 && (
        <Container>
          <Box textAlign="center" padding="l">
            <Box variant="strong">{t("sso_credentials.empty_problems")}</Box>
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
                    ariaLabel={t("sso_credentials.open_console_aria", {
                      problemId: problem.problemId,
                    })}
                    onClick={() => void openConsole(problem.jobId)}
                  >
                    {t("sso_credentials.open_console_button")}
                  </Button>
                }
              >
                <code>{problem.problemId}</code>
              </Header>
            }
          >
            <SpaceBetween size="m">
              <KeyValuePairs
                columns={2}
                items={[
                  {
                    label: t("sso_credentials.label_aws_account"),
                    value: <code>{problem.awsAccountId}</code>,
                  },
                  { label: t("sso_credentials.label_region"), value: problem.region },
                ]}
              />
              {sessionToken && (
                <CliCredentialsPanel
                  apiBaseUrl={config.apiBaseUrl}
                  sessionToken={sessionToken}
                  jobId={problem.jobId}
                  onAuthError={auth.logout}
                  mockBlocked={isMock}
                />
              )}
            </SpaceBetween>
          </Container>
        ))}
    </SpaceBetween>
  );
}
