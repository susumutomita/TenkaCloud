/**
 * Input Component テスト
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '../input';

describe('Input コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('デフォルトの input 要素をレンダリングすべき', () => {
      render(<Input />);
      const input = screen.getByRole('textbox');
      expect(input).toBeInTheDocument();
    });

    it('placeholder を表示すべき', () => {
      render(<Input placeholder="メールアドレス" />);
      const input = screen.getByPlaceholderText('メールアドレス');
      expect(input).toBeInTheDocument();
    });

    it('value を正しく設定すべき', () => {
      render(<Input value="test@example.com" onChange={() => {}} />);
      const input = screen.getByRole('textbox');
      expect(input).toHaveValue('test@example.com');
    });
  });

  describe('variants', () => {
    it('default variant のスタイルを適用すべき', () => {
      render(<Input variant="default" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('border-border');
    });

    it('error variant のスタイルを適用すべき', () => {
      render(<Input variant="error" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('border-hn-error');
    });
  });

  describe('sizes', () => {
    it('sm サイズのスタイルを適用すべき', () => {
      render(<Input inputSize="sm" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('text-sm');
    });

    it('md サイズのスタイルを適用すべき', () => {
      render(<Input inputSize="md" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('text-base');
    });

    it('lg サイズのスタイルを適用すべき', () => {
      render(<Input inputSize="lg" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('text-lg');
    });
  });

  describe('状態', () => {
    it('disabled 状態を適用すべき', () => {
      render(<Input disabled />);
      const input = screen.getByRole('textbox');
      expect(input).toBeDisabled();
    });

    it('required 属性を適用すべき', () => {
      render(<Input required />);
      const input = screen.getByRole('textbox');
      expect(input).toBeRequired();
    });
  });

  describe('label', () => {
    it('label を表示すべき', () => {
      render(<Input label="メールアドレス" />);
      const label = screen.getByText('メールアドレス');
      expect(label).toBeInTheDocument();
    });

    it('label が input と関連付けられるべき', () => {
      render(<Input label="メールアドレス" id="email" />);
      const input = screen.getByLabelText('メールアドレス');
      expect(input).toBeInTheDocument();
    });

    it('required の場合 label にアスタリスクを表示すべき', () => {
      render(<Input label="メールアドレス" required />);
      const asterisk = screen.getByText('*');
      expect(asterisk).toBeInTheDocument();
    });
  });

  describe('error message', () => {
    it('error メッセージを表示すべき', () => {
      render(<Input error="メールアドレスが無効です" />);
      const errorMessage = screen.getByText('メールアドレスが無効です');
      expect(errorMessage).toBeInTheDocument();
    });

    it('error がある場合 error variant を自動適用すべき', () => {
      render(<Input error="エラー" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('border-hn-error');
    });
  });

  describe('イベント', () => {
    it('onChange イベントが発火すべき', async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<Input onChange={handleChange} />);
      const input = screen.getByRole('textbox');

      await user.type(input, 'a');
      expect(handleChange).toHaveBeenCalled();
    });

    it('onFocus イベントが発火すべき', async () => {
      const handleFocus = vi.fn();
      const user = userEvent.setup();

      render(<Input onFocus={handleFocus} />);
      const input = screen.getByRole('textbox');

      await user.click(input);
      expect(handleFocus).toHaveBeenCalled();
    });

    it('onBlur イベントが発火すべき', async () => {
      const handleBlur = vi.fn();
      const user = userEvent.setup();

      render(<Input onBlur={handleBlur} />);
      const input = screen.getByRole('textbox');

      await user.click(input);
      await user.tab();
      expect(handleBlur).toHaveBeenCalled();
    });
  });

  describe('forwardRef', () => {
    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLInputElement>();
      render(<Input ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLInputElement);
    });

    it('ref 経由で focus を呼び出せるべき', () => {
      const ref = createRef<HTMLInputElement>();
      render(<Input ref={ref} />);

      ref.current?.focus();
      expect(document.activeElement).toBe(ref.current);
    });
  });

  describe('カスタム className', () => {
    it('追加の className を適用すべき', () => {
      render(<Input className="custom-class" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveClass('custom-class');
    });
  });

  describe('type 属性', () => {
    it('type="email" を設定すべき', () => {
      render(<Input type="email" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveAttribute('type', 'email');
    });

    it('type="password" を設定すべき', () => {
      render(<Input type="password" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveAttribute('type', 'password');
    });

    it('type="number" を設定すべき', () => {
      render(<Input type="number" data-testid="input" />);
      const input = screen.getByTestId('input');
      expect(input).toHaveAttribute('type', 'number');
    });
  });
});
