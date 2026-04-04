/**
 * Table Component テスト
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '../table';

describe('Table コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('テーブル要素をレンダリングすべき', () => {
      render(
        <Table data-testid="table">
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const table = screen.getByTestId('table');
      expect(table.tagName).toBe('TABLE');
    });

    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>テストセル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('テストセル')).toBeInTheDocument();
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table className="custom-class" data-testid="table">
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const table = screen.getByTestId('table');
      expect(table).toHaveClass('custom-class');
    });
  });

  describe('TableHeader', () => {
    it('thead 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableHeader data-testid="header">
            <TableRow>
              <TableHead>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      const header = screen.getByTestId('header');
      expect(header.tagName).toBe('THEAD');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableHeader className="custom-header" data-testid="header">
            <TableRow>
              <TableHead>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      const header = screen.getByTestId('header');
      expect(header).toHaveClass('custom-header');
    });
  });

  describe('TableBody', () => {
    it('tbody 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableBody data-testid="body">
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const body = screen.getByTestId('body');
      expect(body.tagName).toBe('TBODY');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableBody className="custom-body" data-testid="body">
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const body = screen.getByTestId('body');
      expect(body).toHaveClass('custom-body');
    });
  });

  describe('TableFooter', () => {
    it('tfoot 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableFooter data-testid="footer">
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      const footer = screen.getByTestId('footer');
      expect(footer.tagName).toBe('TFOOT');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableFooter className="custom-footer" data-testid="footer">
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      const footer = screen.getByTestId('footer');
      expect(footer).toHaveClass('custom-footer');
    });
  });

  describe('TableRow', () => {
    it('tr 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow data-testid="row">
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const row = screen.getByTestId('row');
      expect(row.tagName).toBe('TR');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow className="custom-row" data-testid="row">
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const row = screen.getByTestId('row');
      expect(row).toHaveClass('custom-row');
    });

    it('選択状態のスタイルを適用すべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow data-state="selected" data-testid="row">
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const row = screen.getByTestId('row');
      expect(row).toHaveAttribute('data-state', 'selected');
    });

    it('クリックイベントが発火すべき', async () => {
      const handleClick = vi.fn();
      const user = userEvent.setup();

      render(
        <Table>
          <TableBody>
            <TableRow onClick={handleClick} data-testid="row">
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      await user.click(screen.getByTestId('row'));
      expect(handleClick).toHaveBeenCalled();
    });
  });

  describe('TableHead', () => {
    it('th 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead data-testid="head">ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      const head = screen.getByTestId('head');
      expect(head.tagName).toBe('TH');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="custom-head" data-testid="head">
                ヘッダー
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      const head = screen.getByTestId('head');
      expect(head).toHaveClass('custom-head');
    });

    it('sortable ヘッダーのスタイルを適用すべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead sortable data-testid="head">
                ソート可能
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      const head = screen.getByTestId('head');
      expect(head).toHaveClass('cursor-pointer');
    });

    it('sortable ヘッダーのクリックイベントが発火すべき', async () => {
      const handleSort = vi.fn();
      const user = userEvent.setup();

      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead sortable onSort={handleSort} data-testid="head">
                ソート可能
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );

      await user.click(screen.getByTestId('head'));
      expect(handleSort).toHaveBeenCalled();
    });

    it('ソート方向を表示すべき（昇順）', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead sortable sortDirection="asc" data-testid="head">
                昇順
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByTestId('head')).toHaveAttribute(
        'aria-sort',
        'ascending'
      );
    });

    it('ソート方向を表示すべき（降順）', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead sortable sortDirection="desc" data-testid="head">
                降順
              </TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByTestId('head')).toHaveAttribute(
        'aria-sort',
        'descending'
      );
    });
  });

  describe('TableCell', () => {
    it('td 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell data-testid="cell">セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const cell = screen.getByTestId('cell');
      expect(cell.tagName).toBe('TD');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="custom-cell" data-testid="cell">
                セル
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const cell = screen.getByTestId('cell');
      expect(cell).toHaveClass('custom-cell');
    });
  });

  describe('TableCaption', () => {
    it('caption 要素をレンダリングすべき', () => {
      render(
        <Table>
          <TableCaption data-testid="caption">テーブルの説明</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const caption = screen.getByTestId('caption');
      expect(caption.tagName).toBe('CAPTION');
    });

    it('カスタム className を適用すべき', () => {
      render(
        <Table>
          <TableCaption className="custom-caption" data-testid="caption">
            キャプション
          </TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      const caption = screen.getByTestId('caption');
      expect(caption).toHaveClass('custom-caption');
    });
  });

  describe('forwardRef', () => {
    it('Table の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableElement>();
      render(
        <Table ref={ref}>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableElement);
    });

    it('TableHeader の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableSectionElement>();
      render(
        <Table>
          <TableHeader ref={ref}>
            <TableRow>
              <TableHead>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(ref.current?.tagName).toBe('THEAD');
    });

    it('TableBody の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableSectionElement>();
      render(
        <Table>
          <TableBody ref={ref}>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current?.tagName).toBe('TBODY');
    });

    it('TableFooter の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableSectionElement>();
      render(
        <Table>
          <TableFooter ref={ref}>
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      expect(ref.current?.tagName).toBe('TFOOT');
    });

    it('TableRow の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableRowElement>();
      render(
        <Table>
          <TableBody>
            <TableRow ref={ref}>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableRowElement);
    });

    it('TableHead の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableCellElement>();
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead ref={ref}>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(ref.current?.tagName).toBe('TH');
    });

    it('TableCell の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableCellElement>();
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell ref={ref}>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current?.tagName).toBe('TD');
    });

    it('TableCaption の ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableCaptionElement>();
      render(
        <Table>
          <TableCaption ref={ref}>キャプション</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current?.tagName).toBe('CAPTION');
    });
  });

  describe('完全なテーブル構成', () => {
    it('全てのサブコンポーネントを組み合わせて表示すべき', () => {
      render(
        <Table>
          <TableCaption>ユーザー一覧</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>メール</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>田中太郎</TableCell>
              <TableCell>tanaka@example.com</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>鈴木花子</TableCell>
              <TableCell>suzuki@example.com</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2}>合計: 2名</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );

      expect(screen.getByText('ユーザー一覧')).toBeInTheDocument();
      expect(screen.getByText('名前')).toBeInTheDocument();
      expect(screen.getByText('メール')).toBeInTheDocument();
      expect(screen.getByText('田中太郎')).toBeInTheDocument();
      expect(screen.getByText('tanaka@example.com')).toBeInTheDocument();
      expect(screen.getByText('鈴木花子')).toBeInTheDocument();
      expect(screen.getByText('suzuki@example.com')).toBeInTheDocument();
      expect(screen.getByText('合計: 2名')).toBeInTheDocument();
    });
  });
});
