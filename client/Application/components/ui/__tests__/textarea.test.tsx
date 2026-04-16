/**
 * Textarea Component テスト
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Textarea } from '../textarea';

describe('Textarea コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('デフォルトの textarea 要素をレンダリングすべき', () => {
      render(<Textarea />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeInTheDocument();
    });

    it('placeholder を表示すべき', () => {
      render(<Textarea placeholder="説明を入力" />);
      const textarea = screen.getByPlaceholderText('説明を入力');
      expect(textarea).toBeInTheDocument();
    });

    it('value を正しく設定すべき', () => {
      render(<Textarea value="テスト内容" onChange={() => {}} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveValue('テスト内容');
    });
  });

  describe('variants', () => {
    it('default variant のスタイルを適用すべき', () => {
      render(<Textarea variant="default" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('border-border');
    });

    it('error variant のスタイルを適用すべき', () => {
      render(<Textarea variant="error" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('border-hn-error');
    });
  });

  describe('sizes', () => {
    it('sm サイズのスタイルを適用すべき', () => {
      render(<Textarea textareaSize="sm" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('text-sm');
    });

    it('md サイズのスタイルを適用すべき', () => {
      render(<Textarea textareaSize="md" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('text-base');
    });

    it('lg サイズのスタイルを適用すべき', () => {
      render(<Textarea textareaSize="lg" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('text-lg');
    });
  });

  describe('状態', () => {
    it('disabled 状態を適用すべき', () => {
      render(<Textarea disabled />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeDisabled();
    });

    it('required 属性を適用すべき', () => {
      render(<Textarea required />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toBeRequired();
    });
  });

  describe('label', () => {
    it('label を表示すべき', () => {
      render(<Textarea label="説明" />);
      const label = screen.getByText('説明');
      expect(label).toBeInTheDocument();
    });

    it('label が textarea と関連付けられるべき', () => {
      render(<Textarea label="説明" id="description" />);
      const textarea = screen.getByLabelText('説明');
      expect(textarea).toBeInTheDocument();
    });

    it('required の場合 label にアスタリスクを表示すべき', () => {
      render(<Textarea label="説明" required />);
      const asterisk = screen.getByText('*');
      expect(asterisk).toBeInTheDocument();
    });
  });

  describe('error message', () => {
    it('error メッセージを表示すべき', () => {
      render(<Textarea error="説明を入力してください" />);
      const errorMessage = screen.getByText('説明を入力してください');
      expect(errorMessage).toBeInTheDocument();
    });

    it('error がある場合 error variant を自動適用すべき', () => {
      render(<Textarea error="エラー" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('border-hn-error');
    });
  });

  describe('イベント', () => {
    it('onChange イベントが発火すべき', async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<Textarea onChange={handleChange} />);
      const textarea = screen.getByRole('textbox');

      await user.type(textarea, 'a');
      expect(handleChange).toHaveBeenCalled();
    });

    it('onFocus イベントが発火すべき', async () => {
      const handleFocus = vi.fn();
      const user = userEvent.setup();

      render(<Textarea onFocus={handleFocus} />);
      const textarea = screen.getByRole('textbox');

      await user.click(textarea);
      expect(handleFocus).toHaveBeenCalled();
    });

    it('onBlur イベントが発火すべき', async () => {
      const handleBlur = vi.fn();
      const user = userEvent.setup();

      render(<Textarea onBlur={handleBlur} />);
      const textarea = screen.getByRole('textbox');

      await user.click(textarea);
      await user.tab();
      expect(handleBlur).toHaveBeenCalled();
    });
  });

  describe('forwardRef', () => {
    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLTextAreaElement>();
      render(<Textarea ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    });

    it('ref 経由で focus を呼び出せるべき', () => {
      const ref = createRef<HTMLTextAreaElement>();
      render(<Textarea ref={ref} />);

      ref.current?.focus();
      expect(document.activeElement).toBe(ref.current);
    });
  });

  describe('カスタム className', () => {
    it('追加の className を適用すべき', () => {
      render(<Textarea className="custom-class" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('custom-class');
    });
  });

  describe('rows 属性', () => {
    it('rows を設定すべき', () => {
      render(<Textarea rows={5} data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveAttribute('rows', '5');
    });

    it('デフォルトで rows=3 を設定すべき', () => {
      render(<Textarea data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveAttribute('rows', '3');
    });
  });

  describe('resize', () => {
    it('resize を無効にするスタイルを適用すべき', () => {
      render(<Textarea resize="none" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('resize-none');
    });

    it('resize を vertical にするスタイルを適用すべき', () => {
      render(<Textarea resize="vertical" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('resize-y');
    });

    it('resize を horizontal にするスタイルを適用すべき', () => {
      render(<Textarea resize="horizontal" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('resize-x');
    });

    it('resize を both にするスタイルを適用すべき', () => {
      render(<Textarea resize="both" data-testid="textarea" />);
      const textarea = screen.getByTestId('textarea');
      expect(textarea).toHaveClass('resize');
    });
  });
});
