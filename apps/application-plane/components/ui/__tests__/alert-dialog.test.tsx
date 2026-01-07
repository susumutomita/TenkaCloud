/**
 * AlertDialog Component テスト
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../alert-dialog';

describe('AlertDialog コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('トリガーボタンをレンダリングすべき', () => {
      render(
        <AlertDialog>
          <AlertDialogTrigger>削除</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );
      expect(screen.getByText('削除')).toBeInTheDocument();
    });

    it('初期状態でダイアログコンテンツを表示しないべき', () => {
      render(
        <AlertDialog>
          <AlertDialogTrigger>削除</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('トリガークリックでダイアログを開くべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>削除</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('削除'));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });
    });

    it('defaultOpen で初期表示すべき', () => {
      render(
        <AlertDialog defaultOpen>
          <AlertDialogTrigger>削除</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });

  describe('AlertDialogContent', () => {
    it('ダイアログコンテンツをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent data-testid="content">
            <AlertDialogTitle>タイトル</AlertDialogTitle>
            <AlertDialogDescription>説明文</AlertDialogDescription>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('content')).toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent className="custom-content" data-testid="content">
            <AlertDialogTitle>タイトル</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('content')).toHaveClass('custom-content');
      });
    });
  });

  describe('AlertDialogHeader', () => {
    it('ヘッダーをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader data-testid="header">
              <AlertDialogTitle>タイトル</AlertDialogTitle>
            </AlertDialogHeader>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('header')).toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader className="custom-header" data-testid="header">
              <AlertDialogTitle>タイトル</AlertDialogTitle>
            </AlertDialogHeader>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('header')).toHaveClass('custom-header');
      });
    });
  });

  describe('AlertDialogTitle', () => {
    it('タイトルをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>削除の確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByText('削除の確認')).toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle className="custom-title" data-testid="title">
              タイトル
            </AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('title')).toHaveClass('custom-title');
      });
    });
  });

  describe('AlertDialogDescription', () => {
    it('説明文をレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogDescription>
              この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(
          screen.getByText('この操作は取り消せません。')
        ).toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogDescription className="custom-desc" data-testid="desc">
              説明
            </AlertDialogDescription>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('desc')).toHaveClass('custom-desc');
      });
    });
  });

  describe('AlertDialogFooter', () => {
    it('フッターをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter data-testid="footer">
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction>確認</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('footer')).toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter className="custom-footer" data-testid="footer">
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('footer')).toHaveClass('custom-footer');
      });
    });
  });

  describe('AlertDialogCancel', () => {
    it('キャンセルボタンをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByText('キャンセル')).toBeInTheDocument();
      });
    });

    it('クリックでダイアログを閉じるべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });

      await user.click(screen.getByText('キャンセル'));
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogCancel className="custom-cancel" data-testid="cancel">
                キャンセル
              </AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('cancel')).toHaveClass('custom-cancel');
      });
    });
  });

  describe('AlertDialogAction', () => {
    it('アクションボタンをレンダリングすべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogAction>削除する</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByText('削除する')).toBeInTheDocument();
      });
    });

    it('クリックでダイアログを閉じてアクションを実行すべき', async () => {
      const handleAction = vi.fn();
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogAction onClick={handleAction}>
                削除する
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });

      await user.click(screen.getByText('削除する'));
      expect(handleAction).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });
    });

    it('カスタム className を適用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogAction className="custom-action" data-testid="action">
                削除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      await waitFor(() => {
        expect(screen.getByTestId('action')).toHaveClass('custom-action');
      });
    });
  });

  describe('制御されたダイアログ', () => {
    it('open prop でダイアログを制御すべき', () => {
      render(
        <AlertDialog open>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('onOpenChange コールバックが呼ばれるべき', async () => {
      const handleOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <AlertDialog onOpenChange={handleOpenChange}>
          <AlertDialogTrigger>開く</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      await user.click(screen.getByText('開く'));
      expect(handleOpenChange).toHaveBeenCalledWith(true);

      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });

      await user.click(screen.getByText('キャンセル'));
      expect(handleOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('削除確認ダイアログの典型的な使用例', () => {
    it('削除確認ダイアログが正しく動作すべき', async () => {
      const handleDelete = vi.fn();
      const user = userEvent.setup();

      render(
        <AlertDialog>
          <AlertDialogTrigger>削除</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>本当に削除しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                この操作は取り消すことができません。データは完全に削除されます。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete}>
                削除する
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );

      // トリガーをクリック
      await user.click(screen.getByText('削除'));

      // ダイアログが表示される
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.getByText('本当に削除しますか？')).toBeInTheDocument();
        expect(
          screen.getByText(
            'この操作は取り消すことができません。データは完全に削除されます。'
          )
        ).toBeInTheDocument();
      });

      // 削除ボタンをクリック
      await user.click(screen.getByText('削除する'));

      // コールバックが呼ばれ、ダイアログが閉じる
      expect(handleDelete).toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });
    });
  });

  describe('AlertDialogTrigger', () => {
    it('カスタム className を適用すべき', () => {
      render(
        <AlertDialog>
          <AlertDialogTrigger className="custom-trigger" data-testid="trigger">
            開く
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );
      expect(screen.getByTestId('trigger')).toHaveClass('custom-trigger');
    });

    it('asChild で子要素をトリガーとして使用すべき', async () => {
      const user = userEvent.setup();
      render(
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button type="button" className="custom-button">
              カスタムトリガー
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>確認</AlertDialogTitle>
          </AlertDialogContent>
        </AlertDialog>
      );

      expect(screen.getByText('カスタムトリガー')).toHaveClass('custom-button');

      await user.click(screen.getByText('カスタムトリガー'));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });
    });
  });
});
