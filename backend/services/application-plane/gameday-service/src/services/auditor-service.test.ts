import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRepository = vi.hoisted(() => ({
  getGameState: vi.fn(),
  listTeams: vi.fn(),
  createHealthCheck: vi.fn(),
  updateTeamScore: vi.fn(),
  updateTeamHealthy: vi.fn(),
}));

vi.mock('../lib/dynamodb', () => ({
  gamedayRepository: mockRepository,
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AuditorService } from './auditor-service';

describe('Auditor サービス', () => {
  let auditor: AuditorService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    auditor = new AuditorService();
  });

  afterEach(() => {
    auditor.stop();
    vi.useRealTimers();
  });

  // === httpCheck ===
  describe('httpCheck', () => {
    it('正常レスポンスで isHealthy: true を返すべき', async () => {
      vi.useRealTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 200,
        })
      );

      const result = await auditor.httpCheck('https://example.com');

      expect(result.isHealthy).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('5xx レスポンスで isHealthy: false を返すべき', async () => {
      vi.useRealTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 500,
        })
      );

      const result = await auditor.httpCheck('https://example.com');

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBe(500);
    });

    it('接続エラーで isHealthy: false, statusCode: null を返すべき', async () => {
      vi.useRealTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Connection refused'))
      );

      const result = await auditor.httpCheck('https://example.com');

      expect(result.isHealthy).toBe(false);
      expect(result.statusCode).toBeNull();
    });
  });

  // === checkTeam ===
  describe('checkTeam', () => {
    beforeEach(() => {
      vi.useRealTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
      mockRepository.createHealthCheck.mockResolvedValue({});
      mockRepository.updateTeamScore.mockResolvedValue(undefined);
      mockRepository.updateTeamHealthy.mockResolvedValue(undefined);
    });

    it('両方 UP で +100pt を付与するべき', async () => {
      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: 'https://example.com',
        apiUrl: 'https://api.example.com',
      };

      await auditor.checkTeam('event-1', team, 'normal');

      expect(mockRepository.createHealthCheck).toHaveBeenCalledTimes(2);
      expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        100
      );
      expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        true
      );
    });

    it('片方 DOWN で -100pt（通常）を適用するべき', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ status: 200 })
          .mockResolvedValueOnce({ status: 503 })
      );

      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: 'https://example.com',
        apiUrl: 'https://api.example.com',
      };

      await auditor.checkTeam('event-1', team, 'normal');

      expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        -100
      );
      expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        false
      );
    });

    it('片方 DOWN + scoreWeight high で -1000pt を適用するべき', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ status: 200 })
          .mockRejectedValueOnce(new Error('timeout'))
      );

      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: 'https://example.com',
        apiUrl: 'https://api.example.com',
      };

      await auditor.checkTeam('event-1', team, 'high');

      expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        -1000
      );
    });

    it('両方 DOWN で -100pt（通常）を適用するべき', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Connection refused'))
      );

      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: 'https://example.com',
        apiUrl: 'https://api.example.com',
      };

      await auditor.checkTeam('event-1', team, 'normal');

      expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        -100
      );
      expect(mockRepository.updateTeamHealthy).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        false
      );
    });

    it('URL 未設定のチームはスキップするべき', async () => {
      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: null,
        apiUrl: null,
      };

      await auditor.checkTeam('event-1', team, 'normal');

      expect(mockRepository.createHealthCheck).not.toHaveBeenCalled();
      expect(mockRepository.updateTeamScore).not.toHaveBeenCalled();
    });

    it('websiteUrl のみ設定時、website だけチェックするべき', async () => {
      const team = {
        eventId: 'event-1',
        teamId: 'team-1',
        teamName: 'A',
        score: 0,
        isHealthy: true,
        websiteUrl: 'https://example.com',
        apiUrl: null,
      };

      await auditor.checkTeam('event-1', team, 'normal');

      expect(mockRepository.createHealthCheck).toHaveBeenCalledTimes(1);
      expect(mockRepository.createHealthCheck).toHaveBeenCalledWith(
        expect.objectContaining({ checkType: 'website' })
      );
      expect(mockRepository.updateTeamScore).toHaveBeenCalledWith(
        'event-1',
        'team-1',
        100
      );
    });
  });

  // === runCheck ===
  describe('runCheck', () => {
    it('ゲーム未開始時はチェックをスキップするべき', async () => {
      vi.useRealTimers();
      (auditor as unknown as { eventId: string }).eventId = 'event-1';
      mockRepository.getGameState.mockResolvedValue({ isRunning: false });

      await auditor.runCheck();

      expect(mockRepository.listTeams).not.toHaveBeenCalled();
    });

    it('ゲームが存在しない場合はチェックをスキップするべき', async () => {
      vi.useRealTimers();
      (auditor as unknown as { eventId: string }).eventId = 'event-1';
      mockRepository.getGameState.mockResolvedValue(null);

      await auditor.runCheck();

      expect(mockRepository.listTeams).not.toHaveBeenCalled();
    });

    it('eventId が null の場合は早期リターンするべき', async () => {
      vi.useRealTimers();
      await auditor.runCheck();

      expect(mockRepository.getGameState).not.toHaveBeenCalled();
    });
  });

  // === start / stop ===
  describe('ライフサイクル', () => {
    it('start で isRunning が true になるべき', () => {
      mockRepository.getGameState.mockResolvedValue({ isRunning: true });
      mockRepository.listTeams.mockResolvedValue([]);

      auditor.start('event-1');

      expect(auditor.isRunning()).toBe(true);
    });

    it('stop で isRunning が false になるべき', () => {
      mockRepository.getGameState.mockResolvedValue({ isRunning: true });
      mockRepository.listTeams.mockResolvedValue([]);

      auditor.start('event-1');
      auditor.stop();

      expect(auditor.isRunning()).toBe(false);
    });

    it('二重起動しないべき', () => {
      mockRepository.getGameState.mockResolvedValue({ isRunning: true });
      mockRepository.listTeams.mockResolvedValue([]);

      auditor.start('event-1');
      auditor.start('event-1');

      expect(auditor.isRunning()).toBe(true);
    });
  });
});
