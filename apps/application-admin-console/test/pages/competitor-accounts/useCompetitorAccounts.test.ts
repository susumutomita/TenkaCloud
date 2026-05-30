import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config";
import { useCompetitorAccounts } from "../../../src/pages/competitor-accounts/useCompetitorAccounts";

/**
 * Issue: Competitor Accounts 管理 hook。 useApiClient + list/verify/delete client を mock し、
 * mount-time reload / verify / remove の success・error・null-client 経路と inFlight 遷移を
 * renderHook で pin する。 friendly-error は実物 (pure) を使う。
 */
const { mockUseApiClient, mockList, mockVerify, mockDelete } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockList: vi.fn(),
  mockVerify: vi.fn(),
  mockDelete: vi.fn(),
}));

// useApiClient だけ差し替え、 ApiError 等 (friendly-error が instanceof で使う) は実物を残す。
vi.mock("../../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../../src/api/competitor-accounts-client", () => ({
  listCompetitorAccounts: mockList,
  verifyCompetitorAccount: mockVerify,
  deleteCompetitorAccount: mockDelete,
}));

const config = {} as AppConfig;
const FAKE_CLIENT = { get: vi.fn(), post: vi.fn(), del: vi.fn() };
const ITEMS = [{ awsAccountId: "111122223333", status: "verified" }];

afterEach(() => vi.clearAllMocks());

describe("useCompetitorAccounts", () => {
  it("should load the account list on mount when a client is available", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockResolvedValue({ items: ITEMS });

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.items).not.toBeNull());
    expect(result.current.items).toEqual(ITEMS);
    expect(result.current.error).toBeNull();
  });

  it("should surface a friendly error when the initial load fails", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.title).toBe("boom");
    expect(result.current.items).toBeNull();
  });

  it("should not call any client function when no API client is available", async () => {
    mockUseApiClient.mockReturnValue(null);

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await act(async () => {
      await result.current.reload();
      await result.current.verify("111122223333");
      await result.current.remove("111122223333");
    });
    expect(result.current.items).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("should verify an account and reload, clearing verifyInFlight afterward", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockResolvedValue({ items: ITEMS });
    mockVerify.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.items).not.toBeNull());

    await act(async () => {
      await result.current.verify("111122223333");
    });
    expect(mockVerify).toHaveBeenCalledWith(FAKE_CLIENT, "111122223333");
    // reload (mount) + reload (after verify) = 2 回。
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result.current.verifyInFlight).toBeNull();
  });

  it("should record a friendly error and clear verifyInFlight when verify fails", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockResolvedValue({ items: ITEMS });
    mockVerify.mockRejectedValue(new Error("verify failed"));

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.items).not.toBeNull());

    await act(async () => {
      await result.current.verify("111122223333");
    });
    expect(result.current.error?.title).toBe("verify failed");
    expect(result.current.verifyInFlight).toBeNull();
  });

  it("should delete an account and reload, clearing deleteInFlight afterward", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockResolvedValue({ items: ITEMS });
    mockDelete.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.items).not.toBeNull());

    await act(async () => {
      await result.current.remove("111122223333");
    });
    expect(mockDelete).toHaveBeenCalledWith(FAKE_CLIENT, "111122223333");
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result.current.deleteInFlight).toBe(false);
  });

  it("should record a friendly error and clear deleteInFlight when delete fails", async () => {
    mockUseApiClient.mockReturnValue(FAKE_CLIENT);
    mockList.mockResolvedValue({ items: ITEMS });
    mockDelete.mockRejectedValue(new Error("delete failed"));

    const { result } = renderHook(() => useCompetitorAccounts(config));
    await waitFor(() => expect(result.current.items).not.toBeNull());

    await act(async () => {
      await result.current.remove("111122223333");
    });
    expect(result.current.error?.title).toBe("delete failed");
    expect(result.current.deleteInFlight).toBe(false);
  });
});
