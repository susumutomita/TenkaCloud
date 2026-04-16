import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminAttackCatalogPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetAttackCatalog = vi.fn();
const mockSeedAttacks = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getAttackCatalog: (...args: unknown[]) => mockGetAttackCatalog(...args),
}));

vi.mock('@/lib/api/gameday-admin', () => ({
  seedAttacks: (...args: unknown[]) => mockSeedAttacks(...args),
}));

const baseAttack = {
  id: 'atk-1',
  slug: 'sql-injection',
  name: 'SQL Injection',
  description: 'Inject SQL',
  attackType: 'vulnerability' as const,
  purchaseCost: 100,
  damage: 50,
  reward: 150,
  cooldownSeconds: 60,
  hintCost: 50,
};

describe('AdminAttackCatalogPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAttackCatalog.mockResolvedValue({ attacks: [baseAttack] });
  });

  it('ローディング中は攻撃データを表示しないべき', () => {
    mockGetAttackCatalog.mockReturnValue(new Promise(() => {}));
    render(<AdminAttackCatalogPage />);
    expect(screen.queryByText('SQL Injection')).not.toBeInTheDocument();
  });

  it('攻撃カタログ管理ページのタイトルを表示すべき', async () => {
    render(<AdminAttackCatalogPage />);

    await waitFor(() => {
      expect(screen.getByText('攻撃カタログ管理')).toBeInTheDocument();
    });
  });

  it('攻撃一覧を表示すべき', async () => {
    render(<AdminAttackCatalogPage />);

    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
    });
  });

  it('攻撃カタログが空の場合は空状態メッセージを表示すべき', async () => {
    mockGetAttackCatalog.mockResolvedValue({ attacks: [] });
    render(<AdminAttackCatalogPage />);

    await waitFor(() => {
      expect(screen.getByText('攻撃カタログが空です')).toBeInTheDocument();
    });
  });

  it('イベントIDをヘッダーに表示すべき', async () => {
    render(<AdminAttackCatalogPage />);

    await waitFor(() => {
      expect(screen.getByText(/イベント ID: ev-1/)).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetAttackCatalog.mockRejectedValue(
      new Error('攻撃カタログの取得に失敗しました'),
    );
    render(<AdminAttackCatalogPage />);

    await waitFor(() => {
      expect(
        screen.getByText('攻撃カタログの取得に失敗しました'),
      ).toBeInTheDocument();
    });
  });
});
