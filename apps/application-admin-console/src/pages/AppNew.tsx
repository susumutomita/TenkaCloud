import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useState } from "react";
import { useNavigate } from "react-router";
import { createApp } from "../api/apps";
import { useApiClient } from "../api/client";
import type { AppConfig } from "../config";

export function AppNewPage({ config }: { config: AppConfig }) {
  const navigate = useNavigate();
  const api = useApiClient(config);

  const [name, setName] = useState("");
  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [allowedEmailDomains, setAllowedEmailDomains] = useState("");
  const [guestEmails, setGuestEmails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedDomains = parseDomainList(allowedEmailDomains);
  const isSubmitDisabled =
    name.trim().length === 0 || upstreamUrl.trim().length === 0 || parsedDomains.length === 0;

  const onSubmit = async () => {
    if (!api || isSubmitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await createApp(api, {
        name: name.trim(),
        upstreamUrl: upstreamUrl.trim(),
        allowedEmailDomains: parsedDomains,
        guestEmails: parseGuestEmails(guestEmails),
      });
      navigate("/apps");
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Form
      header={
        <Header
          variant="h1"
          description="バイブコーディングしたアプリを認証付きで公開します。Function URL が払い出されるまで数十秒かかります。"
        >
          アプリを公開する
        </Header>
      }
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => navigate("/apps")}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            disabled={isSubmitDisabled}
            onClick={onSubmit}
          >
            公開する
          </Button>
        </SpaceBetween>
      }
    >
      <Container>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" header="公開に失敗しました">
              {error}
            </Alert>
          )}
          <FormField label="アプリ名" description="社内で識別する表示名">
            <Input
              value={name}
              onChange={({ detail }) => setName(detail.value)}
              placeholder="例: 工数集計ツール"
            />
          </FormField>
          <FormField
            label="Upstream URL"
            description="認証プロキシが前段に立つ、既存アプリの URL (https:// 推奨)"
          >
            <Input
              value={upstreamUrl}
              onChange={({ detail }) => setUpstreamUrl(detail.value)}
              placeholder="https://my-app.example.com"
            />
          </FormField>
          <FormField
            label="許可ドメイン"
            description="ここに登録したドメインのメールアドレスでサインインしないとアプリにアクセスできません (必須、最低 1 つ)"
            constraintText="カンマまたは改行区切り。例: denso.co.jp, jaxa.jp"
          >
            <Textarea
              value={allowedEmailDomains}
              onChange={({ detail }) => setAllowedEmailDomains(detail.value)}
              placeholder="denso.co.jp, jaxa.jp"
            />
          </FormField>
          <FormField
            label="ゲストユーザー"
            description="アプリ公開と同時にブローカー Entra ID に招待するメールアドレス (任意)"
            constraintText="許可ドメインに含まれるメールアドレスのみ"
          >
            <Textarea
              value={guestEmails}
              onChange={({ detail }) => setGuestEmails(detail.value)}
              placeholder="user@denso.co.jp, another@denso.co.jp"
            />
          </FormField>
        </SpaceBetween>
      </Container>
    </Form>
  );
}

function parseGuestEmails(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\s]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function parseDomainList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}
