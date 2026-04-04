/**
 * Health Check API
 *
 * 全バックエンドサービスのヘルスステータスを返す
 * - GET: 各サービスの接続状態を確認
 */

import { NextResponse } from 'next/server';
import { getAllServiceUrls } from '@/lib/api/backend-urls';

/**
 * 個別サービスのヘルスチェック結果
 */
interface ServiceHealth {
  name: string;
  url: string;
  status: 'healthy' | 'unhealthy';
  error?: string;
}

/**
 * サービスのヘルスチェックを実行する
 */
async function checkService(name: string, url: string): Promise<ServiceHealth> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        name,
        url,
        status: 'unhealthy',
        error: `HTTP ${response.status}`,
      };
    }

    return { name, url, status: 'healthy' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { name, url, status: 'unhealthy', error: message };
  }
}

/**
 * GET /api/health
 *
 * 全バックエンドサービスのヘルスチェックを実行
 */
export async function GET() {
  const serviceUrls = getAllServiceUrls();

  const services = await Promise.all(
    Object.entries(serviceUrls).map(([name, url]) => checkService(name, url))
  );

  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const totalCount = services.length;

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (healthyCount === totalCount) {
    status = 'healthy';
  } else if (healthyCount === 0) {
    status = 'unhealthy';
  } else {
    status = 'degraded';
  }

  const httpStatus = status === 'healthy' ? 200 : 503;

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      services,
    },
    { status: httpStatus }
  );
}
