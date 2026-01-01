# @tenkacloud/design-system

HybridNext Design System - A developer-focused design system inspired by terminal color schemes.

## Installation

```bash
bun add @tenkacloud/design-system
```

## Usage

### With Tailwind CSS v4

```ts
// tailwind.config.ts
import hybridNextPreset from '@tenkacloud/design-system/tailwind.preset';

export default {
  presets: [hybridNextPreset],
  // ...
} satisfies Config;
```

### CSS Tokens

```css
/* globals.css */
@import '@tenkacloud/design-system/tokens.css';
```

### TypeScript

```ts
import { colors, typography, shadows } from '@tenkacloud/design-system';

console.log(colors.accent.DEFAULT); // #81a2be
```

## Documentation

See [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) for full design system documentation.

## License

MIT
