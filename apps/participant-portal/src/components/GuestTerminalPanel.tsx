import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { toErrorMessage } from "@tenkacloud/web-kit";
import { useState } from "react";
import {
  type GuestTerminalHandoff,
  getGuestTerminal,
  PortalAssumeRoleError,
  PortalAuthError,
  PortalValidationError,
} from "../api/portal-client";
import { useT } from "../i18n";
import { describeAwsAccessError } from "./describeAwsAccessError";

/**
 * Simulator Battle: a shell inside the team's guest server, through the Simulator's own
 * participant terminal page. The host issues a one-use code signed with the team's viewer role;
 * the participant pastes it into that page. The code is kept in state only and never in a URL.
 */
export function GuestTerminalPanel({
  apiBaseUrl,
  sessionToken,
  jobId,
  onAuthError,
  mockBlocked = false,
}: {
  readonly apiBaseUrl: string;
  readonly sessionToken: string;
  readonly jobId: string;
  readonly onAuthError: () => void;
  readonly mockBlocked?: boolean;
}) {
  const t = useT();
  const [handoff, setHandoff] = useState<GuestTerminalHandoff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issue = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setHandoff(await getGuestTerminal(apiBaseUrl, sessionToken, jobId));
    } catch (err) {
      if (err instanceof PortalAuthError) {
        onAuthError();
        return;
      }
      if (err instanceof PortalAssumeRoleError) {
        setError(describeAwsAccessError(err, t));
        return;
      }
      if (err instanceof PortalValidationError) {
        setError(t("sso_credentials.validation_error", { errorCode: err.errorCode }));
        return;
      }
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ExpandableSection
      variant="footer"
      defaultExpanded
      headerText={t("sso_credentials.terminal.section_header")}
    >
      <SpaceBetween size="s">
        <Box variant="small" color="text-body-secondary">
          {t("sso_credentials.terminal.body")}
        </Box>
        {error && (
          <Alert
            type="error"
            header={t("sso_credentials.terminal.error_header")}
            dismissible
            onDismiss={() => setError(null)}
          >
            {error}
          </Alert>
        )}
        {mockBlocked && <Alert type="info">{t("sso_credentials.terminal.mock_blocked")}</Alert>}
        {!mockBlocked && (
          <Button iconName="key" loading={loading} disabled={loading} onClick={() => void issue()}>
            {handoff
              ? t("sso_credentials.terminal.reissue_button")
              : t("sso_credentials.terminal.issue_button")}
          </Button>
        )}
        {handoff && (
          <SpaceBetween size="xs">
            <Box variant="small">
              {t("sso_credentials.terminal.code_label", {
                expiresAt: new Date(handoff.expiresAt).toLocaleTimeString(),
              })}
            </Box>
            <Box variant="code">{handoff.code}</Box>
            <SpaceBetween size="xs" direction="horizontal">
              <Button
                iconName="copy"
                onClick={() => void navigator.clipboard?.writeText(handoff.code)}
              >
                {t("sso_credentials.terminal.copy_button")}
              </Button>
              <Button
                variant="primary"
                iconName="external"
                href={handoff.terminalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("sso_credentials.terminal.open_button")}
              </Button>
            </SpaceBetween>
            <Box variant="small" color="text-body-secondary">
              {t("sso_credentials.terminal.steps")}
            </Box>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ExpandableSection>
  );
}
