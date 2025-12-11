import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { healthRoutes } from './health';

describe('Health API', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/', healthRoutes);
  });

  describe('GET /health', () => {
    it('ヘルスステータスを返すべき', async () => {
      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('deployment-management');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /health/live', () => {
    it('ライブネスステータスを返すべき', async () => {
      const res = await app.request('/health/live');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('レディネスステータスを返すべき', async () => {
      const res = await app.request('/health/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });
});
