import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import Link from "@cloudscape-design/components/link";
import ProgressBar from "@cloudscape-design/components/progress-bar";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { EventSummary } from "../api/events-client";
import { interpolate, useT } from "../i18n";
import {
  deriveSetupGuideProgress,
  readSetupGuideDismissed,
  resolveSetupStepHref,
  writeSetupGuideDismissed,
} from "../lib/setup-guide";

/**
 * Issue #1773: 初回 Tenant Admin 向けセットアップガイド。
 * ① イベント作成 → ② 問題選択 → ③ チーム登録 → ④ デプロイ の 4 step checklist を
 * Event 一覧の上に出す。 完了判定は既存データから導出 (lib/setup-guide.ts)、 新規 backend なし。
 *
 *  - 全 step 完了で自動的に消える (= 経験者には出ない)
 *  - 「非表示にする」 で localStorage に永続化し、 以後表示しない (再表示導線は持たない)
 */
export function SetupGuide({ events }: { events: readonly EventSummary[] }) {
  const t = useT();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readSetupGuideDismissed);
  const progress = deriveSetupGuideProgress(events);
  if (dismissed || progress.allComplete) return null;

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={t("setup_guide.description")}
          actions={
            <Button
              onClick={() => {
                writeSetupGuideDismissed();
                setDismissed(true);
              }}
            >
              {t("setup_guide.dismiss")}
            </Button>
          }
        >
          {t("setup_guide.header")}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <ProgressBar
          value={(progress.completedCount / progress.totalCount) * 100}
          label={t("setup_guide.progress_label")}
          additionalInfo={interpolate(t("setup_guide.progress_info"), {
            completed: String(progress.completedCount),
            total: String(progress.totalCount),
          })}
        />
        {progress.steps.map((step, idx) => {
          const href = resolveSetupStepHref(step.id, events);
          return (
            <SpaceBetween key={step.id} direction="horizontal" size="s">
              <StatusIndicator type={step.complete ? "success" : "pending"}>
                {t(step.complete ? "setup_guide.status_complete" : "setup_guide.status_incomplete")}
              </StatusIndicator>
              <Box variant="span" fontWeight="bold">
                {idx + 1}. {t(`setup_guide.step_${step.id}_title`)}
              </Box>
              <Link
                href={href}
                onFollow={(e) => {
                  e.preventDefault();
                  navigate(href);
                }}
              >
                {t(`setup_guide.step_${step.id}_link`)}
              </Link>
            </SpaceBetween>
          );
        })}
      </SpaceBetween>
    </Container>
  );
}
