import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Tenant } from '@/types/tenant';
import { TenantList } from '../tenant-list';

const mockTenants: Tenant[] = [
  {
    id: '1',
    name: 'テナント1',
    slug: 'tenant-1',
    status: 'ACTIVE',
    tier: 'FREE',
    adminEmail: 'admin1@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    name: 'テナント2',
    slug: 'tenant-2',
    status: 'SUSPENDED',
    tier: 'PRO',
    adminEmail: 'admin2@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
  {
    id: '3',
    name: 'テナント3',
    slug: 'tenant-3',
    status: 'ARCHIVED',
    tier: 'ENTERPRISE',
    adminEmail: 'admin3@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'SILO',
    computeType: 'KUBERNETES',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
  },
];

describe('TenantList コンポーネント', () => {
  describe('初期表示', () => {
    it('テナント一覧を表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      expect(screen.getByText('テナント1')).toBeInTheDocument();
      expect(screen.getByText('テナント2')).toBeInTheDocument();
      expect(screen.getByText('テナント3')).toBeInTheDocument();
    });

    it('件数を表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);
      expect(screen.getByText('3 件のテナント')).toBeInTheDocument();
    });

    it('検索フィールドを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);
      expect(
        screen.getByPlaceholderText('テナント名、メール、IDで検索...')
      ).toBeInTheDocument();
    });

    it('ステータスフィルターを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);
      const comboboxes = screen.getAllByRole('combobox');
      expect(comboboxes.length).toBe(2); // ステータスとTierの2つ
    });
  });

  describe('テナントが0件の場合', () => {
    it('空状態メッセージを表示すべき', () => {
      render(<TenantList tenants={[]} />);
      expect(
        screen.getByText('テナントがまだ登録されていません')
      ).toBeInTheDocument();
    });

    it('最初のテナント作成リンクを表示すべき', () => {
      render(<TenantList tenants={[]} />);
      expect(
        screen.getByRole('link', { name: '最初のテナントを作成' })
      ).toHaveAttribute('href', '/dashboard/tenants/new');
    });
  });

  describe('検索機能', () => {
    it('テナント名で検索できるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, 'テナント1');

      expect(screen.getByText('テナント1')).toBeInTheDocument();
      expect(screen.queryByText('テナント2')).not.toBeInTheDocument();
      expect(screen.queryByText('テナント3')).not.toBeInTheDocument();
    });

    it('メールアドレスで検索できるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, 'admin2@');

      expect(screen.queryByText('テナント1')).not.toBeInTheDocument();
      expect(screen.getByText('テナント2')).toBeInTheDocument();
      expect(screen.queryByText('テナント3')).not.toBeInTheDocument();
    });

    it('IDで検索できるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, '3');

      expect(screen.queryByText('テナント1')).not.toBeInTheDocument();
      expect(screen.queryByText('テナント2')).not.toBeInTheDocument();
      expect(screen.getByText('テナント3')).toBeInTheDocument();
    });

    it('検索結果がない場合、メッセージを表示すべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, '存在しないテナント');

      expect(
        screen.getByText('検索条件に一致するテナントがありません')
      ).toBeInTheDocument();
    });

    it('フィルタリング時に件数を更新すべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, 'テナント1');

      expect(screen.getByText('1 / 3 件を表示')).toBeInTheDocument();
    });
  });

  describe('ステータスフィルター', () => {
    it('ACTIVEでフィルタリングできるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const statusSelect = screen.getAllByRole('combobox')[0];
      await user.selectOptions(statusSelect, 'ACTIVE');

      expect(screen.getByText('テナント1')).toBeInTheDocument();
      expect(screen.queryByText('テナント2')).not.toBeInTheDocument();
      expect(screen.queryByText('テナント3')).not.toBeInTheDocument();
    });

    it('SUSPENDEDでフィルタリングできるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const statusSelect = screen.getAllByRole('combobox')[0];
      await user.selectOptions(statusSelect, 'SUSPENDED');

      expect(screen.queryByText('テナント1')).not.toBeInTheDocument();
      expect(screen.getByText('テナント2')).toBeInTheDocument();
      expect(screen.queryByText('テナント3')).not.toBeInTheDocument();
    });
  });

  describe('Tierフィルター', () => {
    it('ENTERPRISEでフィルタリングできるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const tierSelect = screen.getAllByRole('combobox')[1];
      await user.selectOptions(tierSelect, 'ENTERPRISE');

      expect(screen.queryByText('テナント1')).not.toBeInTheDocument();
      expect(screen.queryByText('テナント2')).not.toBeInTheDocument();
      expect(screen.getByText('テナント3')).toBeInTheDocument();
    });

    it('FREEでフィルタリングできるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      const tierSelect = screen.getAllByRole('combobox')[1];
      await user.selectOptions(tierSelect, 'FREE');

      expect(screen.getByText('テナント1')).toBeInTheDocument();
      expect(screen.queryByText('テナント2')).not.toBeInTheDocument();
      expect(screen.queryByText('テナント3')).not.toBeInTheDocument();
    });
  });

  describe('フィルタークリア', () => {
    it('フィルタークリアボタンをクリックするとすべてのフィルターがリセットされるべき', async () => {
      const user = userEvent.setup();
      render(<TenantList tenants={mockTenants} />);

      // 検索を実行して結果がない状態にする
      const searchInput =
        screen.getByPlaceholderText('テナント名、メール、IDで検索...');
      await user.type(searchInput, '存在しない');

      // フィルタークリアボタンをクリック
      const clearButton = screen.getByRole('button', {
        name: 'フィルターをクリア',
      });
      await user.click(clearButton);

      // すべてのテナントが表示される
      expect(screen.getByText('テナント1')).toBeInTheDocument();
      expect(screen.getByText('テナント2')).toBeInTheDocument();
      expect(screen.getByText('テナント3')).toBeInTheDocument();
    });
  });

  describe('テーブル表示', () => {
    it('テーブルヘッダーを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      expect(screen.getByText('テナント')).toBeInTheDocument();
      expect(screen.getByText('ステータス')).toBeInTheDocument();
      expect(screen.getByText('Tier')).toBeInTheDocument();
      expect(screen.getByText('管理者 Email')).toBeInTheDocument();
      expect(screen.getByText('作成日')).toBeInTheDocument();
      expect(screen.getByText('アクション')).toBeInTheDocument();
    });

    it('テナント詳細リンクを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      const detailLinks = screen.getAllByRole('link', { name: '詳細' });
      expect(detailLinks.length).toBe(3);
      expect(detailLinks[0]).toHaveAttribute('href', '/dashboard/tenants/1');
    });

    it('テナント編集リンクを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      const editLinks = screen.getAllByRole('link', { name: '編集' });
      expect(editLinks.length).toBe(3);
      expect(editLinks[0]).toHaveAttribute('href', '/dashboard/tenants/1/edit');
    });

    it('テナントIDを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      expect(screen.getByText('ID: 1')).toBeInTheDocument();
      expect(screen.getByText('ID: 2')).toBeInTheDocument();
      expect(screen.getByText('ID: 3')).toBeInTheDocument();
    });

    it('テナントメールを表示すべき', () => {
      render(<TenantList tenants={mockTenants} />);

      expect(screen.getByText('admin1@example.com')).toBeInTheDocument();
      expect(screen.getByText('admin2@example.com')).toBeInTheDocument();
      expect(screen.getByText('admin3@example.com')).toBeInTheDocument();
    });
  });
});
