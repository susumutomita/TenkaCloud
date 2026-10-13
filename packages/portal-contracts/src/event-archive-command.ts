/** Shared archive command; each adapter retains its own atomic mutation and HTTP result. */
export interface EventArchiveCommandPort<Request, Response> {
  readonly archive: (request: Request) => Promise<Response>;
}

/** Existing allowed states, shared by Local validation and external repository conditions. */
export const ARCHIVABLE_EVENT_STATUSES = ["DRAFT", "ENDED", "TEARDOWN"] as const;

export function archivableEventStatus(status: string): boolean {
  return ARCHIVABLE_EVENT_STATUSES.some((allowed) => allowed === status);
}
