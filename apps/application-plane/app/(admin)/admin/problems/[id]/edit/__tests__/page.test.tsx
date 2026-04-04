import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminProblemEditPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'prob-123' }),
}));
const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
  put: (...args: unknown[]) => mockPut(...args),
}));

const mockProblem = {
  id: 'prob-123',
  title: '既存の問題',
  type: 'gameday',
  category: 'security',
  difficulty: 'hard',
  description: {
    overview: '既存の概要テキスト',
    objectives: ['目標1', '目標2'],
    hints: ['ヒント1'],
    prerequisites: ['前提知識1'],
    estimatedTime: 60,
  },
  deployment: {
    providers: ['aws'],
    templates: {},
    regions: { aws: ['ap-northeast-1'] },
  },
  scoring: {
    type: 'lambda',
    path: 'scoring/',
    timeoutMinutes: 30,
    criteria: [
      {
        name: '可用性',
        description: 'サービスの可用性を評価',
        weight: 1,
        maxPoints: 100,
      },
    ],
  },
  metadata: {
    author: 'テスト作成者',
    version: '1.0.0',
    tags: ['aws', 'security'],
  },
};

describe('問題編集ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中にスケルトンを表示すべき', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AdminProblemEditPage />);
    expect(
      document.querySelectorAll('[class*="animate-pulse"]').length
    ).toBeGreaterThan(0);
  });
  it('データ取得後にフォームを表示すべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByText('問題編集: 既存の問題')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
  });
  it('API から問題データを取得すべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/admin/problems/prob-123');
    });
  });
  it('取得エラー時にエラーメッセージを表示すべき', async () => {
    mockGet.mockRejectedValue(new Error('Not Found'));
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByText('問題の取得に失敗しました')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', { name: '問題一覧に戻る' })
    ).toBeInTheDocument();
  });
  it('更新ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(
        screen.getAllByRole('button', { name: '更新' }).length
      ).toBeGreaterThan(0);
    });
  });
  it('既存データがフォームに反映されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('テスト作成者')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('aws')).toBeInTheDocument();
    expect(screen.getByText('security')).toBeInTheDocument();
  });
  it('正常送信時に PUT API を呼び出してリダイレクトすべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    mockPut.mockResolvedValue({ id: 'prob-123' });
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
    });
    await userEvent.click(screen.getAllByRole('button', { name: '更新' })[0]);
    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/admin/problems/prob-123',
        expect.objectContaining({ title: '既存の問題' })
      );
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/problems');
  });
  it('API 更新エラー時にエラーメッセージを表示すべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    mockPut.mockRejectedValue(new Error('更新に失敗'));
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
    });
    await userEvent.click(screen.getAllByRole('button', { name: '更新' })[0]);
    await waitFor(() => {
      expect(screen.getByText('更新に失敗')).toBeInTheDocument();
    });
  });
  it('タイトルを空にするとバリデーションエラーを表示すべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
    });
    await userEvent.clear(screen.getByDisplayValue('既存の問題'));
    await userEvent.click(screen.getAllByRole('button', { name: '更新' })[0]);
    await waitFor(() => {
      expect(screen.getByText('タイトルは必須です')).toBeInTheDocument();
    });
    expect(mockPut).not.toHaveBeenCalled();
  });
  it('問題詳細に戻るリンクが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByText('問題詳細に戻る')).toBeInTheDocument();
    });
  });
  it('全セクションが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByText('基本情報')).toBeInTheDocument();
    });
    expect(screen.getByText('説明')).toBeInTheDocument();
    expect(screen.getByText('デプロイメント')).toBeInTheDocument();
    expect(screen.getByText('採点設定')).toBeInTheDocument();
    expect(screen.getByText('メタデータ')).toBeInTheDocument();
  });
  it('更新エラーが Error 以外の場合もエラーメッセージを表示すべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    mockPut.mockRejectedValue('string error');
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存の問題')).toBeInTheDocument();
    });
    await userEvent.click(screen.getAllByRole('button', { name: '更新' })[0]);
    await waitFor(() => {
      expect(screen.getByText('送信に失敗しました')).toBeInTheDocument();
    });
  });
  it('既存の採点基準が表示されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('可用性')).toBeInTheDocument();
    });
    expect(
      screen.getByDisplayValue('サービスの可用性を評価')
    ).toBeInTheDocument();
  });
  it('既存の目標が表示されるべき', async () => {
    mockGet.mockResolvedValue(mockProblem);
    render(<AdminProblemEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('目標1')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('目標2')).toBeInTheDocument();
  });
});
