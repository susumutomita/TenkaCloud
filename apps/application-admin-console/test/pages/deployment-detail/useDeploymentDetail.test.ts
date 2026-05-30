import { act, renderHook, waitFor } from "@testing-library/react";
import { StatusCodes } from "http-status-codes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client";
import type { AppConfig } from "../../../src/config";
import {
  POLL_INTERVAL_MS,
  useDeploymentDetail,
} from "../../../src/pages/deployment-detail/useDeploymentDetail";

/**
 * DeploymentDetail polling hook。 useApiClient + getDeployment / getStackProgress を mock し、
 * guard / 基本情報 fetch の success・error / terminal 停止 / reload spinner / #687 の stack-progress
 * 「準備中」判定 (409 / 5xx / TypeError / failed-to-fetch) と raw error path / interval 停止を pin する。
 * JOB_ID_RE / TERMINAL_STATUSES / ApiError は実物を残す (partial mock)。
 */
const { mockUseApiClient, mockGetDeployment, mockGetStackProgress } = vi.hoisted(() => ({
  mockUseApiClient: vi.fn(),
  mockGetDeployment: vi.fn(),
  mockGetStackProgress: vi.fn(),
}));

vi.mock("../../../src/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/client")>();
  return { ...actual, useApiClient: mockUseApiClient };
});
vi.mock("../../../src/api/deploy-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/api/deploy-client")>();
  return { ...actual, getDeployment: mockGetDeployment, getStackProgress: mockGetStackProgress };
});

const config = {} as AppConfig;
const CLIENT = { get: vi.fn(), post: vi.fn(), del: vi.fn() };
const JOB = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const PROGRESS = { jobId: JOB, events: [], resources: [] };
const dep = (status: string) => ({ jobId: JOB, status });

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useDeploymentDetail", () => {
  it("should no-op when no client or the jobId is missing / malformed", async () => {
    mockUseApiClient.mockReturnValue(null);
    const a = renderHook(() => useDeploymentDetail(config, JOB));
    await act(async () => {});
    expect(a.result.current.item).toBeNull();

    mockUseApiClient.mockReturnValue(CLIENT);
    const b = renderHook(() => useDeploymentDetail(config, "not-a-job-id"));
    await act(async () => {});
    expect(b.result.current.item).toBeNull();
    expect(mockGetDeployment).not.toHaveBeenCalled();
  });

  it("should load the deployment summary and stack progress on mount", async () => {
    mockUseApiClient.mockReturnValue(CLIENT);
    mockGetDeployment.mockResolvedValue(dep("IN_PROGRESS"));
    mockGetStackProgress.mockResolvedValue(PROGRESS);

    const { result } = renderHook(() => useDeploymentDetail(config, JOB));
    await waitFor(() => expect(result.current.item).not.toBeNull());
    expect(result.current.item).toEqual(dep("IN_PROGRESS"));
    expect(result.current.stackProgress).toEqual(PROGRESS);
    expect(result.current.error).toBeNull();
  });

  it("should record error.message (Error) and String() on a summary fetch failure", async () => {
    mockUseApiClient.mockReturnValue(CLIENT);
    mockGetStackProgress.mockResolvedValue(PROGRESS);
    mockGetDeployment.mockRejectedValueOnce(new Error("dep failed"));

    const { result } = renderHook(() => useDeploymentDetail(config, JOB));
    await waitFor(() => expect(result.current.error).toBe("dep failed"));

    mockGetDeployment.mockRejectedValueOnce("plain");
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.error).toBe("plain"));
  });

  it("should toggle manualRefreshing around reload()", async () => {
    mockUseApiClient.mockReturnValue(CLIENT);
    mockGetDeployment.mockResolvedValue(dep("IN_PROGRESS"));
    mockGetStackProgress.mockResolvedValue(PROGRESS);

    const { result } = renderHook(() => useDeploymentDetail(config, JOB));
    await waitFor(() => expect(result.current.item).not.toBeNull());

    await act(async () => {
      result.current.reload();
    });
    expect(result.current.manualRefreshing).toBe(false);
    // mount tick + reload = getDeployment 2 回以上。
    expect(mockGetDeployment.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("should classify 409 / 5xx / TypeError / failed-to-fetch stack-progress errors as notYetCreated", async () => {
    mockUseApiClient.mockReturnValue(CLIENT);
    mockGetDeployment.mockResolvedValue(dep("IN_PROGRESS"));

    const cases: { err: unknown; notYetCreated: boolean }[] = [
      { err: new ApiError(StatusCodes.CONFLICT, "stack_not_yet_created"), notYetCreated: true },
      { err: new ApiError(StatusCodes.BAD_GATEWAY, "bad gw"), notYetCreated: true },
      { err: new ApiError(StatusCodes.SERVICE_UNAVAILABLE, "down"), notYetCreated: true },
      { err: new ApiError(StatusCodes.GATEWAY_TIMEOUT, "timeout"), notYetCreated: true },
      { err: new TypeError("NetworkError"), notYetCreated: true },
      { err: new Error("Failed to fetch"), notYetCreated: true },
      { err: new ApiError(StatusCodes.FORBIDDEN, "forbidden"), notYetCreated: false },
      { err: "raw-string", notYetCreated: false },
    ];

    for (const c of cases) {
      mockGetStackProgress.mockRejectedValueOnce(c.err);
      const { result, unmount } = renderHook(() => useDeploymentDetail(config, JOB));
      await waitFor(() => expect(result.current.stackProgressError).not.toBeNull());
      expect(result.current.stackProgressError?.notYetCreated).toBe(c.notYetCreated);
      unmount();
    }
  });

  it("should stop polling once a terminal status is reached", async () => {
    vi.useFakeTimers();
    mockUseApiClient.mockReturnValue(CLIENT);
    mockGetDeployment.mockResolvedValue(dep("COMPLETE"));
    mockGetStackProgress.mockResolvedValue(PROGRESS);

    renderHook(() => useDeploymentDetail(config, JOB));
    // mount tick を流す。
    await vi.advanceTimersByTimeAsync(0);
    const afterMount = mockGetDeployment.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // polling 間隔経過 → interval tick が走るが stopPollingRef=true なので再 fetch しない。
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mockGetDeployment.mock.calls.length).toBe(afterMount);
  });
});
