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
import { useT } from "../i18n";

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
  const isBackend = config.mode === "backend";

  const [pending, setPending] = useState<string | null>(null);
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
        setOpenError(t("sso_credentials.validation_error", { errorCode: err.errorCode }));
        return;
      }
      setOpenError(err instanceof Error ? err.message : String(err));
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
          type="error"
          header={t("sso_credentials.open_failed_header")}
          dismissible
          onDismiss={() => setOpenError(null)}
        >
          {openError}
        </Alert>
      )}

      <Alert type="info" header={t("sso_credentials.howto_header")}>
        <Box variant="p">{t("sso_credentials.howto_body")}</Box>
      </Alert>

      {isBackend && !view && !error && <Box>{t("app.loading")}</Box>}

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
          </Container>
        ))}
    </SpaceBetween>
  );
}
