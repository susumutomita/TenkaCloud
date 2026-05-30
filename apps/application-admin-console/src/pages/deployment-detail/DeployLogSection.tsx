import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useCallback, useRef } from "react";
import {
  type DeploymentSummary,
  type StackProgress,
  TERMINAL_STATUSES,
} from "../../api/deploy-client";
import type { DeployPhase } from "../../lib/deploy-phases";
import { PhaseRow } from "./PhaseRow";
import type { StackProgressErrorState, TFn } from "./types";
import { POLL_INTERVAL_MS } from "./useDeploymentDetail";

/**
 * Deploy log section — phase list を ExpandableSection で並べる Netlify-style 区画。
 * scroll-to-top / scroll-to-bottom / maximize ボタンを header に揃える。
 */
export function DeployLogSection({
  deployment,
  phases,
  stackProgress,
  stackProgressError,
  stackProgressPending,
  onMaximize,
  t,
}: {
  readonly deployment: DeploymentSummary;
  readonly phases: readonly DeployPhase[];
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: StackProgressErrorState | null;
  readonly stackProgressPending: boolean;
  readonly onMaximize: () => void;
  readonly t: TFn;
}) {
  const deployLogRef = useRef<HTMLDivElement | null>(null);

  const scrollDeployLog = useCallback((direction: "top" | "bottom") => {
    const el = deployLogRef.current;
    // ref は描画済 div を指すので button 押下時は常に non-null (= この guard は防御、不到達)。
    /* v8 ignore next */
    if (!el) return;
    el.scrollIntoView({ block: direction === "top" ? "start" : "end", behavior: "smooth" });
  }, []);

  return (
    <div ref={deployLogRef}>
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="icon"
                  iconName="angle-up"
                  ariaLabel={t("deployment_detail.log_scroll_top")}
                  onClick={() => scrollDeployLog("top")}
                />
                <Button
                  variant="icon"
                  iconName="angle-down"
                  ariaLabel={t("deployment_detail.log_scroll_bottom")}
                  onClick={() => scrollDeployLog("bottom")}
                />
                <Button iconName="expand" onClick={onMaximize} data-testid="maximize-log">
                  {t("deployment_detail.log_maximize")}
                </Button>
              </SpaceBetween>
            }
            description={
              !TERMINAL_STATUSES.has(deployment.status)
                ? t("deployment_detail.log_auto_refresh", {
                    seconds: POLL_INTERVAL_MS / 1000,
                  })
                : undefined
            }
          >
            {t("deployment_detail.deploy_log_header")}
          </Header>
        }
      >
        <SpaceBetween size="xxs">
          {phases.map((phase) => (
            <PhaseRow
              key={phase.id}
              phase={phase}
              deployment={deployment}
              stackProgress={stackProgress}
              stackProgressError={stackProgressError}
              stackProgressPending={stackProgressPending}
              t={t}
            />
          ))}
        </SpaceBetween>
      </Container>
    </div>
  );
}
