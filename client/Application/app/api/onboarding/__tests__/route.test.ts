import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/lib/api/backend-urls', () => ({
  getProblemServiceUrl: () => 'http://localhost:3100/api',
  getTenantServiceUrl: () => 'http://localhost:3200/api/tenant',
}));

describe('Onboarding API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/onboarding', () => {
    it('\u672a\u8a8d\u8a3c\u306e\u5834\u5408\u306f 401 \u3092\u8fd4\u3059\u3079\u304d', async () => {
      mockAuth.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          organizationName: 'Test Org',
          plan: 'free',
          tenantName: 'test',
          tenantSlug: 'test',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('\u7d44\u7e54\u540d\u304c\u672a\u6307\u5b9a\u306e\u5834\u5408\u306f 400 \u3092\u8fd4\u3059\u3079\u304d', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@test.com' },
        expires: new Date().toISOString(),
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          organizationName: '',
          plan: 'free',
          tenantName: 'test',
          tenantSlug: 'test',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('\u30c6\u30ca\u30f3\u30c8\u767b\u9332\u3092\u5b9f\u884c\u3059\u3079\u304d', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@test.com' },
        expires: new Date().toISOString(),
        accessToken: 'test-token',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            tenantId: 'tenant-1',
            provisioningStatus: 'PENDING',
          }),
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          organizationName: 'Test Org',
          plan: 'free',
          tenantName: 'Test Tenant',
          tenantSlug: 'test-tenant',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.tenantId).toBe('tenant-1');
    });

    it('\u30d0\u30c3\u30af\u30a8\u30f3\u30c9\u30a8\u30e9\u30fc\u306e\u5834\u5408\u306f 500 \u3092\u8fd4\u3059\u3079\u304d', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@test.com' },
        expires: new Date().toISOString(),
        accessToken: 'test-token',
      });

      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Registration failed' }),
      });

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          organizationName: 'Test Org',
          plan: 'free',
          tenantName: 'Test Tenant',
          tenantSlug: 'test-tenant',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(500);
    });
  });
});
