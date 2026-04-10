import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerLocalMembership,
  getLocalMembership,
  createLocalTeamWithInvite,
  joinLocalTeamByInvite,
  createLocalSoloMembership,
  registerLocalTeam,
  getLocalTeams,
} from '../api/gameday-local';

function clearStore() {
  const root = globalThis as typeof globalThis & {
    __TENKACLOUD_LOCAL_GAMEDAY__?: unknown;
  };
  delete root.__TENKACLOUD_LOCAL_GAMEDAY__;
}

describe('gameday-local', () => {
  beforeEach(() => {
    clearStore();
  });

  describe('registerLocalMembership', () => {
    it('メンバーシップを登録すべき', () => {
      const result = registerLocalMembership(
        'event-1',
        'user@example.com',
        'team-1',
        'Team One',
      );
      expect(result).toEqual({ teamId: 'team-1', teamName: 'Team One' });
    });

    it('登録したメンバーシップを取得できるべき', () => {
      registerLocalMembership(
        'event-1',
        'user@example.com',
        'team-1',
        'Team One',
      );
      const membership = getLocalMembership('event-1', 'user@example.com');
      expect(membership).toEqual({ teamId: 'team-1', teamName: 'Team One' });
    });

    it('存在しないメンバーシップは null を返すべき', () => {
      expect(getLocalMembership('event-1', 'nobody@example.com')).toBeNull();
    });

    it('プロトタイプ汚染を防ぐため __proto__ キーで例外をスローすべき', () => {
      expect(() =>
        registerLocalMembership('event-1', '__proto__', 'team-1', 'Team One'),
      ).toThrow('Invalid key: __proto__');
    });

    it('プロトタイプ汚染を防ぐため constructor キーで例外をスローすべき', () => {
      expect(() =>
        registerLocalMembership('event-1', 'constructor', 'team-1', 'Team One'),
      ).toThrow('Invalid key: constructor');
    });

    it('プロトタイプ汚染を防ぐため prototype キーで例外をスローすべき', () => {
      expect(() =>
        registerLocalMembership('event-1', 'prototype', 'team-1', 'Team One'),
      ).toThrow('Invalid key: prototype');
    });
  });

  describe('createLocalTeamWithInvite', () => {
    it('招待コード付きでチームを作成すべき', () => {
      const result = createLocalTeamWithInvite(
        'event-1',
        'user@example.com',
        'TEAM01',
        'My Team',
      );
      expect(result).toEqual({
        teamId: 'TEAM01',
        teamName: 'My Team',
        inviteCode: expect.any(String),
      });
      expect(result.inviteCode).toHaveLength(6);
    });

    it('作成したチームに招待コードで参加できるべき', () => {
      const { inviteCode } = createLocalTeamWithInvite(
        'event-1',
        'creator@example.com',
        'TEAM01',
        'My Team',
      );

      const membership = joinLocalTeamByInvite(
        'event-1',
        'joiner@example.com',
        inviteCode,
      );
      expect(membership).toEqual({ teamId: 'TEAM01', teamName: 'My Team' });
    });

    it('無効な招待コードで参加すると null を返すべき', () => {
      const result = joinLocalTeamByInvite(
        'event-1',
        'user@example.com',
        'BADCODE',
      );
      expect(result).toBeNull();
    });
  });

  describe('createLocalSoloMembership', () => {
    it('メールアドレスからソロメンバーシップを作成すべき', () => {
      const membership = createLocalSoloMembership(
        'event-1',
        'player@example.com',
      );
      expect(membership.teamId).toContain('SOLO');
      expect(membership.teamName).toContain('player');
    });

    it('メールアドレスなしのユーザー ID でも動作すべき', () => {
      const membership = createLocalSoloMembership('event-1', 'anonymous');
      expect(membership.teamId).toContain('SOLO');
    });
  });

  describe('registerLocalTeam', () => {
    it('既存チームを更新すべき', () => {
      registerLocalTeam('event-1', 'team-1', 'Old Name');
      registerLocalTeam('event-1', 'team-1', 'New Name', {
        websiteUrl: 'http://example.com',
        apiUrl: 'http://api.example.com',
      });
      const teams = getLocalTeams('event-1');
      const team = teams.find((t) => t.teamId === 'team-1');
      expect(team?.teamName).toBe('New Name');
      expect(team?.websiteUrl).toBe('http://example.com');
    });
  });
});
