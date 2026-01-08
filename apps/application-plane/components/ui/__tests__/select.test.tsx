/**
 * Select Component テスト
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../select';

const options = [
  { value: 'option1', label: 'オプション1' },
  { value: 'option2', label: 'オプション2' },
  { value: 'option3', label: 'オプション3' },
];

describe('Select コンポーネント', () => {
  describe('基本レンダリング', () => {
    it('デフォルトの select 要素をレンダリングすべき', () => {
      render(<Select options={options} />);
      const select = screen.getByRole('combobox');
      expect(select).toBeInTheDocument();
    });

    it('オプションを正しくレンダリングすべき', () => {
      render(<Select options={options} />);
      expect(
        screen.getByRole('option', { name: 'オプション1' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'オプション2' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'オプション3' })
      ).toBeInTheDocument();
    });

    it('placeholder を表示すべき', () => {
      render(<Select options={options} placeholder="選択してください" />);
      const placeholder = screen.getByRole('option', {
        name: '選択してください',
      });
      expect(placeholder).toBeInTheDocument();
      expect(placeholder).toHaveValue('');
    });

    it('value を正しく設定すべき', () => {
      render(<Select options={options} value="option2" onChange={() => {}} />);
      const select = screen.getByRole('combobox');
      expect(select).toHaveValue('option2');
    });
  });

  describe('variants', () => {
    it('default variant のスタイルを適用すべき', () => {
      render(
        <Select options={options} variant="default" data-testid="select" />
      );
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('border-border');
    });

    it('error variant のスタイルを適用すべき', () => {
      render(<Select options={options} variant="error" data-testid="select" />);
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('border-hn-error');
    });
  });

  describe('sizes', () => {
    it('sm サイズのスタイルを適用すべき', () => {
      render(<Select options={options} selectSize="sm" data-testid="select" />);
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('text-sm');
    });

    it('md サイズのスタイルを適用すべき', () => {
      render(<Select options={options} selectSize="md" data-testid="select" />);
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('text-base');
    });

    it('lg サイズのスタイルを適用すべき', () => {
      render(<Select options={options} selectSize="lg" data-testid="select" />);
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('text-lg');
    });
  });

  describe('状態', () => {
    it('disabled 状態を適用すべき', () => {
      render(<Select options={options} disabled />);
      const select = screen.getByRole('combobox');
      expect(select).toBeDisabled();
    });

    it('required 属性を適用すべき', () => {
      render(<Select options={options} required />);
      const select = screen.getByRole('combobox');
      expect(select).toBeRequired();
    });
  });

  describe('label', () => {
    it('label を表示すべき', () => {
      render(<Select options={options} label="カテゴリ" />);
      const label = screen.getByText('カテゴリ');
      expect(label).toBeInTheDocument();
    });

    it('label が select と関連付けられるべき', () => {
      render(<Select options={options} label="カテゴリ" id="category" />);
      const select = screen.getByLabelText('カテゴリ');
      expect(select).toBeInTheDocument();
    });

    it('required の場合 label にアスタリスクを表示すべき', () => {
      render(<Select options={options} label="カテゴリ" required />);
      const asterisk = screen.getByText('*');
      expect(asterisk).toBeInTheDocument();
    });
  });

  describe('error message', () => {
    it('error メッセージを表示すべき', () => {
      render(<Select options={options} error="カテゴリを選択してください" />);
      const errorMessage = screen.getByText('カテゴリを選択してください');
      expect(errorMessage).toBeInTheDocument();
    });

    it('error がある場合 error variant を自動適用すべき', () => {
      render(<Select options={options} error="エラー" data-testid="select" />);
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('border-hn-error');
    });
  });

  describe('イベント', () => {
    it('onChange イベントが発火すべき', async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();

      render(<Select options={options} onChange={handleChange} />);
      const select = screen.getByRole('combobox');

      await user.selectOptions(select, 'option2');
      expect(handleChange).toHaveBeenCalled();
    });

    it('onFocus イベントが発火すべき', async () => {
      const handleFocus = vi.fn();
      const user = userEvent.setup();

      render(<Select options={options} onFocus={handleFocus} />);
      const select = screen.getByRole('combobox');

      await user.click(select);
      expect(handleFocus).toHaveBeenCalled();
    });

    it('onBlur イベントが発火すべき', async () => {
      const handleBlur = vi.fn();
      const user = userEvent.setup();

      render(<Select options={options} onBlur={handleBlur} />);
      const select = screen.getByRole('combobox');

      await user.click(select);
      await user.tab();
      expect(handleBlur).toHaveBeenCalled();
    });
  });

  describe('forwardRef', () => {
    it('ref を正しく転送すべき', () => {
      const ref = createRef<HTMLSelectElement>();
      render(<Select options={options} ref={ref} />);
      expect(ref.current).toBeInstanceOf(HTMLSelectElement);
    });

    it('ref 経由で focus を呼び出せるべき', () => {
      const ref = createRef<HTMLSelectElement>();
      render(<Select options={options} ref={ref} />);

      ref.current?.focus();
      expect(document.activeElement).toBe(ref.current);
    });
  });

  describe('カスタム className', () => {
    it('追加の className を適用すべき', () => {
      render(
        <Select
          options={options}
          className="custom-class"
          data-testid="select"
        />
      );
      const select = screen.getByTestId('select');
      expect(select).toHaveClass('custom-class');
    });
  });

  describe('disabled オプション', () => {
    it('個別の disabled オプションを設定すべき', () => {
      const optionsWithDisabled = [
        { value: 'option1', label: 'オプション1' },
        { value: 'option2', label: 'オプション2', disabled: true },
      ];
      render(<Select options={optionsWithDisabled} />);
      const disabledOption = screen.getByRole('option', {
        name: 'オプション2',
      });
      expect(disabledOption).toBeDisabled();
    });
  });
});
