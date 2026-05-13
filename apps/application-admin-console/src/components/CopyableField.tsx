import Button from "@cloudscape-design/components/button";
import { useState } from "react";

/**
 * Issue #662: 1 line の value (= AccountId / ExternalId / RoleName 等) を
 * 表示 + 1-click copy するための再利用 component。
 * - Cloudscape の inline-icon button (📋) を value の右に置く
 * - copy 後 2 秒 chip icon を ✓ に変えて feedback (= 競技者にコピー成功を視認)
 */
interface CopyableFieldProps {
  readonly value: string;
  readonly ariaLabel: string;
  /** value 表示用の class (= long string は wordBreak: break-all 推奨) */
  readonly valueClassName?: string;
}

export function CopyableField({ value, ariaLabel, valueClassName }: CopyableFieldProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <code className={valueClassName} style={{ wordBreak: "break-all", flex: 1 }}>
        {value}
      </code>
      <Button
        variant="inline-icon"
        iconName={copied ? "status-positive" : "copy"}
        ariaLabel={ariaLabel}
        onClick={() => void onCopy()}
      />
    </div>
  );
}
