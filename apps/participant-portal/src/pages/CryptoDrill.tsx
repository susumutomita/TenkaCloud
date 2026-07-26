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

import Alert from "@cloudscape-design/components/alert";
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
import {
  type LoadedDrillProgress,
  loadDrillProgress,
  saveDrillProgress,
} from "../lib/crypto-drill-storage";

/** 開始位置は「最初の未達成の節」。全部終わっていれば最初の節へ戻す。 */
export function initialSectionIndex(progress: DrillProgress): number {
  const target = firstIncompleteSection(SHA256_DRILL, progress);
  if (target === undefined) return 0;
  return SHA256_DRILL.sections.findIndex((section) => section.id === target.id);
}

export function CryptoDrillPage() {
  const { t, locale } = useI18n();
  const [loaded] = useState<LoadedDrillProgress>(() => loadDrillProgress(SHA256_DRILL.id));
  const [progress, setProgress] = useState<DrillProgress>(loaded.progress);
  const [index, setIndex] = useState<number>(() => initialSectionIndex(loaded.progress));
  // storage が使えない端末 (private window / quota 超過) では進捗が残らない。 一度でも
  // 読み書きに失敗したら学習者へ伝える: 15 節進めた後の reload で初めて気づくのは損失が大きい。
  const [canPersist, setCanPersist] = useState<boolean>(loaded.persisted);

  const persist = useCallback((next: DrillProgress) => {
    if (!saveDrillProgress(next)) setCanPersist(false);
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

      {/* 進捗はこの端末の localStorage にあり、 採点はスコアに影響しない。 競技者が
       *  「解いたのにスコアが増えない」と誤解しないよう、 画面上で先に言う。 */}
      <Alert type="info" header={t("crypto_drill.self_study_header")}>
        {t("crypto_drill.self_study_body")}
      </Alert>

      {!canPersist && (
        <Alert type="warning" header={t("crypto_drill.no_persistence_header")}>
          {t("crypto_drill.no_persistence_body")}
        </Alert>
      )}

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
