/**
 * metadata.dashboard.slots で宣言した problem plugin を render する wrapper。
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
import {
  PORTAL_SLOT_NAMES,
  type PortalCoordinationClient,
  type PortalLocale,
  type PortalSlotProps,
} from "@tenkacloud/portal-plugin-sdk";
import { PendingOperation, toErrorMessage } from "@tenkacloud/web-kit";
import { Component, type ErrorInfo, type ReactNode, Suspense, useMemo } from "react";
import {
  type CoordinationOutcome,
  getCoordinationProjection,
  submitCoordinationOp,
} from "../api/coordination-client";
import type { ParticipantEndpointView } from "../api/portal-client";
import { useTeamView } from "../auth/TeamViewProvider";
import { loadPluginSlot } from "./loader";
import { PluginUpdateNotice, ReloadPortal } from "./PluginUpdateNotice";
import {
  buildPortalCoordination,
  buildPortalDisruptions,
  buildPortalEndpointsFromOutputs,
  buildPortalEndpointsFromRegistry,
  buildPortalPhases,
  buildPortalTeam,
} from "./props-builder";

interface PortalPluginSlotsProps {
  readonly problemId: string;
  readonly jobId: string;
  /** Cloud resets rotate a shared pointer without replacing this deployment's jobId. */
  readonly coordinationRunId?: string;
  readonly score: number;
  readonly locale: PortalLocale;
  readonly posture?: Record<string, boolean>;
  readonly platform?: string;
  readonly team: {
    readonly teamName: string;
    readonly teamId?: string;
    readonly eventId?: string;
  };
  readonly stackOutputs: Record<string, string>;
  /** Server-computed registry; undefined means loading/error and uses the CFn-output fallback. */
  readonly endpoints?: readonly ParticipantEndpointView[];
  /** [#1420] coordination dispatcher の Function URL (= config.coordinationApiUrl)。 未配線なら省略。 */
  readonly coordinationApiUrl?: string;
  /** [#1420] team の session token (= bearer)。 coordinationClient の束縛に使う。 */
  readonly sessionToken?: string;
  /** Event の採点終了時刻 (ISO 8601)。 `PortalSlotProps.eventEndsAt` へ渡す。 */
  readonly eventEndsAt?: string;
}

interface CoordinationOperationScope {
  readonly id: string;
  readonly runId: string;
  readonly nowIso: string;
  readonly pending: Map<string, PendingOperation>;
  projection?: ReturnType<typeof getCoordinationProjection>;
}

async function submitPluginOperation(
  scope: CoordinationOperationScope,
  coordinationApiUrl: string,
  sessionToken: string,
  op: unknown,
): Promise<CoordinationOutcome> {
  const body = JSON.stringify(op);
  if (body === undefined) return { kind: "rejected", error: "invalid_op" };
  let intent = scope.pending.get(body);
  if (!intent) {
    // Never evict an uncertain mutation and accidentally retry it with a new key.
    if (scope.pending.size >= 32) return { kind: "unavailable" };
    intent = new PendingOperation();
    scope.pending.set(body, intent);
  }
  const key = intent.keyFor(scope.id, op);
  const result = await submitCoordinationOp(
    coordinationApiUrl,
    sessionToken,
    op,
    undefined,
    key,
    scope.runId,
  );
  if (result.kind === "ok" || result.kind === "rejected") {
    intent.acknowledge(key);
    if (scope.pending.get(body) === intent) scope.pending.delete(body);
  }
  return result;
}

/** Concurrent slots share the in-flight read only; the next completed poll always reads anew. */
function readPluginProjection(scope: CoordinationOperationScope, url: string, token: string) {
  if (!scope.projection) {
    const request = getCoordinationProjection(url, token).finally(() => {
      if (scope.projection === request) scope.projection = undefined;
    });
    scope.projection = request;
  }
  return scope.projection;
}

