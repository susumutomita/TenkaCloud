/**
 * Pagination Component テスト
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from '../pagination';

describe('Pagination コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('ページネーションをレンダリングすべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      expect(screen.getByTestId('pagination')).toBeInTheDocument();
    });

    it('現在のページ番号を表示すべき', () => {
      render(
        <Pagination currentPage={3} totalPages={10} onPageChange={() => {}} />
      );
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('前へボタンを表示すべき', () => {
      render(
        <Pagination currentPage={2} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('前のページ')).toBeInTheDocument();
    });

    it('次へボタンを表示すべき', () => {
      render(
        <Pagination currentPage={2} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('次のページ')).toBeInTheDocument();
    });
  });

  describe('前へボタン', () => {
    it('最初のページでは disabled であるべき', () => {
      render(
        <Pagination currentPage={1} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('前のページ')).toBeDisabled();
    });

    it('2ページ目以降では enabled であるべき', () => {
      render(
        <Pagination currentPage={2} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('前のページ')).not.toBeDisabled();
    });

    it('クリックで前のページに移動すべき', async () => {
      const handlePageChange = vi.fn();
      const user = userEvent.setup();

      render(
        <Pagination
          currentPage={3}
          totalPages={5}
          onPageChange={handlePageChange}
        />
      );

      await user.click(screen.getByLabelText('前のページ'));
      expect(handlePageChange).toHaveBeenCalledWith(2);
    });
  });

  describe('次へボタン', () => {
    it('最後のページでは disabled であるべき', () => {
      render(
        <Pagination currentPage={5} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('次のページ')).toBeDisabled();
    });

    it('最後のページより前では enabled であるべき', () => {
      render(
        <Pagination currentPage={4} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByLabelText('次のページ')).not.toBeDisabled();
    });

    it('クリックで次のページに移動すべき', async () => {
      const handlePageChange = vi.fn();
      const user = userEvent.setup();

      render(
        <Pagination
          currentPage={3}
          totalPages={5}
          onPageChange={handlePageChange}
        />
      );

      await user.click(screen.getByLabelText('次のページ'));
      expect(handlePageChange).toHaveBeenCalledWith(4);
    });
  });

  describe('ページ番号', () => {
    it('ページ番号をクリックでそのページに移動すべき', async () => {
      const handlePageChange = vi.fn();
      const user = userEvent.setup();

      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={handlePageChange}
        />
      );

      await user.click(screen.getByText('3'));
      expect(handlePageChange).toHaveBeenCalledWith(3);
    });

    it('現在のページはアクティブスタイルを持つべき', () => {
      render(
        <Pagination currentPage={3} totalPages={5} onPageChange={() => {}} />
      );
      const currentPageButton = screen.getByText('3').closest('button');
      expect(currentPageButton).toHaveAttribute('aria-current', 'page');
    });

    it('5ページ以下では全ページ番号を表示すべき', () => {
      render(
        <Pagination currentPage={1} totalPages={5} onPageChange={() => {}} />
      );
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  describe('省略表示', () => {
    it('多くのページがある場合は省略記号を表示すべき', () => {
      render(
        <Pagination currentPage={5} totalPages={10} onPageChange={() => {}} />
      );
      const ellipses = screen.getAllByText('...');
      expect(ellipses.length).toBeGreaterThan(0);
    });

    it('最初のページ付近では末尾の省略を表示すべき', () => {
      render(
        <Pagination currentPage={1} totalPages={10} onPageChange={() => {}} />
      );
      // 最初のページでは 1, 2, 3, ..., 10 のような表示
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });

    it('最後のページ付近では先頭の省略を表示すべき', () => {
      render(
        <Pagination currentPage={10} totalPages={10} onPageChange={() => {}} />
      );
      // 最後のページでは 1, ..., 8, 9, 10 のような表示
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  describe('1ページのみの場合', () => {
    it('ページネーションを表示しないべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={1}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
    });
  });

  describe('カスタムスタイル', () => {
    it('カスタム className を適用すべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          className="custom-pagination"
          data-testid="pagination"
        />
      );
      expect(screen.getByTestId('pagination')).toHaveClass('custom-pagination');
    });
  });

  describe('サイズ', () => {
    it('sm サイズを適用すべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          size="sm"
          data-testid="pagination"
        />
      );
      const pagination = screen.getByTestId('pagination');
      expect(pagination).toHaveClass('text-sm');
    });

    it('md サイズをデフォルトで適用すべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      const pagination = screen.getByTestId('pagination');
      expect(pagination).toHaveClass('text-base');
    });

    it('lg サイズを適用すべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          size="lg"
          data-testid="pagination"
        />
      );
      const pagination = screen.getByTestId('pagination');
      expect(pagination).toHaveClass('text-lg');
    });
  });

  describe('アクセシビリティ', () => {
    it('nav 要素でラップすべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });

    it('aria-label を持つべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={5}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      expect(screen.getByRole('navigation')).toHaveAttribute(
        'aria-label',
        'ページナビゲーション'
      );
    });
  });

  describe('showPageInfo', () => {
    it('ページ情報を表示すべき', () => {
      render(
        <Pagination
          currentPage={3}
          totalPages={10}
          onPageChange={() => {}}
          showPageInfo
        />
      );
      expect(screen.getByText('3 / 10 ページ')).toBeInTheDocument();
    });

    it('デフォルトではページ情報を非表示にすべき', () => {
      render(
        <Pagination currentPage={3} totalPages={10} onPageChange={() => {}} />
      );
      expect(screen.queryByText('3 / 10 ページ')).not.toBeInTheDocument();
    });
  });

  describe('disabled 状態', () => {
    it('disabled で全てのボタンを無効化すべき', () => {
      render(
        <Pagination
          currentPage={3}
          totalPages={5}
          onPageChange={() => {}}
          disabled
        />
      );
      const buttons = screen.getAllByRole('button');
      for (const button of buttons) {
        expect(button).toBeDisabled();
      }
    });
  });

  describe('エッジケース', () => {
    it('totalPages が 0 の場合は表示しないべき', () => {
      render(
        <Pagination
          currentPage={1}
          totalPages={0}
          onPageChange={() => {}}
          data-testid="pagination"
        />
      );
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
    });

    it('currentPage が totalPages を超える場合は最後のページとして扱うべき', () => {
      const handlePageChange = vi.fn();
      render(
        <Pagination
          currentPage={10}
          totalPages={5}
          onPageChange={handlePageChange}
        />
      );
      // 次へボタンは disabled
      expect(screen.getByLabelText('次のページ')).toBeDisabled();
    });

    it('currentPage が 0 以下の場合は最初のページとして扱うべき', () => {
      render(
        <Pagination currentPage={0} totalPages={5} onPageChange={() => {}} />
      );
      // 前へボタンは disabled
      expect(screen.getByLabelText('前のページ')).toBeDisabled();
    });
  });
});
