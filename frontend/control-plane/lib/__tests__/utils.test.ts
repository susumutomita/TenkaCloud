import { describe, expect, it } from 'vitest';
import { cn } from '../utils';

describe('cn ユーティリティ関数', () => {
  it('単一のクラス名を返すべき', () => {
    expect(cn('text-red-500')).toBe('text-red-500');
  });

  it('複数のクラス名をマージすべき', () => {
    expect(cn('text-red-500', 'bg-blue-500')).toBe('text-red-500 bg-blue-500');
  });

  it('条件付きクラス名を処理すべき', () => {
    expect(cn('base', true && 'active', false && 'inactive')).toBe(
      'base active'
    );
  });

  it('Tailwind クラスの競合を解決すべき', () => {
    // twMerge により後のクラスが優先される
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('配列形式のクラス名を処理すべき', () => {
    expect(cn(['text-red-500', 'bg-blue-500'])).toBe(
      'text-red-500 bg-blue-500'
    );
  });

  it('undefined と null を無視すべき', () => {
    expect(cn('base', undefined, null, 'active')).toBe('base active');
  });

  it('空文字列を処理すべき', () => {
    expect(cn('base', '', 'active')).toBe('base active');
  });

  it('オブジェクト形式の条件付きクラスを処理すべき', () => {
    expect(cn({ 'text-red-500': true, 'bg-blue-500': false })).toBe(
      'text-red-500'
    );
  });
});
