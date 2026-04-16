import Header from '@cloudscape-design/components/header';
import { render, screen, waitFor } from '@testing-library/react';
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
  it('アプリヘッダー（TenkaCloud）が表示されるべき', async () => {
    render(<PageLayout>content</PageLayout>);
    await waitFor(() => {
      expect(screen.getAllByText('TenkaCloud').length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it('子コンテンツが表示されるべき', () => {
    render(<PageLayout>test content</PageLayout>);
    expect(screen.getByText('test content')).toBeInTheDocument();
  });

  it('awsui-dark-mode ラッパーを含むべき', () => {
    render(<PageLayout>content</PageLayout>);
    expect(document.querySelector('.awsui-dark-mode')).toBeInTheDocument();
  });

  it('header を渡すと ContentLayout でラップされるべき', () => {
    render(
      <PageLayout header={<Header variant="h1">ページタイトル</Header>}>
        content
      </PageLayout>,
    );
    expect(screen.getByText('ページタイトル')).toBeInTheDocument();
  });

  it('breadcrumbs を渡すとパンくずリストが表示されるべき', () => {
    render(
      <PageLayout
        breadcrumbs={[
          { text: 'トップ', href: '/' },
          { text: 'イベント一覧', href: '/events' },
          { text: 'イベント詳細' },
        ]}
      >
        content
      </PageLayout>,
    );
    expect(screen.getAllByText('トップ').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('イベント一覧').length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getAllByText('イベント詳細').length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('breadcrumbs なしの場合はパンくずリストが表示されないべき', () => {
    render(<PageLayout>content</PageLayout>);
    expect(
      screen.queryByRole('navigation', { name: 'パンくずリスト' }),
    ).not.toBeInTheDocument();
  });

  it('maxWidth prop でコンテンツ幅を変更できるべき', () => {
    const { container } = render(
      <PageLayout maxWidth="3xl">content</PageLayout>,
    );
    expect(container.querySelector('.max-w-3xl')).toBeInTheDocument();
  });
});
