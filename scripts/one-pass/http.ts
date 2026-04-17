import type { DevIdentityHeaders } from './config';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function buildHeaders(
  token?: string,
  contentType = true,
  devHeaders?: DevIdentityHeaders,
): HeadersInit {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...devHeaders,
  };
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' ? body : null;
  }

  const error = 'error' in body ? body.error : null;
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    return typeof message === 'string' ? message : null;
  }

  const message = 'message' in body ? body.message : null;
  return typeof message === 'string' ? message : null;
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  token?: string,
  devHeaders?: DevIdentityHeaders,
): Promise<T> {
  const headers = {
    ...buildHeaders(
      token,
      init.body !== undefined || init.method === 'POST',
      devHeaders,
    ),
    ...init.headers,
  };

  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const body = text.length > 0 ? safeParseJson(text) : null;

  if (!response.ok) {
    const errorMessage =
      extractErrorMessage(body) || `${response.status} ${response.statusText}`;
    throw new HttpError(errorMessage, response.status, body);
  }

  return body as T;
}

export async function requestStatus(
  url: string,
  init: RequestInit = {},
  token?: string,
  devHeaders?: DevIdentityHeaders,
): Promise<Response> {
  const headers = {
    ...buildHeaders(token, false, devHeaders),
    ...init.headers,
  };

  return fetch(url, { ...init, headers });
}

export function formatError(error: unknown): string {
  if (error instanceof HttpError) {
    const detail =
      typeof error.body === 'string'
        ? error.body
        : extractErrorMessage(error.body) || JSON.stringify(error.body);
    return `HTTP ${error.status}: ${detail}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
