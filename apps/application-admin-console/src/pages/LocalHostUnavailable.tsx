import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useNavigate } from "react-router";
import { useT } from "../i18n";

/**
 * Issue #3226: a console screen that needs cloud infrastructure, opened on the local
 * competition host. It says so plainly instead of calling an API the host does not have.
 */
export function LocalHostUnavailablePage() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{t("local_host.unavailable_header")}</Header>
      <Alert
        type="info"
        action={<Button onClick={() => navigate("/events")}>{t("local_host.go_to_events")}</Button>}
      >
        {t("local_host.unavailable_body")}
      </Alert>
    </SpaceBetween>
  );
}
