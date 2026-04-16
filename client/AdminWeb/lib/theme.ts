import type { Theme } from '@/types/settings';

export const CONTROL_PLANE_THEME_STORAGE_KEY = 'tenkacloud-control-plane-theme';

export const CONTROL_PLANE_THEME_CHANGE_EVENT =
  'tenkacloud:control-plane-theme-change';

export function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function getStoredThemePreference(): Theme {
  if (typeof window === 'undefined') {
    return 'system';
  }

  if (
    typeof window.localStorage === 'undefined' ||
    typeof window.localStorage.getItem !== 'function'
  ) {
    return 'system';
  }

  const stored = window.localStorage.getItem(CONTROL_PLANE_THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : 'system';
}

export function resolveThemePreference(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return 'dark';
  }

  return theme;
}

export function applyThemePreference(theme: Theme): 'light' | 'dark' {
  const resolved = resolveThemePreference(theme);

  if (typeof document === 'undefined') {
    return resolved;
  }

  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('awsui-dark-mode', resolved === 'dark');

  return resolved;
}

export function persistThemePreference(theme: Theme): 'light' | 'dark' {
  if (
    typeof window !== 'undefined' &&
    typeof window.localStorage !== 'undefined' &&
    typeof window.localStorage.setItem === 'function'
  ) {
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, theme);
  }

  const resolved = applyThemePreference(theme);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(CONTROL_PLANE_THEME_CHANGE_EVENT, {
        detail: { theme, resolved },
      }),
    );
  }

  return resolved;
}

export function getThemeBootstrapScript(): string {
  return `
    (function() {
      try {
        var key = '${CONTROL_PLANE_THEME_STORAGE_KEY}';
        var stored = window.localStorage.getItem(key);
        var theme =
          stored === 'light' || stored === 'dark' || stored === 'system'
            ? stored
            : 'system';
        var resolved =
          theme === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme;
        document.documentElement.classList.toggle('dark', resolved === 'dark');
        document.documentElement.dataset.theme = theme;
        document.body.classList.toggle('awsui-dark-mode', resolved === 'dark');
      } catch (_) {}
    })();
  `;
}
