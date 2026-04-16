/**
 * Game Status Bar
 *
 * ゲーム状態バー（スコア, スコア重み, ブラックアウト状態）
 */

import { Badge } from '@/components/ui';
import type { GameState } from '@/lib/api/gameday-types';
import { GameTimer } from './game-timer';

interface GameStatusBarProps {
  gameState: GameState | null;
  score?: number;
}

export function GameStatusBar({ gameState, score }: GameStatusBarProps) {
  if (!gameState) return null;

  return (
    <div className="flex items-center gap-4 flex-wrap">
      {/* Timer */}
      <GameTimer
        startedAt={gameState.startedAt}
        durationMinutes={gameState.durationMinutes}
        isRunning={gameState.isRunning}
      />

      {/* Score */}
      {score !== undefined && (
        <span className="font-mono text-lg font-bold text-text-primary">
          {score.toLocaleString()} pts
        </span>
      )}

      {/* Score Weight */}
      {gameState.scoreWeight === 'high' && (
        <Badge variant="warning" badgeStyle="solid" size="sm">
          2x スコア
        </Badge>
      )}

      {/* Blackout */}
      {gameState.blackout && (
        <Badge variant="danger" badgeStyle="solid" size="sm">
          BLACKOUT
        </Badge>
      )}

      {/* Running status */}
      <Badge
        variant={gameState.isRunning ? 'success' : 'default'}
        badgeStyle="subtle"
        size="sm"
        dot
      >
        {gameState.isRunning ? '稼働中' : '停止'}
      </Badge>
    </div>
  );
}
