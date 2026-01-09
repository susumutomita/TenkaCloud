/**
 * Admin Types 型互換性テスト
 *
 * TypeScript の型チェックでコンパイル時に検証される
 * ランタイムテストではなく、型の正しさを検証するためのテスト
 */

import { describe, it, expect } from 'vitest';
import type {
  AdminEvent,
  AdminTeam,
  AdminParticipant,
  AdminListResponse,
  AdminEventFilters,
  AdminTeamFilters,
  AdminParticipantFilters,
  CreateEventRequest,
  CreateTeamRequest,
  AddParticipantRequest,
  UpdateEventRequest,
  UpdateTeamRequest,
  UpdateParticipantRequest,
  ParticipantRole,
  ParticipantStatus,
  EventStatus,
  AdminEventListResponse,
  AdminTeamListResponse,
  AdminParticipantListResponse,
  AdminChallenge,
  AdminChallengeFilters,
} from '../admin-types';
import type { ParticipantEvent, TeamInfo, TeamMember } from '../types';

describe('Admin Types 型互換性テスト', () => {
  describe('AdminEvent は ParticipantEvent を拡張すべき', () => {
    it('ParticipantEvent のフィールドを含むべき', () => {
      // 型チェック: AdminEvent が ParticipantEvent を拡張していることを確認
      const event: AdminEvent = {
        // ParticipantEvent のフィールド
        id: 'evt-1',
        name: 'Test Event',
        type: 'gameday',
        status: 'draft',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-02T00:00:00Z',
        timezone: 'Asia/Tokyo',
        participantType: 'team',
        cloudProvider: 'aws',
        regions: ['ap-northeast-1'],
        scoringType: 'realtime',
        leaderboardVisible: true,
        problemCount: 5,
        participantCount: 10,
        isRegistered: false,
        // AdminEvent 固有のフィールド
        maxParticipants: 100,
        slug: 'test-event',
        description: 'Test description',
      };

      // ParticipantEvent として代入可能であることを確認
      const participantEvent: ParticipantEvent = event;
      expect(participantEvent.id).toBe('evt-1');
    });

    it('EventStatus の値が正しく設定できるべき', () => {
      const statuses: EventStatus[] = [
        'draft',
        'scheduled',
        'active',
        'paused',
        'completed',
        'cancelled',
      ];
      expect(statuses).toHaveLength(6);
    });
  });

  describe('AdminTeam は TeamInfo を拡張すべき', () => {
    it('TeamInfo のフィールドを含むべき', () => {
      const member: TeamMember = {
        id: 'member-1',
        name: 'Test Member',
        email: 'test@example.com',
        role: 'member',
        joinedAt: '2024-01-01T00:00:00Z',
      };

      const team: AdminTeam = {
        // TeamInfo のフィールド
        id: 'team-1',
        name: 'Test Team',
        members: [member],
        captainId: 'captain-1',
        inviteCode: 'ABC123',
        // AdminTeam 固有のフィールド
        memberCount: 4,
        maxMembers: 5,
        eventsCount: 3,
        totalScore: 8500,
        createdAt: '2024-01-01T00:00:00Z',
      };

      // TeamInfo として代入可能であることを確認
      const teamInfo: TeamInfo = team;
      expect(teamInfo.id).toBe('team-1');
    });
  });

  describe('AdminParticipant 型の構造が正しいべき', () => {
    it('必須フィールドとオプショナルフィールドが正しく定義されるべき', () => {
      // 必須フィールドのみ
      const minimalParticipant: AdminParticipant = {
        id: 'participant-1',
        userId: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        role: 'participant',
        joinedAt: '2024-01-01T00:00:00Z',
        status: 'active',
      };
      expect(minimalParticipant.id).toBe('participant-1');

      // すべてのフィールド
      const fullParticipant: AdminParticipant = {
        id: 'participant-2',
        userId: 'user-2',
        displayName: 'Full User',
        email: 'full@example.com',
        role: 'admin',
        teamId: 'team-1',
        teamName: 'Test Team',
        joinedAt: '2024-01-01T00:00:00Z',
        status: 'active',
        eventsCount: 5,
        totalScore: 2500,
      };
      expect(fullParticipant.teamId).toBe('team-1');
    });

    it('ParticipantRole の値が正しく設定できるべき', () => {
      const roles: ParticipantRole[] = ['participant', 'admin'];
      expect(roles).toHaveLength(2);
    });

    it('ParticipantStatus の値が正しく設定できるべき', () => {
      const statuses: ParticipantStatus[] = ['active', 'inactive', 'banned'];
      expect(statuses).toHaveLength(3);
    });
  });

  describe('AdminListResponse ジェネリック型が正しく動作すべき', () => {
    it('イベント一覧で使用できるべき', () => {
      const response: AdminListResponse<AdminEvent> = {
        items: [],
        total: 0,
        page: 1,
        limit: 10,
        hasMore: false,
      };
      expect(response.items).toEqual([]);
    });

    it('チーム一覧で使用できるべき', () => {
      const response: AdminListResponse<AdminTeam> = {
        items: [],
        total: 0,
        page: 1,
        limit: 10,
        hasMore: false,
      };
      expect(response.items).toEqual([]);
    });

    it('参加者一覧で使用できるべき', () => {
      const response: AdminListResponse<AdminParticipant> = {
        items: [],
        total: 0,
        page: 1,
        limit: 10,
        hasMore: false,
      };
      expect(response.items).toEqual([]);
    });
  });

  describe('フィルター型が正しく定義されるべき', () => {
    it('AdminEventFilters はすべてオプショナルであるべき', () => {
      const emptyFilters: AdminEventFilters = {};
      const fullFilters: AdminEventFilters = {
        status: 'active',
        search: 'test',
        type: 'gameday',
      };
      expect(emptyFilters).toEqual({});
      expect(fullFilters.status).toBe('active');
    });

    it('AdminTeamFilters はすべてオプショナルであるべき', () => {
      const emptyFilters: AdminTeamFilters = {};
      const fullFilters: AdminTeamFilters = {
        eventId: 'evt-1',
        search: 'test',
      };
      expect(emptyFilters).toEqual({});
      expect(fullFilters.eventId).toBe('evt-1');
    });

    it('AdminParticipantFilters はすべてオプショナルであるべき', () => {
      const emptyFilters: AdminParticipantFilters = {};
      const fullFilters: AdminParticipantFilters = {
        eventId: 'evt-1',
        teamId: 'team-1',
        search: 'test',
        status: 'active',
        role: 'participant',
      };
      expect(emptyFilters).toEqual({});
      expect(fullFilters.eventId).toBe('evt-1');
    });
  });

  describe('リクエスト型が正しく定義されるべき', () => {
    it('CreateEventRequest の必須フィールドが正しいべき', () => {
      const request: CreateEventRequest = {
        name: 'New Event',
        slug: 'new-event',
        eventDate: '2024-01-01',
      };
      expect(request.name).toBe('New Event');
    });

    it('CreateTeamRequest の必須フィールドが正しいべき', () => {
      const request: CreateTeamRequest = {
        name: 'New Team',
        eventId: 'evt-1',
      };
      expect(request.name).toBe('New Team');
    });

    it('AddParticipantRequest の必須フィールドが正しいべき', () => {
      const request: AddParticipantRequest = {
        email: 'test@example.com',
      };
      expect(request.email).toBe('test@example.com');
    });

    it('UpdateEventRequest は id を必須とすべき', () => {
      const request: UpdateEventRequest = {
        id: 'evt-1',
        name: 'Updated Event',
      };
      expect(request.id).toBe('evt-1');
    });

    it('UpdateTeamRequest は id を必須とすべき', () => {
      const request: UpdateTeamRequest = {
        id: 'team-1',
        name: 'Updated Team',
      };
      expect(request.id).toBe('team-1');
    });

    it('UpdateParticipantRequest は id を必須とすべき', () => {
      const request: UpdateParticipantRequest = {
        id: 'participant-1',
        displayName: 'Updated Name',
      };
      expect(request.id).toBe('participant-1');
    });
  });

  describe('レガシーレスポンス型が互換性を持つべき', () => {
    it('AdminEventListResponse が正しい構造を持つべき', () => {
      const response: AdminEventListResponse = {
        events: [],
        total: 0,
        page: 1,
        pageSize: 10,
      };
      expect(response.events).toEqual([]);
    });

    it('AdminTeamListResponse が正しい構造を持つべき', () => {
      const response: AdminTeamListResponse = {
        teams: [],
        total: 0,
        page: 1,
        pageSize: 10,
      };
      expect(response.teams).toEqual([]);
    });

    it('AdminParticipantListResponse が正しい構造を持つべき', () => {
      const response: AdminParticipantListResponse = {
        participants: [],
        total: 0,
        page: 1,
        pageSize: 10,
      };
      expect(response.participants).toEqual([]);
    });
  });

  describe('AdminChallenge 型が正しく定義されるべき', () => {
    it('必須フィールドが設定できるべき', () => {
      const challenge: AdminChallenge = {
        id: 'challenge-1',
        eventId: 'evt-1',
        title: 'Test Challenge',
        description: 'Test description',
        difficulty: 'medium',
        maxScore: 100,
        order: 1,
        isPublished: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      expect(challenge.id).toBe('challenge-1');
    });

    it('difficulty の値が正しいべき', () => {
      const difficulties: AdminChallenge['difficulty'][] = [
        'easy',
        'medium',
        'hard',
        'expert',
      ];
      expect(difficulties).toHaveLength(4);
    });
  });

  describe('AdminChallengeFilters が正しく定義されるべき', () => {
    it('すべてオプショナルであるべき', () => {
      const emptyFilters: AdminChallengeFilters = {};
      const fullFilters: AdminChallengeFilters = {
        eventId: 'evt-1',
        difficulty: 'hard',
        isPublished: true,
        search: 'test',
      };
      expect(emptyFilters).toEqual({});
      expect(fullFilters.difficulty).toBe('hard');
    });
  });
});
