/**
 * HybridNext Design System
 *
 * A developer-focused design system inspired by terminal color schemes.
 */

export const colors = {
  accent: {
    DEFAULT: '#81a2be',
    bright: '#99dbff',
    muted: '#6a8aa8',
  },
  semantic: {
    success: '#b5bd68',
    warning: '#f0c674',
    error: '#cc6666',
    info: '#8abeb7',
    purple: '#b294bb',
  },
  dark: {
    bg: '#1d2528',
    surface: '#242e33',
    surfaceAlt: '#2a363b',
    elevated: '#303d42',
    text: '#c5c8c6',
    muted: '#6c7a80',
    border: '#3a4449',
  },
  light: {
    bg: '#f5f7f8',
    surface: '#ffffff',
    text: '#242e33',
    muted: '#6c7a80',
    border: '#d4dade',
  },
} as const;

export const typography = {
  fontFamily: {
    sans: "'AXIS Std', 'Helvetica Neue', Helvetica, Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', monospace",
  },
  fontSize: {
    xs: '0.75rem',
    sm: '0.875rem',
    base: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '2rem',
    '4xl': '2.5rem',
  },
} as const;

export const shadows = {
  brutal: '2px 2px 0',
  brutalSm: '1px 1px 0',
  soft: '0 4px 6px -1px rgb(0 0 0 / 0.07)',
  glow: '0 0 40px -10px',
} as const;

export const radius = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
} as const;

export default {
  colors,
  typography,
  shadows,
  radius,
};
