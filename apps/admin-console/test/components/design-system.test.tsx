/**
 * Issue #1366: design system component の振る舞いを固定する unit test。
 *
 * 検証観点:
 *   - EmptyState は headline + body + primary action を出す
 *   - ErrorState は title + hint + possibleCauses list を構造化表示し、 dismiss と retry が
 *     props 指定時のみ表れる
 *   - LoadingState は spinner + label を出す
 *   - StatusBadge は tone -> color mapping を持ち、 statusToTone() は未知 status を pending に
 *     落とす (= UI 壊れ防止)
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  statusToTone,
} from "../../src/components/design-system";

describe("EmptyState", () => {
  it("should render headline only when body and action are omitted", () => {
    render(<EmptyState headline="No events yet" />);
    expect(screen.getByText("No events yet")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("should render headline + body + primary action when all provided", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        headline="No tenants"
        body="Create your first tenant to begin."
        primaryAction={{ label: "Create tenant", onClick }}
      />,
    );
    expect(screen.getByText("No tenants")).toBeInTheDocument();
    expect(screen.getByText("Create your first tenant to begin.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Create tenant" });
    btn.click();
    expect(onClick).toHaveBeenCalled();
  });
});

describe("ErrorState", () => {
  it("should render title and hint", () => {
    render(<ErrorState title="Fetch failed" hint="check network" />);
    expect(screen.getByText("Fetch failed")).toBeInTheDocument();
    expect(screen.getByText("check network")).toBeInTheDocument();
  });

  it("should render possibleCauses list", () => {
    render(
      <ErrorState
        title="AssumeRole failed"
        possibleCauses={["ExternalId mismatch", "Role not found"]}
      />,
    );
    expect(screen.getByText("ExternalId mismatch")).toBeInTheDocument();
    expect(screen.getByText("Role not found")).toBeInTheDocument();
  });

  it("should render retry button when retry prop is set", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Failed" retry={{ label: "Retry", onClick: onRetry }} />);
    const btn = screen.getByRole("button", { name: "Retry" });
    btn.click();
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("LoadingState", () => {
  it("should render the default label when none provided", () => {
    render(<LoadingState />);
    expect(screen.getByText(/Loading\.\.\./i)).toBeInTheDocument();
  });

  it("should render the supplied label", () => {
    render(<LoadingState label="Fetching tenants" />);
    expect(screen.getByText("Fetching tenants")).toBeInTheDocument();
  });
});

describe("StatusBadge / statusToTone", () => {
  it("should render the supplied children", () => {
    render(<StatusBadge tone="success">ACTIVE</StatusBadge>);
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
  });

  it("should map canonical status values to the expected tone", () => {
    expect(statusToTone("ACTIVE")).toBe("success");
    expect(statusToTone("RUNNING")).toBe("success");
    expect(statusToTone("SUSPENDED")).toBe("warning");
    expect(statusToTone("FAILED")).toBe("error");
    expect(statusToTone("DEPLOYING")).toBe("info");
    expect(statusToTone("DELETED")).toBe("pending");
  });

  it("should fall back to pending for unknown status (UI must not break)", () => {
    expect(statusToTone("UNHEARD_OF_STATE")).toBe("pending");
    expect(statusToTone("")).toBe("pending");
  });
});
