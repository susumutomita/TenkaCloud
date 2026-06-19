import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import KeyValuePairs from "@cloudscape-design/components/key-value-pairs";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useAuth } from "../auth/AuthProvider";
import { useTeamView } from "../auth/TeamViewProvider";
import { CliCredentialsPanel } from "../components/CliCredentialsPanel";
import { useConsoleAccess } from "../components/useConsoleAccess";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { useT } from "../i18n";

/**
 * AWS Console ワンクリック login。競技者は自前 AWS ログイン不要で、Portal の button
 * を押すと backend Lambda が STS AssumeRole + signin federation を実行して
 * `signin.aws.amazon.com/federation?Action=login` URL を発行 → 新タブで開く。
 *
 * Lambda が assume するのは `ConsoleViewerRole` (= ReadOnlyAccess managed policy)。
 * 競技者は AWS Console で stack 状態を read-only で確認可能。開く処理は `useConsoleAccess`
 * に集約し、TopNavigation の常設 Console 導線 (Issue #1919) と共有する。
 */
export function SsoCredentialsPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const t = useT();
  const sessionToken = auth.session?.sessionToken ?? null;
  const { view, error } = useTeamView();
  const isMock = useIsMock();
  const { openConsole, pending, error: openError, dismissError } = useConsoleAccess(config);

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
          type={openError.isMock ? "info" : "error"}
          header={
            openError.isMock
              ? t("sso_credentials.mock_open_header")
              : t("sso_credentials.open_failed_header")
          }
          dismissible
          onDismiss={dismissError}
        >
          {openError.message}
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
