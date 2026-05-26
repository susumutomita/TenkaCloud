import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";

/**
 * Issue #1366: 共有 error state。 DESIGN-SYSTEM.html "9. Error state pattern" の正本実装。
 *
 * - backend error は呼び出し側で `toFriendlyError(err)` (= application-admin-console の lib)
 *   を通してから本 component に渡す。 raw JSON / stack trace は user に見せない。
 * - retry がある操作は `retry` props を渡す (= 「やり直す」ボタンが出る)。
 * - alert を閉じるオペレーション (= dismiss) を許可するときは `onDismiss` を渡す。
 *
 * 3 SPA copy-paste 維持 (lib/format.ts と同じ方針)。
 */
export interface ErrorStateProps {
  readonly title: string;
  readonly hint?: string;
  readonly possibleCauses?: readonly string[];
  readonly retry?: { readonly label: string; readonly onClick: () => void };
  readonly onDismiss?: () => void;
}

export function ErrorState({ title, hint, possibleCauses, retry, onDismiss }: ErrorStateProps) {
  return (
    <Alert
      type="error"
      header={title}
      dismissible={onDismiss !== undefined}
      onDismiss={onDismiss}
      action={
        retry ? (
          <Button onClick={retry.onClick} variant="normal">
            {retry.label}
          </Button>
        ) : undefined
      }
    >
      <SpaceBetween size="xs">
        {hint && <Box variant="p">{hint}</Box>}
        {possibleCauses && possibleCauses.length > 0 && (
          <Box variant="div" padding={{ top: "xs" }}>
            <Box variant="strong">考えられる原因:</Box>
            <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 22 }}>
              {possibleCauses.map((cause) => (
                // 静的 cause text。 page 内で重複は無いので key=text で安全。
                <li key={cause}>{cause}</li>
              ))}
            </ul>
          </Box>
        )}
      </SpaceBetween>
    </Alert>
  );
}
