/**
 * ADR-012 Phase 5: problem 側 plugin (= metadata.dashboard.slots) を render する wrapper。
 *
 * 設計判断:
 *   - chunk 分割は loader.ts 内 Vite glob で自動。 portal SPA 起動時に plugin chunk は
 *     fetch しない (Suspense が解決時に fetch 開始)。
 *   - ErrorBoundary は class component (= React の boundary mechanism)。 plugin runtime
 *     crash で portal 全体が落ちるのを防ぎ、 該当 slot だけ fallback Alert に降格。
 *   - PORTAL_SLOT_NAMES の literal 順で render する (= UI 上の表示順を予測可能にする)。
 *   - slotsToRender / slotProps は useMemo で stabilize (= 5s polling 由来の re-render で
 *     plugin が無駄に再 mount されないよう、 stackOutputs / team / score が unchanged なら
 *     identity を保つ)。
 */

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import { PORTAL_SLOT_NAMES, type PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";
import { Component, type ErrorInfo, type ReactNode, Suspense, useMemo } from "react";
import { loadPluginSlot } from "./loader";
import {
  buildPortalDisruptions,
  buildPortalEndpointsFromOutputs,
  buildPortalPhases,
  buildPortalTeam,
} from "./props-builder";

interface PortalPluginSlotsProps {
  readonly problemId: string;
  readonly jobId: string;
  readonly score: number;
  readonly team: {
    readonly teamName: string;
    readonly teamId?: string;
    readonly eventId?: string;
  };
  readonly stackOutputs: Record<string, string>;
}

export function PortalPluginSlots({
  problemId,
  jobId,
  score,
  team,
  stackOutputs,
}: PortalPluginSlotsProps) {
  // problemId が変わらない限り phases / disruptions / slot 検索結果は不変 (= build-time catalog
  // から narrowed)。 endpoints は stackOutputs 依存なので別 memo に切る。
  const phases = useMemo(() => buildPortalPhases(problemId), [problemId]);
  const disruptions = useMemo(() => buildPortalDisruptions(problemId), [problemId]);
  const endpoints = useMemo(
    () => buildPortalEndpointsFromOutputs(problemId, stackOutputs),
    [problemId, stackOutputs],
  );
  const teamProp = useMemo(() => buildPortalTeam(team), [team]);
  // mount 時刻を pin (= 5s polling 由来の re-render で plugin が clock change を見ない方が
  // surprise が少ない、 「nowIso が動く」 ことに依存した plugin は plugin 内で自前
  // setInterval を持つべき)。 [] で intentional mount-pin。 problemId / jobId が変われば
  // 親で別 instance として再 mount され nowIso は自然に更新される。
  const nowIso = useMemo(() => new Date().toISOString(), []);

  const slotProps: PortalSlotProps = useMemo(
    () => ({
      team: teamProp,
      problemId,
      jobId,
      score,
      endpoints,
      phases,
      disruptions,
      nowIso,
    }),
    [teamProp, problemId, jobId, score, endpoints, phases, disruptions, nowIso],
  );

  const slotsToRender = useMemo(
    () =>
      PORTAL_SLOT_NAMES.flatMap((slotName) => {
        const Comp = loadPluginSlot(problemId, slotName);
        return Comp ? [{ slotName, Comp }] : [];
      }),
    [problemId],
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
    // Issue #1251: 旧 implementation は console.warn で silent に流していたため、 production で
    // operator が plugin crash を発見できなかった。 user-visible Alert は ErrorBoundary の
    // render path で出すので「画面が真っ白」にはならない (= decorative ではなく degraded UX) が、
    // backend 観測のため console.error に昇格させ、 RUM / Sentry error pipeline で pick up する。
    console.error(`[portal-plugin] slot=${this.props.slotName} crashed`, {
      message: err.message,
      stack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      // getDerivedStateFromError は常に message を string で設定するため、 ?? fallback は到達不能。
      /* v8 ignore next */
      const message = this.state.message ?? "Unknown error";
      return (
        <Alert type="warning" header={`Plugin "${this.props.slotName}" failed to render`}>
          {message}
        </Alert>
      );
    }
    return this.props.children;
  }
}
