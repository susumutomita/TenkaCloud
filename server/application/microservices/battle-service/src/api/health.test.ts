import { describe, it, expect } from 'vitest';
import { healthRoutes } from './health';

describe('ヘルスチェック API', () => {
  it('GET /health でサービス稼働状況を返すべき', async () => {
    const res = await healthRoutes.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', service: 'battle-service' });
  });

  it('GET /ready でレディネス状態を返すべき', async () => {
    const res = await healthRoutes.request('/ready');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ready' });
  });
});
