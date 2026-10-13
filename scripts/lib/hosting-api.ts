export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  token: string;
  nonce?: string;
  /** Trusted HTTP adapter metadata; never populated from request payload or headers. */
  externalEvaluationTrusted?: boolean;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}
/** API boundary: the HTTP transport never opens a database or executes an exercise. */
export interface HostingApi {
  admin(request: ApiRequest): Promise<ApiResponse>;
  participant(request: ApiRequest): Promise<ApiResponse>;
}
