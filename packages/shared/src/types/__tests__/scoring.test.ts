import { describe, expect, it } from 'vitest';
import {
  calculateTotalScore,
  createScoreEvent,
  GAMEDAY_POINTS,
  JAM_POINTS,
} from '../scoring';
import type { ScoreEvent } from '../scoring';

describe('\u7d71\u4e00\u30b9\u30b3\u30a2\u30ea\u30f3\u30b0\u30b9\u30ad\u30fc\u30de', () => {
  describe('GAMEDAY_POINTS', () => {
    it('\u521d\u671f\u30dd\u30a4\u30f3\u30c8\u304c 10,000 \u3067\u3042\u308b\u3079\u304d', () => {
      expect(GAMEDAY_POINTS.INITIAL).toBe(10_000);
    });

    it('\u653b\u6483\u8cfc\u5165\u30b3\u30b9\u30c8\u304c -3,000 \u3067\u3042\u308b\u3079\u304d', () => {
      expect(GAMEDAY_POINTS.ATTACK_PURCHASE).toBe(-3_000);
    });

    it('\u653b\u6483\u6210\u529f\u5831\u916c\u304c 1,000 \u3067\u3042\u308b\u3079\u304d', () => {
      expect(GAMEDAY_POINTS.ATTACK_SUCCESS).toBe(1_000);
    });

    it('\u9632\u5fa1\u6210\u529f\u5831\u916c\u304c 1,500 \u3067\u3042\u308b\u3079\u304d', () => {
      expect(GAMEDAY_POINTS.DEFENSE_FIX).toBe(1_500);
    });

    it('\u30d8\u30eb\u30b9\u30c1\u30a7\u30c3\u30af\u5408\u683c\u5831\u916c\u304c 200 \u3067\u3042\u308b\u3079\u304d', () => {
      expect(GAMEDAY_POINTS.HEALTH_CHECK_PASS).toBe(200);
    });
  });

  describe('JAM_POINTS', () => {
    it('\u30d2\u30f3\u30c8\u30da\u30ca\u30eb\u30c6\u30a3\u7387\u304c 20% \u3067\u3042\u308b\u3079\u304d', () => {
      expect(JAM_POINTS.HINT_PENALTY_RATE).toBe(0.2);
    });

    it('\u65e9\u89e3\u304d\u30dc\u30fc\u30ca\u30b9\u7387\u304c 10% \u3067\u3042\u308b\u3079\u304d', () => {
      expect(JAM_POINTS.EARLY_SOLVE_BONUS_RATE).toBe(0.1);
    });
  });

  describe('createScoreEvent', () => {
    it('\u30bf\u30a4\u30e0\u30b9\u30bf\u30f3\u30d7\u4ed8\u304d\u306e ScoreEvent \u3092\u4f5c\u6210\u3059\u3079\u304d', () => {
      const event = createScoreEvent({
        eventId: 'evt-1',
        teamId: 'team-1',
        userId: 'user-1',
        category: 'attack_success',
        points: 1000,
        metadata: { attackSlug: 'sql-injection' },
      });

      expect(event.eventId).toBe('evt-1');
      expect(event.teamId).toBe('team-1');
      expect(event.points).toBe(1000);
      expect(event.category).toBe('attack_success');
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('calculateTotalScore', () => {
    it('\u30b9\u30b3\u30a2\u30a4\u30d9\u30f3\u30c8\u306e\u5408\u8a08\u3092\u8a08\u7b97\u3059\u3079\u304d', () => {
      const events: ScoreEvent[] = [
        createScoreEvent({
          eventId: 'evt-1',
          teamId: 'team-1',
          userId: 'user-1',
          category: 'initial_points',
          points: GAMEDAY_POINTS.INITIAL,
          metadata: {},
        }),
        createScoreEvent({
          eventId: 'evt-1',
          teamId: 'team-1',
          userId: 'user-1',
          category: 'attack_purchase',
          points: GAMEDAY_POINTS.ATTACK_PURCHASE,
          metadata: {},
        }),
        createScoreEvent({
          eventId: 'evt-1',
          teamId: 'team-1',
          userId: 'user-1',
          category: 'attack_success',
          points: GAMEDAY_POINTS.ATTACK_SUCCESS,
          metadata: {},
        }),
      ];

      // 10,000 - 3,000 + 1,000 = 8,000
      expect(calculateTotalScore(events)).toBe(8_000);
    });

    it('\u7a7a\u306e\u30a4\u30d9\u30f3\u30c8\u914d\u5217\u3067 0 \u3092\u8fd4\u3059\u3079\u304d', () => {
      expect(calculateTotalScore([])).toBe(0);
    });
  });
});
