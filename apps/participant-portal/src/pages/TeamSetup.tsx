import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Form from "@cloudscape-design/components/form";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import SpaceBetween from "@cloudscape-design/components/space-between";
import TopNavigation, {
  type TopNavigationProps,
} from "@cloudscape-design/components/top-navigation";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PortalAuthError, PortalValidationError, updateTeamName } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { type LocaleCode, SUPPORTED_LOCALES, useI18n, useT } from "../i18n";

const TEAM_NAME_RE = /^[A-Za-z0-9 _\-぀-ヿ一-鿿]{1,40}$/;

/** #1092: AppLayout の locale name と同期 (= 別 component に export せず literal で抑える)。 */
const LOCALE_DICTIONARIES_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
};

interface TeamNameDraft {
  readonly trimmed: string;
  readonly invalid: boolean;
}

interface TeamNameSubmitState extends TeamNameDraft {
  readonly sessionToken?: string;
  readonly submitting: boolean;
}

export function describeTeamNameDraft(teamName: string): TeamNameDraft {
  const trimmed = teamName.trim();
  return {
    trimmed,
    invalid: teamName.length > 0 && !TEAM_NAME_RE.test(trimmed),
  };
}

export function canSubmitTeamName(state: TeamNameSubmitState): boolean {
  return !!state.sessionToken && state.trimmed.length > 0 && !state.invalid && !state.submitting;
}

export function formatTeamSetupSubmitError(err: unknown, validationMessage: string): string {
  if (err instanceof PortalValidationError) return validationMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 競技者がログイン直後に通る team name 入力ページ。 `PATCH /portal/me` でサーバ側
 * `displayTeamName` を設定し、 AuthProvider のセッションを更新して `/` に戻る。
 *
 * Issue #1092: チーム未確定状態でも TopNavigation を描画する。 言語切替 picker を
 * この段階でも使えるようにし、 全文字列を i18n 経由に置き換える。 sidebar は team
 * 未確定では意味がないので出さない (= TopNavigation のみの light shell)。
 *
 * dev-mock モードはこのページに到達しない (AuthProvider が初期 session に
 * `teamNameSetByCompetitor=true` を入れる)。
 */
export function TeamSetupPage({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [teamName, setTeamName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = describeTeamNameDraft(teamName);
  const canSubmit = canSubmitTeamName({
    ...draft,
    sessionToken: auth.session?.sessionToken,
    submitting,
  });

  const handleSubmit = async () => {
    if (!canSubmit || !auth.session) return;
    setSubmitting(true);
    setError(null);
    try {
      const view = await updateTeamName(
        config.apiBaseUrl,
        auth.session.sessionToken,
        draft.trimmed,
      );
      auth.updateSession({
        teamName: view.team.teamName,
        teamNameSetByCompetitor: view.team.teamNameSetByCompetitor,
      });
      navigate("/");
    } catch (err) {
      if (err instanceof PortalAuthError) {
        auth.logout();
        navigate("/login");
        return;
      }
      setError(formatTeamSetupSubmitError(err, t("team_setup.validation_failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const utilities = useMemo<TopNavigationProps.Utility[]>(() => {
    const localeUtility: TopNavigationProps.Utility = {
      type: "menu-dropdown",
      iconName: "globe",
      ariaLabel: t("switcher.aria_label"),
      text: LOCALE_DICTIONARIES_NAME[locale] ?? locale,
      items: SUPPORTED_LOCALES.map((code) => ({
        id: code,
        text: LOCALE_DICTIONARIES_NAME[code] ?? code,
      })),
      onItemClick: ({ detail }) => {
        if ((SUPPORTED_LOCALES as readonly string[]).includes(detail.id)) {
          setLocale(detail.id as LocaleCode);
        }
      },
    };
    return [localeUtility];
  }, [locale, setLocale, t]);

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: `TenkaCloud — ${config.eventTitle}` }}
        utilities={utilities}
      />
      <Box padding="l" textAlign="center">
        <Container
          header={
            <Header variant="h1" description={t("team_setup.description")}>
              {t("team_setup.title")}
            </Header>
          }
        >
          <Form>
            <SpaceBetween size="l">
              {error && (
                <Alert type="error" header={t("team_setup.submit_failed_header")}>
                  {error}
                </Alert>
              )}
              <FormField
                label={t("team_setup.field_label")}
                description={t("team_setup.field_description")}
                constraintText={t("team_setup.field_constraint")}
                errorText={draft.invalid ? t("team_setup.field_invalid_format") : undefined}
              >
                <Input
                  value={teamName}
                  placeholder={t("team_setup.field_placeholder")}
                  disabled={submitting}
                  onChange={({ detail }) => setTeamName(detail.value)}
                  invalid={draft.invalid}
                />
              </FormField>
              <Button
                variant="primary"
                loading={submitting}
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {t("team_setup.submit_button")}
              </Button>
            </SpaceBetween>
          </Form>
        </Container>
      </Box>
    </>
  );
}
