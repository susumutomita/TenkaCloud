import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { FriendlyErrorAlert } from "../../components/FriendlyErrorAlert";
import type { AppConfig } from "../../config";
import { useT } from "../../i18n";
import { PROVIDER_OPTIONS, useTeamCloudCredentials } from "./useTeamCloudCredentials";

/**
 * Issue #1413: per-team cloud credential onboarding パネル。
 *
 * TenantAdmin が非 AWS 問題 (sakura/azure/gcp) を deploy する前に、 team の認証情報 (provider 別 JSON) を
 * `PUT /admin/team-cloud-credentials/:provider/:teamSlug` で SSM SecureString store に登録 / 失効する。
 * data/effect 層は `useTeamCloudCredentials` view-model hook に集約してあり、 本 component は
 * その state を Cloudscape にレンダリングする presentation に徹する (= SRP)。 credential JSON の形は
 * provider 別で backend が Zod 検証するため、 ここでは textarea で受ける (= 画面側で per-provider field を
 * 持たず 2 重メンテを避ける)。 secret は送るだけで status では返らない。
 */

export function TeamCloudCredentialsPanel({ config }: { config: AppConfig }) {
  const t = useT();
  const vm = useTeamCloudCredentials(config);

  return (
    <Container header={<Header variant="h2">{t("team_cloud_credentials.title")}</Header>}>
      <SpaceBetween size="m">
        <Box color="text-body-secondary">{t("team_cloud_credentials.description")}</Box>
        {/* #2167: 前提 (どの CLI で何を作り、どのフィールドを入れるか) の inline help。 */}
        <ExpandableSection
          variant="footer"
          headerText={t("team_cloud_credentials.setup_help_title")}
        >
          <SpaceBetween size="xxs">
            <Box variant="small">{t("team_cloud_credentials.setup_help_enable")}</Box>
            <Box variant="small">{t("team_cloud_credentials.setup_help_sakura")}</Box>
            <Box variant="small">{t("team_cloud_credentials.setup_help_azure")}</Box>
            <Box variant="small">{t("team_cloud_credentials.setup_help_gcp")}</Box>
            <Box variant="small">{t("team_cloud_credentials.setup_help_ssm_note")}</Box>
          </SpaceBetween>
        </ExpandableSection>
        {vm.error && <FriendlyErrorAlert error={vm.error} />}
        {vm.notice && (
          <Alert type="success" dismissible onDismiss={vm.dismissNotice}>
            {vm.notice}
          </Alert>
        )}
        <FormField label={t("team_cloud_credentials.provider_label")}>
          <Select
            selectedOption={vm.providerOption}
            options={PROVIDER_OPTIONS}
            disabled={vm.inFlight}
            onChange={(e) => vm.setProvider(e.detail.selectedOption.value as string)}
          />
        </FormField>
        <FormField
          label={t("team_cloud_credentials.team_label")}
          description={t("team_cloud_credentials.team_description")}
          errorText={vm.slugInvalid ? t("team_cloud_credentials.team_invalid") : undefined}
        >
          <Input
            value={vm.teamSlug}
            onChange={(e) => vm.setTeamSlug(e.detail.value)}
            invalid={vm.slugInvalid}
            placeholder="team-a"
            disabled={vm.inFlight}
          />
        </FormField>
        <FormField
          label={t("team_cloud_credentials.credential_label")}
          description={t("team_cloud_credentials.credential_description")}
        >
          <Textarea
            value={vm.credentialJson}
            onChange={(e) => vm.setCredentialJson(e.detail.value)}
            placeholder='{"accessToken":"...","accessTokenSecret":"..."}'
            disabled={vm.inFlight}
            rows={5}
          />
        </FormField>
        <SpaceBetween direction="horizontal" size="xs">
          <Button
            variant="primary"
            loading={vm.inFlight}
            disabled={!vm.canRegister}
            onClick={() => void vm.register()}
          >
            {t("team_cloud_credentials.register_button")}
          </Button>
          <Button disabled={!vm.canSubmit} onClick={() => void vm.checkStatus()}>
            {t("team_cloud_credentials.status_button")}
          </Button>
          <Button disabled={!vm.canSubmit} onClick={() => void vm.revoke()}>
            {t("team_cloud_credentials.revoke_button")}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
