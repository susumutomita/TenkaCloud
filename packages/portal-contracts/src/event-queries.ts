/**
 * Asynchronous event query boundary shared by Local and Cloud applications.
 * Each adapter retains its existing request scope, pagination and response DTO.
 * Authentication and permission checks stay in the caller; this is not a write,
 * identity, storage-schema or cross-runtime record conversion contract.
 */
export interface EventQueryPort<ListRequest, ListResponse, DetailRequest, DetailResponse> {
  readonly list: (request: ListRequest) => Promise<ListResponse>;
  readonly detail: (request: DetailRequest) => Promise<DetailResponse>;
}
