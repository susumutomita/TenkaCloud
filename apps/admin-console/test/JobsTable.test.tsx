import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobsTable } from "../src/components/JobsTable";

/**
 * #refactor: Jobs.tsx から切り出した共有 execution テーブルの単体テスト。
 * Provisioning タブ (variant/trackBy 指定) と Deprovisioning タブ (loading 指定) の双方の
 * 使い方を component 単体で再現し、 行描画 / 空表示 / loading 表示を検証する。
 */
interface Row {
  readonly id: string;
  readonly label: string;
}

const columns = [{ id: "label", header: "Label", cell: (r: Row) => r.label }];

describe("JobsTable", () => {
  it("should render rows with the supplied columns (embedded variant + trackBy)", () => {
    render(
      <JobsTable<Row>
        variant="embedded"
        trackBy="id"
        items={[{ id: "a", label: "alpha" }]}
        columnDefinitions={columns}
        empty={<span>empty</span>}
      />,
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("should render the empty slot when there are no rows", () => {
    render(
      <JobsTable<Row> items={[]} columnDefinitions={columns} empty={<span>nothing here</span>} />,
    );
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });

  it("should surface the loading text while loading", () => {
    render(
      <JobsTable<Row>
        items={[]}
        loading
        loadingText="loading rows"
        columnDefinitions={columns}
        empty={<span>empty</span>}
      />,
    );
    expect(screen.getByText("loading rows")).toBeInTheDocument();
  });
});
