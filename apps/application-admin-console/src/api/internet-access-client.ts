import type { ApiClient } from "./client";

export interface InternetAccessProblem {
  readonly problemId: string;
  readonly name: string;
  readonly requests: readonly {
    id: string;
    service: string;
    address: string;
    port: number;
    purpose: string;
  }[];
  readonly grant: { requestIds: readonly string[]; grantedAt: string } | null;
}
export interface InternetAccessView {
  readonly available: boolean;
  readonly reason?: string;
  readonly problems: readonly InternetAccessProblem[];
}
export function fetchInternetAccess(api: ApiClient, eventId: string): Promise<InternetAccessView> {
  return api.get(`events/${eventId}/internet-access`);
}
export function approveInternetAccess(
  api: ApiClient,
  eventId: string,
  problemId: string,
  requestIds: readonly string[],
): Promise<unknown> {
  return api.put(`events/${eventId}/internet-access/${problemId}`, { requestIds });
}
export function revokeInternetAccess(
  api: ApiClient,
  eventId: string,
  problemId: string,
): Promise<unknown> {
  return api.del(`events/${eventId}/internet-access/${problemId}`);
}
