import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";

/**
 * Issue #1366: 共有 empty state。 DESIGN-SYSTEM.html "8. Empty state pattern" の正本実装。
 *
 * 配置: icon (decorative, 任意) → headline → body → primary action。
 *
 * - 「空 box に 'no data'」 を全 SPA から駆逐するための共通実装。 buyer 視点で「閉店」 と
 *   見えないように、 次の action を必ず提示する設計。
 * - i18n は呼び出し側責任 (props で渡す)。 component 自体は presentation 専用。
 * - 3 SPA で copy-paste で同型維持 (lib/format.ts と同じ理由)。
 */
export interface EmptyStateAction {
  readonly label: string;
  readonly onClick?: () => void;
  readonly href?: string;
}

export interface EmptyStateProps {
  readonly headline: string;
  readonly body?: string;
  readonly primaryAction?: EmptyStateAction;
}

export function EmptyState({ headline, body, primaryAction }: EmptyStateProps) {
  return (
    <Box textAlign="center" padding={{ vertical: "xxl", horizontal: "l" }} color="inherit">
      <SpaceBetween size="s">
        <Box variant="h3" color="inherit">
          {headline}
        </Box>
        {body && (
          <Box variant="p" color="text-status-inactive">
            {body}
          </Box>
        )}
        {primaryAction && (
          <Box padding={{ top: "xs" }}>
            <Button
              variant="primary"
              onClick={primaryAction.onClick}
              href={primaryAction.href}
              target={primaryAction.href ? "_self" : undefined}
            >
              {primaryAction.label}
            </Button>
          </Box>
        )}
      </SpaceBetween>
    </Box>
  );
}
