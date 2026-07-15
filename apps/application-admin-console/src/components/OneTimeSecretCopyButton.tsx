import Button from "@cloudscape-design/components/button";
import { useState } from "react";

type CopyState = "idle" | "pending" | "copied" | "failed";

export interface OneTimeSecretCopyButtonProps {
  readonly textToCopy: string;
  readonly copyLabel: string;
  readonly copyingLabel: string;
  readonly copiedLabel: string;
  readonly failedLabel: string;
  readonly disabled?: boolean;
  readonly onPendingChange?: (pending: boolean) => void;
}

const copyStateLabel = (
  state: CopyState,
  labels: Pick<
    OneTimeSecretCopyButtonProps,
    "copyLabel" | "copyingLabel" | "copiedLabel" | "failedLabel"
  >,
): string => {
  if (state === "pending") return labels.copyingLabel;
  if (state === "copied") return labels.copiedLabel;
  if (state === "failed") return labels.failedLabel;
  return labels.copyLabel;
};

/** Copies a one-time secret and keeps its owner informed until feedback is visible. */
export function OneTimeSecretCopyButton({
  textToCopy,
  copyLabel,
  copyingLabel,
  copiedLabel,
  failedLabel,
  disabled = false,
  onPendingChange,
}: OneTimeSecretCopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");

  const copy = async (): Promise<void> => {
    setState("pending");
    onPendingChange?.(true);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(textToCopy);
      setState("copied");
    } catch {
      setState("failed");
    } finally {
      onPendingChange?.(false);
    }
  };

  return (
    <Button iconName="copy" disabled={disabled || state === "pending"} onClick={() => void copy()}>
      {copyStateLabel(state, { copyLabel, copyingLabel, copiedLabel, failedLabel })}
    </Button>
  );
}
