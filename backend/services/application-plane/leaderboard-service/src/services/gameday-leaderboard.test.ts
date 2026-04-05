import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getGameDayLeaderboard } from './gameday-leaderboard';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GameDay Leaderboard Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GameDay リーダーボードを取得すべき', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          leaderboard: [
            {
              teamId: 'team-1',
              teamName: 'Alpha',
              score: 8000,
              rank: 1,
              attacksLaunched: 3,
              attacksReceived: 1,
              vulnerabilitiesFixed: 2,
            },
            {
              teamId: 'team-2',
              teamName: 'Beta',
              score: 6000,
              rank: 2,
              attacksLaunched: 1,
              attacksReceived: 2,
              vulnerabilitiesFixed: 1,
            },
          ],
        }),
    });

    const result = await getGameDayLeaderboard('event-1');

    expect(result).not.toBeNull();
    expect(result!.eventId).toBe('event-1');
    expect(result!.entries).toHaveLength(2);
    expect(result!.entries[0].teamName).toBe('Alpha');
    expect(result!.entries[0].score).toBe(8000);
    expect(result!.entries[1].teamName).toBe('Beta');
  });

  it('イベントが見つからない場合は null を返すべき', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await getGameDayLeaderboard('nonexistent');
    expect(result).toBeNull();
  });

  it('API エラーの場合は null を返すべき', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await getGameDayLeaderboard('event-1');
    expect(result).toBeNull();
  });

  it('認証トークンをヘッダーに含めるべき', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ leaderboard: [] }),
    });

    await getGameDayLeaderboard('event-1', 'test-token');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('空のリーダーボードを正しく処理すべき', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ leaderboard: [] }),
    });

    const result = await getGameDayLeaderboard('event-1');
    expect(result!.entries).toHaveLength(0);
  });
});
