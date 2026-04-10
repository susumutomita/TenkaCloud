import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeSync } from '@/components/theme-sync';
import { CONTROL_PLANE_THEME_STORAGE_KEY } from '@/lib/theme';

type MediaChangeListener = (() => void) | undefined;

function mockMatchMedia(initialMatches = false) {
  let matches = initialMatches;
  let changeListener: MediaChangeListener;

  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'change') {
        changeListener = listener;
      }
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue(mediaQueryList),
  });

  return {
    mediaQueryList,
    setMatches(next: boolean) {
      matches = next;
    },
    triggerChange() {
      changeListener?.();
    },
  };
}

describe('ThemeSync', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    document.body.className = '';
    vi.restoreAllMocks();
  });

  it('初期表示時に保存済み theme を反映し、購読解除できるべき', () => {
    const { mediaQueryList } = mockMatchMedia(true);
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, 'dark');

    const { unmount } = render(<ThemeSync />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.body).toHaveClass('awsui-dark-mode');
    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );

    unmount();

    expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );
  });

  it('system theme のとき media change で再同期すべき', () => {
    const matchMedia = mockMatchMedia(false);
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, 'system');

    render(<ThemeSync />);

    expect(document.body).not.toHaveClass('awsui-dark-mode');

    matchMedia.setMatches(true);
    matchMedia.triggerChange();

    expect(document.documentElement).toHaveClass('dark');
    expect(document.body).toHaveClass('awsui-dark-mode');
  });

  it('system 以外の theme のとき media change では再同期しないべき', () => {
    const matchMedia = mockMatchMedia(true);
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, 'dark');

    render(<ThemeSync />);

    matchMedia.setMatches(false);
    matchMedia.triggerChange();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.body).toHaveClass('awsui-dark-mode');
  });
});
