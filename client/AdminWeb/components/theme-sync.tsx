'use client';

import { useEffect } from 'react';
import {
  applyThemePreference,
  CONTROL_PLANE_THEME_CHANGE_EVENT,
  getStoredThemePreference,
} from '@/lib/theme';

export function ThemeSync() {
  useEffect(() => {
    const syncTheme = () => {
      applyThemePreference(getStoredThemePreference());
    };

    syncTheme();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleMediaChange = () => {
      if (getStoredThemePreference() === 'system') {
        syncTheme();
      }
    };

    window.addEventListener(CONTROL_PLANE_THEME_CHANGE_EVENT, syncTheme);
    window.addEventListener('storage', syncTheme);
    mediaQuery.addEventListener('change', handleMediaChange);

    return () => {
      window.removeEventListener(CONTROL_PLANE_THEME_CHANGE_EVENT, syncTheme);
      window.removeEventListener('storage', syncTheme);
      mediaQuery.removeEventListener('change', handleMediaChange);
    };
  }, []);

  return null;
}
