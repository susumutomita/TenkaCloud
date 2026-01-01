# HybridNext Design System

A developer-focused design system inspired by terminal color schemes.
This document enables AI assistants to reproduce the design consistently.

## Design Philosophy

- **Terminal-inspired**: Muted, comfortable colors that reduce eye strain
- **Developer-focused**: Colors that work well for code editors and dashboards
- **Accessible**: High contrast ratios for readability
- **Neo-brutalism**: Subtle offset shadows for depth and character

## Core Color Palette

### Accent Colors (Signature Muted Blue)
| Token | Hex | Usage |
|-------|-----|-------|
| `--hn-accent` | `#81a2be` | Primary accent, links, buttons |
| `--hn-accent-bright` | `#99dbff` | Hover states, highlights |
| `--hn-accent-muted` | `#6a8aa8` | Disabled states, subtle accents |

### Semantic Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--hn-success` | `#b5bd68` | Success states, green actions |
| `--hn-warning` | `#f0c674` | Warnings, caution states |
| `--hn-error` | `#cc6666` | Errors, destructive actions |
| `--hn-info` | `#8abeb7` | Info messages, secondary accent |
| `--hn-purple` | `#b294bb` | Tags, badges, tertiary accent |

### Dark Mode Surfaces (Primary)
| Token | Hex | Usage |
|-------|-----|-------|
| `--surface-0` | `#1d2528` | Page background |
| `--surface-1` | `#242e33` | Cards, containers |
| `--surface-2` | `#2a363b` | Elevated cards, modals |
| `--surface-elevated` | `#303d42` | Popovers, dropdowns |

### Dark Mode Text
| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#c5c8c6` | Primary text |
| `--text-muted` | `#6c7a80` | Secondary text, placeholders |
| `--border` | `#3a4449` | Borders, dividers |

### Light Mode Surfaces
| Token | Hex | Usage |
|-------|-----|-------|
| `--surface-0` | `#f5f7f8` | Page background |
| `--surface-1` | `#ffffff` | Cards, containers |
| `--surface-2` | `#ffffff` | Elevated cards |

## Typography

### Font Stack
```css
--font-sans: 'Inter', 'Noto Sans JP', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
```

### Font Sizes
| Token | Size | Usage |
|-------|------|-------|
| `xs` | 0.75rem | Captions, labels |
| `sm` | 0.875rem | Small text |
| `base` | 1rem | Body text |
| `lg` | 1.125rem | Large body |
| `xl` | 1.25rem | Subheadings |
| `2xl` | 1.5rem | Section headings |
| `3xl` | 2rem | Page headings |
| `4xl` | 2.5rem | Hero headings |

## Shadows

### Neo-brutalism Shadows
```css
--shadow-brutal: 2px 2px 0 var(--hn-accent);
--shadow-brutal-sm: 1px 1px 0 var(--hn-accent);
```

### Soft Shadows
```css
--shadow-soft: 0 4px 6px -1px rgb(0 0 0 / 0.07);
--shadow-glow: 0 0 40px -10px var(--hn-accent);
```

## Border Roundness
```css
--radius-sm: 0.25rem;
--radius-md: 0.5rem;
--radius-lg: 0.75rem;
--radius-xl: 1rem;
```

## Utility Classes

### `.card-brutal`
Neo-brutalism card with offset shadow:
```css
.card-brutal {
  background: var(--surface-1);
  border: 2px solid var(--border);
  box-shadow: 2px 2px 0 var(--hn-accent);
  transition: all 150ms ease;
}
.card-brutal:hover {
  box-shadow: 1px 1px 0 var(--hn-accent);
  transform: translate(1px, 1px);
}
```

### `.glass`
Glass morphism effect:
```css
.glass {
  background: color-mix(in srgb, var(--surface-1) 70%, transparent);
  backdrop-filter: blur(12px);
  border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
}
```

### `.text-accent-gradient`
Gradient text using accent colors:
```css
.text-accent-gradient {
  background: linear-gradient(135deg, var(--hn-accent), var(--hn-info));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### `.glow-accent`
Subtle glow effect:
```css
.glow-accent {
  box-shadow: 0 0 40px -10px var(--hn-accent);
}
```

## Animations

### Fade In
```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### Slide Up
```css
@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### Float
```css
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
}
```

## shadcn/ui Compatibility

### HSL Variables (for shadcn/ui)
```css
:root {
  --background: 210 20% 98%;
  --foreground: 200 15% 15%;
  --primary: 207 35% 63%;
  --primary-foreground: 0 0% 100%;
  --secondary: 210 15% 93%;
  --muted: 210 15% 93%;
  --accent: 207 35% 63%;
  --destructive: 0 60% 60%;
  --border: 210 15% 85%;
  --ring: 207 35% 63%;
  --radius: 0.5rem;
}

.dark {
  --background: 195 18% 14%;
  --foreground: 30 5% 77%;
  --primary: 207 35% 63%;
  --primary-foreground: 195 18% 14%;
  --secondary: 197 12% 22%;
  --muted: 197 12% 22%;
  --accent: 207 35% 63%;
  --destructive: 0 50% 50%;
  --border: 197 12% 27%;
  --ring: 207 35% 63%;
}
```

## Usage with Tailwind CSS

### Import the preset
```ts
// tailwind.config.ts
import hybridNextPreset from '@tenkacloud/design-system/tailwind.preset';

export default {
  presets: [hybridNextPreset],
  // ...
} satisfies Config;
```

### Import CSS tokens
```css
/* In your globals.css */
@import '@tenkacloud/design-system/tokens.css';
```

## Quick Reference for AI

When implementing HybridNext design:

1. **Primary accent**: `#81a2be` (muted blue)
2. **Dark background**: `#1d2528`
3. **Card background**: `#242e33`
4. **Text color**: `#c5c8c6`
5. **Border color**: `#3a4449`
6. **Font**: Inter + Noto Sans JP
7. **Shadows**: Use `2px 2px 0` offset for neo-brutalism
8. **Hover effects**: Shift shadow to `1px 1px 0` with `translate(1px, 1px)`

---

*HybridNext Design System v1.0.0 | TenkaCloud*
