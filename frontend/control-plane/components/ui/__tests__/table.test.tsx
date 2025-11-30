import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
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
  describe('Table', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>テスト</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('テスト')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table className="custom-table">
          <TableBody>
            <TableRow>
              <TableCell>テスト</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByRole('table')).toHaveClass('custom-table');
    });

    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableElement>();
      render(
        <Table ref={ref}>
          <TableBody>
            <TableRow>
              <TableCell>テスト</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>テスト</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByRole('table')).toHaveClass('w-full');
    });
  });

  describe('TableHeader', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByText('ヘッダー')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableHeader className="custom-header" data-testid="header">
            <TableRow>
              <TableHead>ヘッダー</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByTestId('header')).toHaveClass('custom-header');
    });

    it('ref を正しく転送すべき', () => {
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
      expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
    });
  });

  describe('TableBody', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>ボディ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('ボディ')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableBody className="custom-body" data-testid="body">
            <TableRow>
              <TableCell>ボディ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByTestId('body')).toHaveClass('custom-body');
    });

    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableSectionElement>();
      render(
        <Table>
          <TableBody ref={ref}>
            <TableRow>
              <TableCell>ボディ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
    });
  });

  describe('TableFooter', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableFooter>
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      expect(screen.getByText('フッター')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableFooter className="custom-footer" data-testid="footer">
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      expect(screen.getByTestId('footer')).toHaveClass('custom-footer');
    });

    it('ref を正しく転送すべき', () => {
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
      expect(ref.current).toBeInstanceOf(HTMLTableSectionElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableFooter data-testid="footer">
            <TableRow>
              <TableCell>フッター</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );
      expect(screen.getByTestId('footer')).toHaveClass('border-t');
    });
  });

  describe('TableRow', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>行データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('行データ')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow className="custom-row" data-testid="row">
              <TableCell>行データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByTestId('row')).toHaveClass('custom-row');
    });

    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableRowElement>();
      render(
        <Table>
          <TableBody>
            <TableRow ref={ref}>
              <TableCell>行データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableRowElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow data-testid="row">
              <TableCell>行データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByTestId('row')).toHaveClass('border-b');
    });
  });

  describe('TableHead', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>見出し</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByText('見出し')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="custom-head">見出し</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByRole('columnheader')).toHaveClass('custom-head');
    });

    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableCellElement>();
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead ref={ref}>見出し</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableCellElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>見出し</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
      );
      expect(screen.getByRole('columnheader')).toHaveClass('h-12');
      expect(screen.getByRole('columnheader')).toHaveClass('font-medium');
    });
  });

  describe('TableCell', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('セル')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="custom-cell">セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByRole('cell')).toHaveClass('custom-cell');
    });

    it('ref を正しく転送すべき', () => {
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
      expect(ref.current).toBeInstanceOf(HTMLTableCellElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>セル</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByRole('cell')).toHaveClass('p-4');
    });
  });

  describe('TableCaption', () => {
    it('children を正しくレンダリングすべき', () => {
      render(
        <Table>
          <TableCaption>キャプション</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('キャプション')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(
        <Table>
          <TableCaption className="custom-caption">キャプション</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('キャプション')).toHaveClass('custom-caption');
    });

    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTableCaptionElement>();
      render(
        <Table>
          <TableCaption ref={ref}>キャプション</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(ref.current).toBeInstanceOf(HTMLTableCaptionElement);
    });

    it('デフォルトスタイルを持つべき', () => {
      render(
        <Table>
          <TableCaption>キャプション</TableCaption>
          <TableBody>
            <TableRow>
              <TableCell>データ</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
      expect(screen.getByText('キャプション')).toHaveClass('mt-4');
      expect(screen.getByText('キャプション')).toHaveClass('text-sm');
    });
  });

  describe('Table 組み合わせ', () => {
    it('すべてのサブコンポーネントを正しく組み合わせるべき', () => {
      render(
        <Table>
          <TableCaption>テーブルキャプション</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>年齢</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>田中</TableCell>
              <TableCell>30</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>鈴木</TableCell>
              <TableCell>25</TableCell>
            </TableRow>
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>合計</TableCell>
              <TableCell>2名</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      );

      expect(screen.getByText('テーブルキャプション')).toBeInTheDocument();
      expect(screen.getByText('名前')).toBeInTheDocument();
      expect(screen.getByText('年齢')).toBeInTheDocument();
      expect(screen.getByText('田中')).toBeInTheDocument();
      expect(screen.getByText('鈴木')).toBeInTheDocument();
      expect(screen.getByText('合計')).toBeInTheDocument();
    });
  });
});
