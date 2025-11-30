import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, badgeVariants } from '../badge';

describe('Badge コンポーネント', () => {
  describe('レンダリング', () => {
    it('children を正しくレンダリングすべき', () => {
      render(<Badge>テスト</Badge>);
      expect(screen.getByText('テスト')).toBeInTheDocument();
    });

    it('追加の className を適用すべき', () => {
      render(<Badge className="custom-class">テスト</Badge>);
      const badge = screen.getByText('テスト');
      expect(badge).toHaveClass('custom-class');
    });

    it('追加の props を渡すべき', () => {
      render(<Badge data-testid="badge">テスト</Badge>);
      expect(screen.getByTestId('badge')).toBeInTheDocument();
    });
  });

  describe('バリアント', () => {
    it('default バリアントをレンダリングすべき', () => {
      render(<Badge variant="default">Default</Badge>);
      const badge = screen.getByText('Default');
      expect(badge).toHaveClass('bg-primary');
    });

    it('secondary バリアントをレンダリングすべき', () => {
      render(<Badge variant="secondary">Secondary</Badge>);
      const badge = screen.getByText('Secondary');
      expect(badge).toHaveClass('bg-secondary');
    });

    it('destructive バリアントをレンダリングすべき', () => {
      render(<Badge variant="destructive">Destructive</Badge>);
      const badge = screen.getByText('Destructive');
      expect(badge).toHaveClass('bg-destructive');
    });

    it('outline バリアントをレンダリングすべき', () => {
      render(<Badge variant="outline">Outline</Badge>);
      const badge = screen.getByText('Outline');
      expect(badge).toHaveClass('text-foreground');
    });

    it('success バリアントをレンダリングすべき', () => {
      render(<Badge variant="success">Success</Badge>);
      const badge = screen.getByText('Success');
      expect(badge).toHaveClass('bg-green-100');
    });

    it('warning バリアントをレンダリングすべき', () => {
      render(<Badge variant="warning">Warning</Badge>);
      const badge = screen.getByText('Warning');
      expect(badge).toHaveClass('bg-yellow-100');
    });

    it('error バリアントをレンダリングすべき', () => {
      render(<Badge variant="error">Error</Badge>);
      const badge = screen.getByText('Error');
      expect(badge).toHaveClass('bg-red-100');
    });
  });

  describe('badgeVariants', () => {
    it('デフォルトバリアントのクラス名を返すべき', () => {
      const className = badgeVariants();
      expect(className).toContain('inline-flex');
      expect(className).toContain('rounded-full');
    });

    it('指定バリアントのクラス名を返すべき', () => {
      const className = badgeVariants({ variant: 'success' });
      expect(className).toContain('bg-green-100');
    });
  });
});
