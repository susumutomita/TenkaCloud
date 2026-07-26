/**
 * 学習ドリル画面。
 *
 * `@tenkacloud/crypto-drill` が持つ 15 節を 1 節ずつ表示し、進捗を localStorage に置く。
 * AWS への依存が無いので、deploy 前でも `make dev` でそのまま動く (= 問題が 1 つも
 * deploy されていない状態の競技者にも最初から届く導線になる)。
 *
 * 現在位置は常に上部に出す (`██████□□□□□□` + `6 / 15`)。節の移動は前後ボタンと番号
 * インデックスの 2 経路で、狭い画面では番号インデックスが折り返す。
 */

import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import SpaceBetween from "@cloudscape-design/components/space-between";
import {
  completedSectionCount,
  type DrillProgress,
  firstIncompleteSection,
  isSectionComplete,
  localize,
  recordAttempt,
  renderProgressBar,
  revealNextHint,
  SHA256_DRILL,
} from "@tenkacloud/crypto-drill";
import { useCallback, useMemo, useState } from "react";
import "../components/crypto-drill/crypto-drill.css";
import { DrillSectionView } from "../components/crypto-drill/DrillSectionView";
import { useI18n } from "../i18n";
import { loadDrillProgress, saveDrillProgress } from "../lib/crypto-drill-storage";

/** 開始位置は「最初の未達成の節」。全部終わっていれば最初の節へ戻す。 */
export function initialSectionIndex(progress: DrillProgress): number {
  const target = firstIncompleteSection(SHA256_DRILL, progress);
  if (target === undefined) return 0;
  return SHA256_DRILL.sections.findIndex((section) => section.id === target.id);
}

export function CryptoDrillPage() {
  const { t, locale } = useI18n();
  const [progress, setProgress] = useState<DrillProgress>(() => loadDrillProgress(SHA256_DRILL.id));
  const [index, setIndex] = useState<number>(() => initialSectionIndex(progress));

  const persist = useCallback((next: DrillProgress) => {
    saveDrillProgress(next);
    setProgress(next);
  }, []);

  const onAttempt = useCallback(
    (taskId: string, passed: boolean) => {
      persist(recordAttempt(progress, taskId, passed));
    },
    [persist, progress],
  );

  const onRevealHint = useCallback(
    (taskId: string, hintCount: number) => {
      persist(revealNextHint(progress, taskId, hintCount));
    },
    [persist, progress],
  );

  const sections = SHA256_DRILL.sections;
  const total = sections.length;
  const done = useMemo(() => completedSectionCount(SHA256_DRILL, progress), [progress]);
  // `index` は前後ボタンと番号ボタンからしか変わらないので、 常に範囲内である
  // (?? による防御的 fallback は到達不能な分岐になるため置かない)。
  const section = sections[index];
  const drillTitle = localize(SHA256_DRILL.title, locale);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={localize(SHA256_DRILL.summary, locale)}>
        {drillTitle}
      </Header>

      <Container header={<Header variant="h2">{t("crypto_drill.progress_header")}</Header>}>
        <SpaceBetween size="s">
          <Box className="tc-drill-mono" data-testid="drill-progress-bar">
            {`${renderProgressBar(done, total)}  ${done} / ${total}`}
          </Box>
          <ProgressBar
            value={(done / total) * 100}
            label={t("crypto_drill.progress_label", { done, total })}
          />
          <div className="tc-drill-index">
            {sections.map((entry, entryIndex) => (
              <Button
                key={entry.id}
                variant={entryIndex === index ? "primary" : "normal"}
                onClick={() => setIndex(entryIndex)}
                data-testid={`drill-section-jump-${entry.order}`}
                ariaLabel={t("crypto_drill.section_heading", {
                  order: entry.order,
                  title: localize(entry.title, locale),
                })}
              >
                {isSectionComplete(entry, progress) ? `${entry.order} ✓` : String(entry.order)}
              </Button>
            ))}
          </div>
        </SpaceBetween>
      </Container>

      <DrillSectionView
        drillTitle={drillTitle}
        section={section}
        progress={progress}
        locale={locale}
        t={t}
        onAttempt={onAttempt}
        onRevealHint={onRevealHint}
      />

      <SpaceBetween size="xs" direction="horizontal">
        <Button disabled={index === 0} onClick={() => setIndex(index - 1)} data-testid="drill-prev">
          {t("crypto_drill.previous")}
        </Button>
        <Button
          variant="primary"
          disabled={index === total - 1}
          onClick={() => setIndex(index + 1)}
          data-testid="drill-next"
        >
          {t("crypto_drill.next")}
        </Button>
      </SpaceBetween>
    </SpaceBetween>
  );
}
