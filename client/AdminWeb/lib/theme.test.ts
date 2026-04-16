import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyThemePreference,
  CONTROL_PLANE_THEME_CHANGE_EVENT,
  CONTROL_PLANE_THEME_STORAGE_KEY,
  getStoredThemePreference,
  getThemeBootstrapScript,
  isTheme,
  persistThemePreference,
  resolveThemePreference,
} from './theme';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = window.localStorage;
const originalMatchMedia = window.matchMedia;

describe('theme ヘルパー', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
    window.localStorage.clear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
    document.body.className = '';
    vi.restoreAllMocks();
  });

  it('theme 文字列だけを受け入れるべき', () => {
    expect(isTheme('light')).toBe(true);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('system')).toBe(true);
    expect(isTheme('blue')).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it('window がない場合は system を返すべき', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });

    expect(getStoredThemePreference()).toBe('system');
  });

  it('localStorage が利用できない場合は system を返すべき', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: undefined,
    });

    expect(getStoredThemePreference()).toBe('system');
  });

  it('保存済み theme が不正値なら system を返すべき', () => {
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, 'invalid');

    expect(getStoredThemePreference()).toBe('system');
  });

  it('保存済み theme が有効値ならその値を返すべき', () => {
    window.localStorage.setItem(CONTROL_PLANE_THEME_STORAGE_KEY, 'dark');

    expect(getStoredThemePreference()).toBe('dark');
  });

  it('system theme はダークモード検知時に dark を解決すべき', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    expect(resolveThemePreference('system')).toBe('dark');
  });

  it('system theme はライトモード検知時に light を解決すべき', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    expect(resolveThemePreference('system')).toBe('light');
  });

  it('window がない system theme は dark を解決すべき', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });

    expect(resolveThemePreference('system')).toBe('dark');
  });

  it('system 以外の theme はそのまま返すべき', () => {
    expect(resolveThemePreference('light')).toBe('light');
    expect(resolveThemePreference('dark')).toBe('dark');
  });

  it('theme を DOM に反映すべき', () => {
    const resolved = applyThemePreference('dark');

    expect(resolved).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.body).toHaveClass('awsui-dark-mode');
  });

  it('document がない場合も解決済み theme を返すべき', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: undefined,
    });

    expect(applyThemePreference('light')).toBe('light');
  });

  it('theme を保存して変更イベントを発火すべき', () => {
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    expect(persistThemePreference('dark')).toBe('dark');
    expect(window.localStorage.getItem(CONTROL_PLANE_THEME_STORAGE_KEY)).toBe(
      'dark',
    );
    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CONTROL_PLANE_THEME_CHANGE_EVENT,
      }),
    );
  });

  it('setItem がなくても theme を反映できるべき', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn().mockReturnValue('light'),
      },
    });
    const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

    expect(persistThemePreference('light')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(dispatchEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: CONTROL_PLANE_THEME_CHANGE_EVENT,
      }),
    );
  });

  it('window がない場合はイベントを発火しないべき', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });

    expect(persistThemePreference('light')).toBe('light');
  });

  it('bootstrap script に theme 初期化ロジックを含むべき', () => {
    const script = getThemeBootstrapScript();

    expect(script).toContain(CONTROL_PLANE_THEME_STORAGE_KEY);
    expect(script).toContain('matchMedia');
    expect(script).toContain('document.documentElement.dataset.theme = theme');
  });
});
