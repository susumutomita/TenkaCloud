/**
 * 節 1 つ分の UI: 問題説明 → 図解 → 課題 → 解説 → 次のステップ。
 *
 * 解説と次のステップは既定で畳んでおき、その節の課題が全部通ったときだけ開いた状態で出す。
 * 採点前に解説を読むと「自分で計算する」段が飛ばされるため、順序に意味がある。
 */

import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import ExpandableSection from "@cloudscape-design/components/expandable-section";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import type { DrillProgress, DrillSection, LocaleCode } from "@tenkacloud/crypto-drill";
import { isSectionComplete, localize } from "@tenkacloud/crypto-drill";
import { DrillTaskCard } from "./DrillTaskCard";
import { DrillVisualView } from "./DrillVisualView";

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface DrillSectionViewProps {
  readonly drillTitle: string;
  readonly section: DrillSection;
  readonly progress: DrillProgress;
  readonly locale: LocaleCode;
  readonly t: Translate;
  readonly onAttempt: (taskId: string, passed: boolean) => void;
  readonly onRevealHint: (taskId: string, hintCount: number) => void;
}

export function DrillSectionView({
  drillTitle,
  section,
  progress,
  locale,
  t,
  onAttempt,
  onRevealHint,
}: DrillSectionViewProps) {
  const complete = isSectionComplete(section, progress);
  return (
    <SpaceBetween size="l">
      <Header variant="h2" description={localize(section.goal, locale)}>
        {t("crypto_drill.section_heading", {
          order: section.order,
          title: localize(section.title, locale),
        })}
      </Header>

      <Container header={<Header variant="h3">{t("crypto_drill.reading_header")}</Header>}>
        <SpaceBetween size="s">
          {section.reading.map((paragraph) => (
            <Box key={localize(paragraph, "en")} variant="p">
              {localize(paragraph, locale)}
            </Box>
          ))}
        </SpaceBetween>
      </Container>

      {section.visual !== undefined && (
        <Container header={<Header variant="h3">{t("crypto_drill.figure_header")}</Header>}>
          <DrillVisualView visual={section.visual} locale={locale} />
        </Container>
      )}

      {section.tasks.map((task) => (
        <DrillTaskCard
          key={task.id}
          drillTitle={drillTitle}
          section={section}
          task={task}
          progress={progress}
          locale={locale}
          t={t}
          onAttempt={onAttempt}
          onRevealHint={onRevealHint}
        />
      ))}

      <ExpandableSection
        headerText={t("crypto_drill.explanation_header")}
        defaultExpanded={complete}
        variant="container"
      >
        <SpaceBetween size="s">
          {section.explanation.map((paragraph) => (
            <Box key={localize(paragraph, "en")} variant="p">
              {localize(paragraph, locale)}
            </Box>
          ))}
          <Box variant="p" fontWeight="bold">
            {t("crypto_drill.next_step_label")}
          </Box>
          <Box variant="p">{localize(section.nextStep, locale)}</Box>
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  );
}