export function PortalPluginSlots({
  problemId,
  jobId,
  coordinationRunId,
  score,
  locale,
  posture,
  platform,
  team,
  stackOutputs,
  endpoints: registeredEndpoints,
  coordinationApiUrl,
  sessionToken,
  eventEndsAt,
}: PortalPluginSlotsProps) {
  const { refreshAfterMutation } = useTeamView();
  // problemId が変わらない限り phases / disruptions / slot 検索結果は不変 (= build-time catalog
  // から narrowed)。 endpoints は stackOutputs 依存なので別 memo に切る。
  const phases = useMemo(() => buildPortalPhases(problemId), [problemId]);
  const disruptions = useMemo(() => buildPortalDisruptions(problemId), [problemId]);
  const coordination = useMemo(() => buildPortalCoordination(problemId), [problemId]);
  const endpoints = useMemo(
    () =>
      registeredEndpoints === undefined
        ? buildPortalEndpointsFromOutputs(problemId, stackOutputs)
        : buildPortalEndpointsFromRegistry(registeredEndpoints),
    [problemId, stackOutputs, registeredEndpoints],
  );
  const teamProp = useMemo(() => buildPortalTeam(team), [team]);
  const runId = coordinationRunId ?? jobId;
  // Keep each unacknowledged payload's key across retries and polling rerenders.
  // A different run or session gets a separate bounded intent set.
  const operationScope = useMemo<CoordinationOperationScope>(
    () => ({
      id: JSON.stringify([coordinationApiUrl, sessionToken, jobId, runId]),
      runId,
      nowIso: new Date().toISOString(),
      pending: new Map(),
    }),
    [coordinationApiUrl, sessionToken, jobId, runId],
  );
  // [#1420] dispatcher URL + session が揃ったときだけ live coordination client を束縛する
  // (= plugin は URL/token を知らず op 投入 + projection 取得できる)。 どちらか無ければ undefined。
  const coordinationClient = useMemo<PortalCoordinationClient | undefined>(() => {
    if (!coordinationApiUrl || !sessionToken) return undefined;
    return {
      submitOp: async (op: unknown) => {
        const result = await submitPluginOperation(
          operationScope,
          coordinationApiUrl,
          sessionToken,
          op,
        );
        // A rejected move can still incur a penalty; always refresh the official totals.
        void refreshAfterMutation();
        return result;
      },
      getProjection: () => readPluginProjection(operationScope, coordinationApiUrl, sessionToken),
    };
  }, [coordinationApiUrl, sessionToken, operationScope, refreshAfterMutation]);
  // Pin the clock across ordinary polling, but start a fresh slot lifetime after a reset.
  const nowIso = operationScope.nowIso;

  const slotProps: PortalSlotProps = useMemo(
    () => ({
      team: teamProp,
      problemId,
      jobId,
      score,
      locale,
      ...(posture ? { posture } : {}),
      ...(platform ? { platform } : {}),
      endpoints,
      phases,
      disruptions,
      ...(coordination ? { coordination } : {}),
      ...(coordinationClient ? { coordinationClient } : {}),
      ...(eventEndsAt ? { eventEndsAt } : {}),
      nowIso,
    }),
    [
      teamProp,
      problemId,
      jobId,
      score,
      locale,
      posture,
      platform,
      endpoints,
      phases,
      disruptions,
      coordination,
      coordinationClient,
      eventEndsAt,
      nowIso,
    ],
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
      <PluginUpdateNotice locale={locale} problemId={problemId} />
      {slotsToRender.map(({ slotName, Comp }) => (
        <PluginErrorBoundary
          key={`${problemId}:${jobId}:${runId}:${slotName}`}
          slotName={slotName}
          locale={locale}
        >
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
  { slotName: string; children: ReactNode; locale: PortalLocale },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: toErrorMessage(err),
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
          <ReloadPortal locale={this.props.locale} />
        </Alert>
      );
    }
    return this.props.children;
  }
}
