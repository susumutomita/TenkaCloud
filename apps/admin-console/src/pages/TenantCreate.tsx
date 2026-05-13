import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { createTenant, type Tier } from "../api/tenants";
import type { AppConfig } from "../config";
import { useT } from "../i18n";

const TIER_VALUES: readonly Tier[] = ["basic", "advanced", "platinum"];

export function TenantCreatePage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);
  const t = useT();

  const tierOptions = useMemo(
    () =>
      TIER_VALUES.map((value) => ({
        value,
        label: t(`tenant_create.tier_${value}`),
      })),
    [t],
  );

  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState<(typeof tierOptions)[number]>(tierOptions[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSubmitDisabled = tenantName.trim().length === 0 || email.trim().length === 0;

  const onSubmit = async () => {
    if (!api || isSubmitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await createTenant(api, {
        tenantName: tenantName.trim(),
        email: email.trim(),
        tier: tier.value,
      });
      navigate("/tenants");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Form
      header={<Header variant="h1">{t("tenant_create.header")}</Header>}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => navigate("/tenants")}>
            {t("tenant_create.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={isSubmitDisabled}
            onClick={onSubmit}
          >
            {t("tenant_create.submit")}
          </Button>
        </SpaceBetween>
      }
    >
      <Container>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" header={t("tenant_create.error_header")}>
              {error}
            </Alert>
          )}
          <FormField
            label={t("tenant_create.name_label")}
            description={t("tenant_create.name_description")}
          >
            <Input
              value={tenantName}
              onChange={({ detail }) => setTenantName(detail.value)}
              placeholder={t("tenant_create.name_placeholder")}
            />
          </FormField>
          <FormField
            label={t("tenant_create.email_label")}
            description={t("tenant_create.email_description")}
          >
            <Input
              value={email}
              type="email"
              onChange={({ detail }) => setEmail(detail.value)}
              placeholder={t("tenant_create.email_placeholder")}
            />
          </FormField>
          <FormField label={t("tenant_create.tier_label")}>
            <Select
              selectedOption={tier}
              options={tierOptions}
              onChange={({ detail }) =>
                setTier(detail.selectedOption as (typeof tierOptions)[number])
              }
            />
          </FormField>
        </SpaceBetween>
      </Container>
    </Form>
  );
}
