import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { normalizeSimulatorEndpointUrl } from "@tenkacloud/portal-contracts";
import type { SimulatorConnectionInfo } from "../../api/competitor-accounts-client";
import { useT } from "../../i18n";

/** Text only: simulator setup must never emit AWS URLs, ExternalId or shareable secrets. */
export function SimulatorConnectionNotice({ simulator }: { simulator: SimulatorConnectionInfo }) {
  const t = useT();
  let endpoint: string;
  try {
    endpoint = normalizeSimulatorEndpointUrl(simulator.endpoint);
  } catch {
    return <Alert type="error">{t("competitor_accounts.simulator_invalid")}</Alert>;
  }
  return (
    <Alert type="info" header={t("competitor_accounts.simulator_header")}>
      <SpaceBetween size="xs">
        <Box>{t("competitor_accounts.simulator_body")}</Box>
        <Box>AWS_ENDPOINT_URL: {endpoint}</Box>
        <Box>
          {t("competitor_accounts.add_modal_account_id_label")}: {simulator.awsAccountId}
        </Box>
        <Box>
          {t("competitor_accounts.add_modal_role_label")}: {simulator.bootstrapRoleName}
        </Box>
        <Box>{t("competitor_accounts.simulator_verify")}</Box>
      </SpaceBetween>
    </Alert>
  );
}
