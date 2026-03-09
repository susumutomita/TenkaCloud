import { describe, it, expect } from 'vitest';
import { StatusCodes } from 'http-status-codes';
import { healthRoutes } from './health';

describe('ヘルスチェック API', () => {
  describe('GET /health', () => {
    it('OK を返しサービス稼働状況を含むべき', async () => {
      const res = await healthRoutes.request('/health');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok', service: 'gameday-service' });
    });
  });

  describe('GET /ready', () => {
    it('OK を返しレディネス状態を含むべき', async () => {
      const res = await healthRoutes.request('/ready');
      expect(res.status).toBe(StatusCodes.OK);
      const body = await res.json();
      expect(body).toEqual({ status: 'ready' });
    });
  });
});
