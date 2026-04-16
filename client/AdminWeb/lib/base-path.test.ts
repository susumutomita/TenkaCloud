import { describe, expect, it } from 'vitest';
import { stripControlBasePath, withControlBasePath } from './base-path';

describe('base-path ヘルパー', () => {
  it('先頭スラッシュのないパスには control prefix を付与すべき', () => {
    expect(withControlBasePath('dashboard/settings')).toBe(
      '/control/dashboard/settings',
    );
  });

  it('クエリ文字列付きの control パスは二重に prefix しないべき', () => {
    expect(withControlBasePath('/control?tab=settings')).toBe(
      '/control?tab=settings',
    );
  });

  it('ハッシュ付きの control パスは二重に prefix しないべき', () => {
    expect(withControlBasePath('/control#top')).toBe('/control#top');
  });

  it('クエリ文字列付きの control パスを正しく strip すべき', () => {
    expect(stripControlBasePath('/control?tab=settings')).toBe(
      '/?tab=settings',
    );
  });

  it('control ルートパスはルートに strip すべき', () => {
    expect(stripControlBasePath('/control')).toBe('/');
  });

  it('ハッシュ付きの control パスを正しく strip すべき', () => {
    expect(stripControlBasePath('/control#top')).toBe('/#top');
  });

  it('ネストした control パスを正しく strip すべき', () => {
    expect(stripControlBasePath('/control/dashboard/settings')).toBe(
      '/dashboard/settings',
    );
  });

  it('control 配下ではないパスはそのまま返すべき', () => {
    expect(stripControlBasePath('/dashboard')).toBe('/dashboard');
  });
});
