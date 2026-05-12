/**
 * ADR-012 Phase 5: problem 側 plugin (= metadata.dashboard.slots) を render する wrapper。
 *
 * 1 metadata に複数 slot が宣言されているケース (= StatusPanel / RegistrationPanel /
 * HelpDrawer) を順に loadPluginSlot で React.lazy 化し、 Suspense + ErrorBoundary で
 * 包んで render する。 plugin の load 失敗 / runtime crash は fallback message に降格
 * (= 標準 panel を出さない判断 — plugin がある問題は plugin 前提で設計されている)。
 *
 * 設計判断:
 *   - chunk 分割は loadPluginSlot 内の Vite glob で自動。 portal SPA 起動時に plugin chunk は
 *     fetch しない (= Suspense が解決時に fetch 開始)。
 *   - Error boundary は class component (= React の boundary mechanism)。 plugin runtime
 *     crash で portal 全体が落ちるのを防ぐ。
 *   - PORTAL_SLOT_NAMES の literal 順で render する (= UI 上の表示順を予測可能にする)。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import { PORTAL_SLOT_NAMES, type PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";
import { Component, type ErrorInfo, type ReactNode, Suspense } from "react";
import { loadPluginSlot } from "./loader";
import {
  buildPortalDisruptions,
  buildPortalEndpointsFromOutputs,
  buildPortalPhases,
} from "./props-builder";

interface PortalPluginSlotsProps {
  readonly problemId: string;
  readonly jobId: string;
  readonly score: number;
  readonly team: PortalSlotProps["team"];
  readonly stackOutputs: Record<string, string>;
}

export function PortalPluginSlots({
  problemId,
  jobId,
  score,
  team,
  stackOutputs,
}: PortalPluginSlotsProps) {
  // props-builder で metadata と stackOutputs を marshal して PortalSlotProps shape にする。
  const endpoints = buildPortalEndpointsFromOutputs(problemId, stackOutputs);
  const phases = buildPortalPhases(problemId);
  const disruptions = buildPortalDisruptions(problemId);
  const nowIso = new Date().toISOString();
  const slotProps: PortalSlotProps = {
    team,
    problemId,
    jobId,
    score,
    endpoints,
    phases,
    disruptions,
    nowIso,
  };

  const slotsToRender = PORTAL_SLOT_NAMES.map((slotName) => {
    const Comp = loadPluginSlot(problemId, slotName);
    return Comp ? { slotName, Comp } : null;
  }).filter(
    (
      s,
    ): s is {
      slotName: (typeof PORTAL_SLOT_NAMES)[number];
      Comp: NonNullable<ReturnType<typeof loadPluginSlot>>;
    } => s !== null,
  );

  if (slotsToRender.length === 0) return null;

  return (
    <Box>
      {slotsToRender.map(({ slotName, Comp }) => (
        <PluginErrorBoundary key={slotName} slotName={slotName}>
          <Suspense fallback={<PluginLoadingFallback slotName={slotName} />}>
            <Comp {...slotProps} />
          </Suspense>
        </PluginErrorBoundary>
      ))}
    </Box>
  );
}

function PluginLoadingFallback({ slotName }: { slotName: string }) {
  return (
    <Box variant="small" color="text-status-inactive">
      Loading plugin: {slotName}…
    </Box>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  message?: string;
}

class PluginErrorBoundary extends Component<
  { slotName: string; children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // portal 全体への impact を避けるため warn log のみ。 plugin slot 単位の失敗は
    // 該当 slot を fallback Alert に降格させて他 slot / 他 section を生かす。
    console.warn(`[portal-plugin] slot=${this.props.slotName} crashed`, {
      message: err.message,
      stack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <Alert type="warning" header={`Plugin "${this.props.slotName}" の表示に失敗しました`}>
          {this.state.message ?? "不明なエラー"}
        </Alert>
      );
    }
    return this.props.children;
  }
}
