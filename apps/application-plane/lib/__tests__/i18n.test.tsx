import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectLocale, I18nProvider, resolveMessage, useI18n } from '../i18n';

const mockReplace = vi.fn();
let mockPathname = '/dashboard';
let mockSearchParams: URLSearchParams | null = null;

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

function Consumer() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="dashboard">{t('nav.dashboard')}</span>
      <span data-testid="unknown">{t('unknown.key')}</span>
      <button type="button" onClick={() => setLocale('ja')}>
        to-ja
      </button>
      <button type="button" onClick={() => setLocale('en')}>
        to-en
      </button>
    </div>
  );
}

describe('i18n', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockPathname = '/dashboard';
    mockSearchParams = null;
    window.localStorage.clear();
    document.documentElement.lang = 'en';
    vi.stubGlobal('navigator', {
      ...window.navigator,
      language: 'en-US',
    });
  });

  it('Provider 外では英語フォールバックを返すべき', () => {
    render(<Consumer />);

    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('dashboard')).toHaveTextContent('Dashboard');
    expect(screen.getByTestId('unknown')).toHaveTextContent('unknown.key');

    fireEvent.click(screen.getByRole('button', { name: 'to-ja' }));

    expect(screen.getByTestId('locale')).toHaveTextContent('en');
  });

  it('query parameter の lang=ja を優先すべき', async () => {
    mockSearchParams = new URLSearchParams('lang=ja');

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    });
    expect(screen.getByTestId('dashboard')).toHaveTextContent('ダッシュボード');
    expect(document.documentElement.lang).toBe('ja');
    expect(window.localStorage.getItem('tenkacloud_locale')).toBe('ja');
  });

  it('query が不正な場合は localStorage の値を使うべき', async () => {
    mockSearchParams = new URLSearchParams('lang=fr');
    window.localStorage.setItem('tenkacloud_locale', 'ja');

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    });
  });

  it('保存済み設定がなく navigator.language が ja の場合は日本語を使うべき', async () => {
    vi.stubGlobal('navigator', {
      ...window.navigator,
      language: 'ja-JP',
    });

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    });
  });

  it('条件に一致しない場合は英語を使うべき', async () => {
    mockSearchParams = new URLSearchParams('lang=de');

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });
    expect(screen.getByTestId('dashboard')).toHaveTextContent('Dashboard');
  });

  it('helper 関数は query と未知キーを正しく扱うべき', () => {
    expect(detectLocale(new URLSearchParams('lang=ja'))).toBe('ja');
    expect(resolveMessage('ja', 'nav.dashboard')).toBe('ダッシュボード');
    expect(resolveMessage('en', 'missing.translation')).toBe(
      'missing.translation',
    );
  });

  it('window がない場合の detectLocale は英語へフォールバックすべき', () => {
    const originalWindow = globalThis.window;
    const originalNavigator = globalThis.navigator;

    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);

    expect(detectLocale(new URLSearchParams('lang=fr'))).toBe('en');

    vi.stubGlobal('window', originalWindow);
    vi.stubGlobal('navigator', originalNavigator);
  });

  it('setLocale は query を更新して router.replace を呼ぶべき', async () => {
    mockPathname = '/events';
    mockSearchParams = new URLSearchParams('page=2');

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'to-ja' }));

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    });
    expect(window.localStorage.getItem('tenkacloud_locale')).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(mockReplace).toHaveBeenCalledWith('/events?page=2&lang=ja');

    fireEvent.click(screen.getByRole('button', { name: 'to-en' }));

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('en');
    });
    expect(mockReplace).toHaveBeenLastCalledWith('/events?page=2&lang=en');
  });

  it('searchParams が null のときは pathname のみで置換すべき', async () => {
    mockPathname = '/profile';
    mockSearchParams = null;

    render(
      <I18nProvider>
        <Consumer />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'to-ja' }));

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    });
    expect(mockReplace).toHaveBeenCalledWith('/profile?lang=ja');
  });
});
