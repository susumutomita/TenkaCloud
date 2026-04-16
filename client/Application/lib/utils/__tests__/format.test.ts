import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../format';

describe('format utilities', () => {
  it('formatDateTime \u304c\u65e5\u672c\u8a9e\u5f62\u5f0f\u3067\u65e5\u6642\u3092\u30d5\u30a9\u30fc\u30de\u30c3\u30c8\u3059\u3079\u304d', () => {
    const result = formatDateTime('2026-04-10T09:00:00Z');
    expect(result).toContain('2026');
  });

  it('formatDate \u304c\u65e5\u672c\u8a9e\u5f62\u5f0f\u3067\u65e5\u4ed8\u3092\u30d5\u30a9\u30fc\u30de\u30c3\u30c8\u3059\u3079\u304d', () => {
    const result = formatDate('2026-04-10T09:00:00Z');
    expect(result).toContain('2026');
  });
});
