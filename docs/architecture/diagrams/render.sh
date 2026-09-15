#!/usr/bin/env bash
# Requires Mermaid CLI 11.17.0 and Python 3. Extra arguments go to mmdc.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
output=apps/developer-portal/public/docs/assets/architecture
for source in docs/architecture/diagrams/*.mmd; do
  "${MMDC_BIN:-mmdc}" -i "$source" \
    -c docs/architecture/diagrams/mermaid-config.json \
    -o "$output/$(basename "$source" .mmd).svg" -b white "$@"
done
# Standalone SVGs should scroll at their readable natural size.
# Embedded images still respond to the manual's max-width: 100% rule.
python3 - <<'PY'
from pathlib import Path
import re
import xml.etree.ElementTree as ET
for path in Path('apps/developer-portal/public/docs/assets/architecture').glob('*.svg'):
    text = path.read_text()
    root = ET.fromstring(text)
    _, _, width, height = root.get('viewBox').split()
    end = text.index('>')
    tag = re.sub(r'\bwidth="[^"]*"', f'width="{width}"', text[:end])
    if re.search(r'\bheight="', tag):
        tag = re.sub(r'\bheight="[^"]*"', f'height="{height}"', tag)
    else:
        tag += f' height="{height}"'
    path.write_text(tag + text[end:])
PY
bun run scripts/landing/generate-landing-docs.ts
