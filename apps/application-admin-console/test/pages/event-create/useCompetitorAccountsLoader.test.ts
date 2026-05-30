import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config";

/**
 * Phase 2.2 (#459) / #671: useCompetitorAccountsLoader。 mount fetch (成功/失敗) /
 * apiClient 不在の no-op / window focus 時の再取得 / unmount での listener 解除 を pin する。
 * useApiClient / listCompetitorAccounts を mock、 formatCompetitorAccountsLoadError は実物。
 */
const { mockApiClient, mockList } = vi.hoisted(() => ({
  mockApiClient: vi.fn(),
  mockList: vi.fn(),
}));
vi.mock("../../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/client")>();
  return { ...actual, useApiClient: mockApiClient };
});
vi.mock("../../../src/api/competitor-accounts-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/api/competitor-accounts-client")>();
  return { ...actual, listCompetitorAccounts: mockList };
});

const { useCompetitorAccountsLoader } = await import(
  "../../../src/pages/event-create/useCompetitorAccountsLoader"
);
const config = {} as AppConfig;

beforeEach(() => {
  mockApiClient.mockReturnValue({ get: vi.fn() });
  mockList.mockReset().mockResolvedValue({ items: [{ awsAccountId: "1" }] });
});
afterEach(() => vi.clearAllMocks());

describe("useCompetitorAccountsLoader", () => {
  it("should fetch accounts on mount", async () => {
    const { result } = renderHook(() => useCompetitorAccountsLoader(config));
    await waitFor(() => expect(result.current.competitorAccounts).toEqual([{ awsAccountId: "1" }]));
    expect(result.current.accountsLoadError).toBeNull();
  });

  it("should surface a load error", async () => {
    mockList.mockRejectedValue(new Error("load boom"));
    const { result } = renderHook(() => useCompetitorAccountsLoader(config));
    await waitFor(() => expect(result.current.accountsLoadError).not.toBeNull());
  });

  it("should not fetch when the API client is unavailable", async () => {
    mockApiClient.mockReturnValue(null);
    const { result } = renderHook(() => useCompetitorAccountsLoader(config));
    await Promise.resolve();
    expect(mockList).not.toHaveBeenCalled();
    expect(result.current.competitorAccounts).toBeNull();
  });

  it("should re-fetch on window focus", async () => {
    renderHook(() => useCompetitorAccountsLoader(config));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it("should remove the focus listener on unmount without re-fetching", async () => {
    const { unmount } = renderHook(() => useCompetitorAccountsLoader(config));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    unmount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mockList).toHaveBeenCalledTimes(1); // unmount 後は再取得しない
  });
});
