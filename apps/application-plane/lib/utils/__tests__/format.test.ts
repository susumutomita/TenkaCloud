import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../format';

describe('formatDate', () => {
  it('日付文字列を日本語形式にフォーマットすべき', () => {
    const result = formatDate('2024-06-15T00:00:00Z');
    expect(result).toContain('2024');
    expect(result).toContain('6');
    expect(result).toContain('15');
  });
});

describe('formatDateTime', () => {
  it('日時文字列を日本語形式（時刻あり）にフォーマットすべき', () => {
    const result = formatDateTime('2024-06-15T09:30:00Z');
    expect(result).toContain('2024');
    expect(result).toContain('6');
    expect(result).toContain('15');
  });
});
