import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { ParticipantProblemView, ProblemCatalogEntry } from "@tenkacloud/portal-contracts";
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

export function learningGuideHref(
  base: string,
  role: "participant" | "organizer",
  locale: LocaleCode,
): string {
  return new URL(
    `../docs/manual/${role}/${locale === "en" ? "index.en.html" : ""}`,
    new URL(base, "https://preview.invalid"),
  ).pathname;
}

// Display themes come from subject tags, never the hosting provider. Unmatched
// problems remain in the complete catalog below; metadata and scoring are unchanged.
export function practiceTheme(
  entry: Pick<ProblemCatalogEntry, "tags"> & { id?: string },
): "social" | "cloud" | "web" | null {
  const tags = new Set(entry.tags);
  if (tags.has("social-engineering") || tags.has("phishing-awareness")) return "social";
  if (
    entry.id === "security-battle-royale" ||
    ["platform-engineering", "microservices", "ec2", "ssm", "aws"].some((tag) => tags.has(tag))
  )
    return "cloud";
  if (["web-security", "web-app", "wordpress"].some((tag) => tags.has(tag))) return "web";
  return null;
}
export function practiceHref(base: string, jobId: string): string {
  return new URL(`problems/${encodeURIComponent(jobId)}`, new URL(base, "https://preview.invalid"))
    .pathname;
}

function practiceName(entry: ProblemCatalogEntry, locale: LocaleCode): string {
  return locale === "en" ? (entry.i18n?.en?.name ?? entry.name) : entry.name;
}
const featuredPracticeIds = [
  "stackstack",
  "security-battle-royale",
  "stackstack-safe-exposure",
  "stackstack-secrets",
  "xss-demo",
];
function practicePriority(id: string): number {
  const index = featuredPracticeIds.indexOf(id);
  return index === -1 ? featuredPracticeIds.length : index;
}
export function practiceSourceHref(
  entry: Pick<ProblemCatalogEntry, "id" | "category">,
  locale: LocaleCode,
): string {
  const folder = entry.category === "Battle" ? "battles" : "challenges";
  return `https://github.com/susumutomita/TenkaCloudChallenge/blob/main/${folder}/${encodeURIComponent(entry.id)}/README${locale === "ja" ? ".ja" : ""}.md`;
}

/** Theme navigation in the public demo; games never become competition catalog entries. */
export function FoundationGames({
  catalog = [],
  problems = [],
}: {
  catalog?: readonly ProblemCatalogEntry[];
  problems?: readonly ParticipantProblemView[];
}) {
  const config = useAppConfig();
  const { locale, setLocale } = useI18n();
  const t = useT();
  useEffect(() => {
    if (config.mode !== "dev-mock" || config.cloudMode !== "mock") return;
    const requested = new URLSearchParams(window.location.search).get("lang");
    if (requested === "ja" || requested === "en") setLocale(requested);
  }, [config.mode, config.cloudMode, setLocale]);
  useEffect(() => {
    if (config.mode !== "dev-mock" || config.cloudMode !== "mock") return;
    const id = window.location.hash.slice(1);
    if (!["social-practice", "cloud-practice", "web-practice"].includes(id)) return;
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [config.mode, config.cloudMode]);
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
      <SpaceBetween size="l">
        {(["social", "cloud", "web"] as const).map((theme) => {
          const game = { social: "mail-detective", cloud: "cloud-master", web: null }[theme] as
            | "mail-detective"
            | "cloud-master"
            | null;
          const entries = catalog
            .filter(
              (entry) =>
                entry.status === "ready" &&
                entry.visibility === "public" &&
                ["docker", "aws"].includes(entry.runtime.provider) &&
                practiceTheme(entry) === theme,
            )
            .sort(
              (a, b) => practicePriority(a.id) - practicePriority(b.id) || a.id.localeCompare(b.id),
            );
          return (
            <SpaceBetween key={theme} size="s">
              <Box variant="h3">
                <span id={`${theme}-practice`}>{t(`foundation_games.themes.${theme}`)}</span>
              </Box>
              {game ? (
                <>
                  <Box color="text-body-secondary">
                    {t(`foundation_games.${game}.description`)} {t("foundation_games.browser")}
                  </Box>
                  <Button href={foundationGameHref(import.meta.env.BASE_URL, game, locale)}>
                    {t("foundation_games.play", { name: t(`foundation_games.${game}.title`) })}
                  </Button>
                </>
              ) : null}
              {entries.length === 0 ? (
                <Box color="text-body-secondary">{t("foundation_games.no_ready_practice")}</Box>
              ) : (
                entries.map((entry) => {
                  const problem = problems.find((candidate) => candidate.problemId === entry.id);
                  const name = practiceName(entry, locale);
                  return (
                    <SpaceBetween key={entry.id} size="xs">
                      <Box variant="strong">{name}</Box>
                      <Box color="text-body-secondary">
                        {t(
                          entry.runtime.provider === "docker"
                            ? "foundation_games.local_condition"
                            : "foundation_games.cloud_condition",
                        )}
                      </Box>
                      <SpaceBetween direction="horizontal" size="s">
                        {problem ? (
                          <Button href={practiceHref(import.meta.env.BASE_URL, problem.jobId)}>
                            {t("foundation_games.view_practice")}
                          </Button>
                        ) : null}
                        <Button href={practiceSourceHref(entry, locale)}>
                          {t("foundation_games.problem_description")}
                        </Button>
                        <Button
                          href={`${learningGuideHref(import.meta.env.BASE_URL, "organizer", locale)}#${entry.runtime.provider === "docker" ? "prepare-local-host" : "aws-problems"}`}
                        >
                          {t("foundation_games.setup_practice")}
                        </Button>
                      </SpaceBetween>
                    </SpaceBetween>
                  );
                })
              )}
            </SpaceBetween>
          );
        })}
        <Box color="text-body-secondary">{t("foundation_games.demo_only")}</Box>
        <SpaceBetween direction="horizontal" size="s">
          <Button href={learningGuideHref(import.meta.env.BASE_URL, "participant", locale)}>
            {t("foundation_games.participant_guide")}
          </Button>
          <Button href={learningGuideHref(import.meta.env.BASE_URL, "organizer", locale)}>
            {t("foundation_games.organizer_guide")}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  );
}
