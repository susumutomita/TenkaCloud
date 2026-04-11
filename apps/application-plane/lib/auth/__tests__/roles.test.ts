import { describe, expect, it } from 'vitest';
import { hasApplicationAdminRole, parseAuthSkipRoles } from '../roles';

describe('auth role helpers', () => {
  describe('parseAuthSkipRoles', () => {
    it('未指定時は participant のみを返すべき', () => {
      expect(parseAuthSkipRoles()).toEqual(['participant']);
    });

    it('空白だけの指定は participant にフォールバックすべき', () => {
      expect(parseAuthSkipRoles(' ,  , ')).toEqual(['participant']);
    });

    it('カンマ区切りのロールを正規化して返すべき', () => {
      expect(parseAuthSkipRoles(' tenant-admin , participant ')).toEqual([
        'tenant-admin',
        'participant',
      ]);
    });
  });

  describe('hasApplicationAdminRole', () => {
    it('tenant-admin を管理者として扱うべき', () => {
      expect(hasApplicationAdminRole(['tenant-admin'])).toBe(true);
    });

    it('participant 単独は管理者として扱わないべき', () => {
      expect(hasApplicationAdminRole(['participant'])).toBe(false);
    });
  });
});
