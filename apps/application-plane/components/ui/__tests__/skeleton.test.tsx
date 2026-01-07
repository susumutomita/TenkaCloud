/**
 * Skeleton Component テスト
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonButton, SkeletonText } from '../skeleton';

describe('Skeleton コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('div 要素をレンダリングすべき', () => {
      render(<Skeleton data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton.tagName).toBe('DIV');
    });

    it('アニメーションクラスを持つべき', () => {
      render(<Skeleton data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('animate-pulse');
    });

    it('背景色クラスを持つべき', () => {
      render(<Skeleton data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('bg-gray-200');
    });

    it('カスタム className を適用すべき', () => {
      render(<Skeleton className="custom-class" data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('custom-class');
    });
  });

  describe('サイズ', () => {
    it('width を適用すべき', () => {
      render(<Skeleton width={100} data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveStyle({ width: '100px' });
    });

    it('height を適用すべき', () => {
      render(<Skeleton height={50} data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveStyle({ height: '50px' });
    });

    it('width と height を同時に適用すべき', () => {
      render(<Skeleton width={200} height={100} data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveStyle({ width: '200px', height: '100px' });
    });

    it('パーセント指定の width を適用すべき', () => {
      render(<Skeleton width="100%" data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveStyle({ width: '100%' });
    });
  });

  describe('丸み', () => {
    it('rounded クラスをデフォルトで持つべき', () => {
      render(<Skeleton data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('rounded-md');
    });

    it('circle variant で完全な円にすべき', () => {
      render(<Skeleton variant="circle" data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('rounded-full');
    });

    it('rectangular variant で角を四角にすべき', () => {
      render(<Skeleton variant="rectangular" data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveClass('rounded-none');
    });
  });

  describe('追加のprops', () => {
    it('data-* 属性を渡せるべき', () => {
      render(<Skeleton data-testid="skeleton" data-custom="value" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveAttribute('data-custom', 'value');
    });

    it('aria-* 属性を渡せるべき', () => {
      render(<Skeleton data-testid="skeleton" aria-label="読み込み中" />);
      const skeleton = screen.getByTestId('skeleton');
      expect(skeleton).toHaveAttribute('aria-label', '読み込み中');
    });
  });
});

describe('SkeletonText コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('テキスト用のスケルトンをレンダリングすべき', () => {
      render(<SkeletonText data-testid="skeleton-text" />);
      const skeleton = screen.getByTestId('skeleton-text');
      expect(skeleton).toBeInTheDocument();
    });

    it('デフォルトで1行をレンダリングすべき', () => {
      const { container } = render(<SkeletonText />);
      const lines = container.querySelectorAll('[data-skeleton-line]');
      expect(lines.length).toBe(1);
    });

    it('指定した行数をレンダリングすべき', () => {
      const { container } = render(<SkeletonText lines={3} />);
      const lines = container.querySelectorAll('[data-skeleton-line]');
      expect(lines.length).toBe(3);
    });

    it('各行が異なる幅を持つべき（最後の行が短い）', () => {
      const { container } = render(<SkeletonText lines={3} />);
      const lines = container.querySelectorAll('[data-skeleton-line]');
      // 最後の行は他より短くなるはず
      expect(lines[lines.length - 1]).toHaveStyle({ width: '60%' });
    });
  });

  describe('サイズ', () => {
    it('sm サイズを適用すべき', () => {
      const { container } = render(<SkeletonText size="sm" />);
      const line = container.querySelector('[data-skeleton-line]');
      expect(line).toHaveClass('h-3');
    });

    it('md サイズを適用すべき', () => {
      const { container } = render(<SkeletonText size="md" />);
      const line = container.querySelector('[data-skeleton-line]');
      expect(line).toHaveClass('h-4');
    });

    it('lg サイズを適用すべき', () => {
      const { container } = render(<SkeletonText size="lg" />);
      const line = container.querySelector('[data-skeleton-line]');
      expect(line).toHaveClass('h-5');
    });
  });

  describe('カスタムスタイル', () => {
    it('カスタム className を適用すべき', () => {
      render(
        <SkeletonText className="custom-text" data-testid="skeleton-text" />
      );
      const skeleton = screen.getByTestId('skeleton-text');
      expect(skeleton).toHaveClass('custom-text');
    });
  });
});

describe('SkeletonButton コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('ボタン型のスケルトンをレンダリングすべき', () => {
      render(<SkeletonButton data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toBeInTheDocument();
    });

    it('角丸を持つべき', () => {
      render(<SkeletonButton data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('rounded-lg');
    });
  });

  describe('サイズ', () => {
    it('sm サイズを適用すべき', () => {
      render(<SkeletonButton size="sm" data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('h-8');
      expect(skeleton).toHaveClass('w-16');
    });

    it('md サイズを適用すべき', () => {
      render(<SkeletonButton size="md" data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('h-10');
      expect(skeleton).toHaveClass('w-20');
    });

    it('lg サイズを適用すべき', () => {
      render(<SkeletonButton size="lg" data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('h-12');
      expect(skeleton).toHaveClass('w-24');
    });
  });

  describe('fullWidth', () => {
    it('fullWidth を適用すべき', () => {
      render(<SkeletonButton fullWidth data-testid="skeleton-button" />);
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('w-full');
    });
  });

  describe('カスタムスタイル', () => {
    it('カスタム className を適用すべき', () => {
      render(
        <SkeletonButton
          className="custom-button"
          data-testid="skeleton-button"
        />
      );
      const skeleton = screen.getByTestId('skeleton-button');
      expect(skeleton).toHaveClass('custom-button');
    });
  });
});

describe('コンポーネント組み合わせ', () => {
  it('カード型のローディングスケルトンを構成すべき', () => {
    render(
      <div data-testid="card-skeleton">
        <Skeleton variant="rectangular" height={200} width="100%" />
        <div className="p-4">
          <SkeletonText lines={2} />
          <SkeletonButton size="sm" />
        </div>
      </div>
    );

    const card = screen.getByTestId('card-skeleton');
    expect(card).toBeInTheDocument();
  });

  it('リスト型のローディングスケルトンを構成すべき', () => {
    render(
      <div data-testid="list-skeleton">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 p-2">
            <Skeleton variant="circle" width={40} height={40} />
            <SkeletonText lines={1} className="flex-1" />
          </div>
        ))}
      </div>
    );

    const list = screen.getByTestId('list-skeleton');
    expect(list).toBeInTheDocument();
  });
});
