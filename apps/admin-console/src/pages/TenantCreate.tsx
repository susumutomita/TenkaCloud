import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useApiClient } from "../api/client";
import { createTenant, type Tier } from "../api/tenants";
import type { AppConfig } from "../config";

const TIERS = [
  { value: "basic", label: "Basic" },
  { value: "advanced", label: "Advanced" },
  { value: "platinum", label: "Platinum (silo: per-tenant Cognito + Application Admin Console)" },
] as const satisfies readonly { value: Tier; label: string }[];

export function TenantCreatePage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);

  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState<(typeof TIERS)[number]>(TIERS[0]);
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
      header={<Header variant="h1">テナント作成</Header>}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => navigate("/tenants")}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={isSubmitDisabled}
            onClick={onSubmit}
          >
            作成
          </Button>
        </SpaceBetween>
      }
    >
      <Container>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" header="作成に失敗しました">
              {error}
            </Alert>
          )}
          <FormField label="テナント名" description="社内で識別する表示名">
            <Input
              value={tenantName}
              onChange={({ detail }) => setTenantName(detail.value)}
              placeholder="例: 品質管理部"
            />
          </FormField>
          <FormField label="管理者メール" description="初回 Cognito 招待メールの送信先">
            <Input
              value={email}
              type="email"
              onChange={({ detail }) => setEmail(detail.value)}
              placeholder="admin@example.com"
            />
          </FormField>
          <FormField label="Tier">
            <Select
              selectedOption={tier}
              options={TIERS}
              onChange={({ detail }) => setTier(detail.selectedOption as (typeof TIERS)[number])}
            />
          </FormField>
        </SpaceBetween>
      </Container>
    </Form>
  );
}
