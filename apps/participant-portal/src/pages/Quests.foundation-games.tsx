import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useEffect } from "react";
import { useAppConfig } from "../config-context";
import { type LocaleCode, useI18n, useT } from "../i18n";

export function foundationGameHref(
  base: string,
  game: "mail-detective" | "cloud-master",
  locale: LocaleCode,
): string {
  const target = new URL(`../${game}/`, new URL(base, "https://preview.invalid"));
  return `${target.pathname}?lang=${locale}`;
}

/** Separate static learning links in the public demo; never competition catalog entries. */
export function FoundationGames() {
  const config = useAppConfig();
  const { locale, setLocale } = useI18n();
  const t = useT();
  useEffect(() => {
    if (config.mode !== "dev-mock" || config.cloudMode !== "mock") return;
    const requested = new URLSearchParams(window.location.search).get("lang");
    if (requested === "ja" || requested === "en") setLocale(requested);
  }, [config.mode, config.cloudMode, setLocale]);
  if (config.mode !== "dev-mock" || config.cloudMode !== "mock") return null;
  return (
    <Container
      data-testid="foundation-games"
      header={
        <Header variant="h2" description={t("foundation_games.description")}>
          {t("foundation_games.title")}
        </Header>
      }
    >
      <ColumnLayout columns={2} variant="text-grid">
        {(["mail-detective", "cloud-master"] as const).map((game) => (
          <SpaceBetween key={game} size="s">
            <Box variant="h3">{t(`foundation_games.${game}.title`)}</Box>
            <Box color="text-body-secondary">{t(`foundation_games.${game}.description`)}</Box>
            <Button href={foundationGameHref(import.meta.env.BASE_URL, game, locale)}>
              {t("foundation_games.play", { name: t(`foundation_games.${game}.title`) })}
            </Button>
          </SpaceBetween>
        ))}
      </ColumnLayout>
    </Container>
  );
}
