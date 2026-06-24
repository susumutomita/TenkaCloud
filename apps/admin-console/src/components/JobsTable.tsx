import Table, { type TableProps } from "@cloudscape-design/components/table";
import type { ReactNode } from "react";

/**
 * Issue #658 / #814: Jobs page の Provisioning / Deprovisioning タブが共有する execution テーブル。
 *
 * `Jobs.tsx` から SRP 分離 (#refactor)。 Cloudscape `<Table>` の items / columns / empty /
 * loading 周りの配線を 1 箇所に集約する thin wrapper。 列定義・空表示・loading 表示はタブごとに
 * 異なるので props で受け取り、 描画分岐をタブ側に漏らさない。 item 型はジェネリック。
 */
export interface JobsTableProps<T> {
  readonly items: readonly T[];
  readonly columnDefinitions: TableProps.ColumnDefinition<T>[];
  readonly empty: ReactNode;
  readonly variant?: TableProps.Variant;
  readonly trackBy?: TableProps["trackBy"];
  readonly loading?: boolean;
  readonly loadingText?: string;
}

export function JobsTable<T>({
  items,
  columnDefinitions,
  empty,
  variant,
  trackBy,
  loading,
  loadingText,
}: JobsTableProps<T>) {
  return (
    <Table<T>
      variant={variant}
      items={[...items]}
      trackBy={trackBy}
      loading={loading}
      loadingText={loadingText}
      columnDefinitions={columnDefinitions}
      empty={empty}
    />
  );
}
