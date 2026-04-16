/**
 * AdminPageFooter Component
 *
 * HybridNext Design System - Terminal Command Center style
 * Admin ページのターミナル風フッター
 */

export interface AdminPageFooterProps {
  /** コマンド名（例: 'events', 'teams'） */
  command: string;
  /** 表示件数 */
  count: number;
}

export function AdminPageFooter({ command, count }: AdminPageFooterProps) {
  return (
    <div className="text-center text-text-muted text-xs font-mono py-4">
      <span className="text-hn-accent">$</span> {command} --list --count=
      {count}
    </div>
  );
}
