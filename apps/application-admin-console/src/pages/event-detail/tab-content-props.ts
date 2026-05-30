import type { ApiClient } from "../../api/client";
import type { EventDetail } from "../../api/events-client";
import type { AppConfig } from "../../config";
import type { useEventOperations } from "../../hooks/useEventOperations";
import type { useT } from "../../i18n";
import type { WizardState } from "../../lib/event-wizard";

/**
 * Shared prop contract for every Event Detail workflow tab (Issue #1318).
 * Extracted from `tabs.tsx` so each tab module depends only on this contract and
 * the panels it renders, rather than on the union of all tabs' dependencies.
 */
export type Translate = ReturnType<typeof useT>;
export type EventOperations = ReturnType<typeof useEventOperations>;

export interface EventTabContentProps {
  readonly apiClient: ApiClient | null;
  readonly config: AppConfig;
  readonly counts: {
    readonly allDoneCount: number;
    readonly completeCount: number;
    readonly failedCount: number;
    readonly inFlightCount: number;
    readonly totalDeployCount: number;
  };
  readonly detail: EventDetail;
  readonly manualRefresh: () => void;
  readonly manualRefreshInFlight: boolean;
  readonly operations: EventOperations;
  readonly t: Translate;
  readonly wizard: WizardState;
}
