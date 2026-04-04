/**
 * Server-side API utilities
 *
 * サーバーコンポーネントと API Routes で使用する認証・API ヘルパー
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getProblemServiceUrl } from '@/lib/api/backend-urls';

/**
 * 統一エラーレスポンス
 *
 * 全 API ルートで一貫した { error, statusCode } 形式を返す
 */
export function errorResponse(message: string, statusCode: number) {
  return NextResponse.json(
    { error: message, statusCode },
    { status: statusCode },
  );
}

/**
 * 認証エラーレスポンス
 */
export function unauthorizedResponse(message = 'Unauthorized') {
  return errorResponse(message, 401);
}

/**
 * 権限エラーレスポンス
 */
export function forbiddenResponse(message = 'Forbidden') {
  return errorResponse(message, 403);
}

/**
 * バリデーションエラーレスポンス
 */
export function badRequestResponse(message = 'Bad Request') {
  return errorResponse(message, 400);
}

/**
 * 成功レスポンス
 */
export function successResponse<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/**
 * Admin 権限チェック付きセッション取得
 *
 * セッションが存在し、admin ロールを持っている場合のみセッションを返す
 * それ以外は null を返す
 */
export async function getAdminSession() {
  const session = await auth();

  if (!session) {
    return null;
  }

  const hasAdminRole = session.roles?.includes('admin') ?? false;
  if (!hasAdminRole) {
    return null;
  }

  return session;
}

/**
 * API Base URL（サーバーサイド用）
 *
 * サーバーサイドでは内部 URL を使用可能
 * getProblemServiceUrl() から一元的に取得
 */
export const API_BASE_URL = getProblemServiceUrl();

/**
 * サーバーサイド API リクエスト
 *
 * 認証トークンを自動で付与
 */
export async function serverApiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const session = await auth();
  const token = session?.accessToken;

  const url = `${API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    // JSON パースエラー時は HTTP ステータスを使用
    const error = await response.json().catch(() => null);
    const message =
      error?.error ||
      error?.message ||
      `HTTP error! status: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}
