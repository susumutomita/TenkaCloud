/**
 * Onboarding API
 *
 * テナント登録エンドポイント
 * - POST: 新規テナント登録
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

const REGISTRATION_SERVICE_URL =
  process.env.REGISTRATION_SERVICE_URL || 'http://localhost:3300/api/register';

interface OnboardingRequest {
  organizationName: string;
  plan: string;
  tenantName: string;
  tenantSlug: string;
  role?: string;
  region?: string;
}

/**
 * POST /api/onboarding
 *
 * テナント登録を実行
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json()) as OnboardingRequest;

    if (!body.organizationName?.trim()) {
      return NextResponse.json(
        { error: 'Organization name is required' },
        { status: 400 },
      );
    }

    if (!body.tenantName?.trim()) {
      return NextResponse.json(
        { error: 'Tenant name is required' },
        { status: 400 },
      );
    }

    const token = session.accessToken;

    const response = await fetch(REGISTRATION_SERVICE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        organizationName: body.organizationName,
        adminEmail: session.user?.email,
        adminName: session.user?.name,
        tier: body.plan?.toUpperCase() ?? 'FREE',
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => null);
      return NextResponse.json(
        { error: error?.error ?? 'Registration failed' },
        { status: 500 },
      );
    }

    const data = await response.json();
    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Onboarding error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Registration failed',
      },
      { status: 500 },
    );
  }
}
