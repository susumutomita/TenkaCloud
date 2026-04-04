import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageLayout } from '../page-layout';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => null,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  signOut: vi.fn(),
}));

vi.mock('@/lib/tenant', () => ({
  useTenantOptional: () => null,
}));

describe('PageLayout', () => {
  it('ヘッダーが表示されるべき', () => {
    render(<PageLayout>content</PageLayout>);
    expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
  });

  it('子コンテンツが表示されるべき', () => {
    render(<PageLayout>test content</PageLayout>);
    expect(screen.getByText('test content')).toBeInTheDocument();
  });

  it('デフォルトで max-w-7xl が適用されるべき', () => {
    render(<PageLayout>content</PageLayout>);
    const main = document.querySelector('main');
    expect(main?.className).toContain('max-w-7xl');
  });

  it('maxWidth prop で幅を変更できるべき', () => {
    render(<PageLayout maxWidth="3xl">content</PageLayout>);
    const main = document.querySelector('main');
    expect(main?.className).toContain('max-w-3xl');
  });

  it('awsui-dark-mode ラッパーを含むべき', () => {
    render(<PageLayout>content</PageLayout>);
    expect(document.querySelector('.awsui-dark-mode')).toBeInTheDocument();
  });
});
