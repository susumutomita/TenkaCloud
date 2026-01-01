import type { Config } from 'tailwindcss';

/**
 * HybridNext Tailwind Preset
 *
 * Usage in tailwind.config.ts:
 * ```ts
 * import hybridNextPreset from '@tenkacloud/design-system/tailwind.preset';
 *
 * export default {
 *   presets: [hybridNextPreset],
 *   // ... your config
 * } satisfies Config;
 * ```
 */
export default {
  theme: {
    extend: {
      colors: {
        // CSS variable based colors (for shadcn/ui compatibility)
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // HybridNext direct colors
        hn: {
          accent: 'var(--hn-accent)',
          'accent-bright': 'var(--hn-accent-bright)',
          'accent-muted': 'var(--hn-accent-muted)',
          success: 'var(--hn-success)',
          warning: 'var(--hn-warning)',
          error: 'var(--hn-error)',
          info: 'var(--hn-info)',
          purple: 'var(--hn-purple)',
        },

        // Surface hierarchy
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          elevated: 'var(--surface-elevated)',
        },
      },

      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      boxShadow: {
        brutal: 'var(--shadow-brutal)',
        'brutal-sm': 'var(--shadow-brutal-sm)',
        soft: 'var(--shadow-soft)',
        glow: 'var(--shadow-glow)',
      },

      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        float: 'float 6s ease-in-out infinite',
      },

      keyframes: {
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
    },
  },
} satisfies Partial<Config>;
