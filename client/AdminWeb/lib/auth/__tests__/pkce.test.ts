import { describe, expect, it } from 'vitest';
import { deriveChallenge, generateVerifier } from '../pkce';

describe('pkce', () => {
  describe('generateVerifier', () => {
    it('デフォルト長の verifier を生成すべき', () => {
      const verifier = generateVerifier();
      expect(verifier).toHaveLength(64);
    });

    it('指定された長さの verifier を生成すべき', () => {
      expect(generateVerifier(43)).toHaveLength(43);
      expect(generateVerifier(128)).toHaveLength(128);
    });

    it('base64url 安全な文字のみを含むべき', () => {
      const verifier = generateVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('呼ぶたびに異なる verifier を返すべき', () => {
      const v1 = generateVerifier();
      const v2 = generateVerifier();
      expect(v1).not.toBe(v2);
    });
  });

  describe('deriveChallenge', () => {
    it('verifier から challenge を派生させるべき', async () => {
      const verifier = generateVerifier();
      const challenge = await deriveChallenge(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge).not.toBe(verifier);
    });

    it('同じ verifier から同じ challenge を返すべき', async () => {
      const verifier = 'fixed-verifier-for-determinism-check';
      const c1 = await deriveChallenge(verifier);
      const c2 = await deriveChallenge(verifier);
      expect(c1).toBe(c2);
    });

    it('異なる verifier から異なる challenge を返すべき', async () => {
      const c1 = await deriveChallenge('verifier-a');
      const c2 = await deriveChallenge('verifier-b');
      expect(c1).not.toBe(c2);
    });
  });
});
