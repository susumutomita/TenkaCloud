/**
 * Game Timer
 *
 * 残り時間カウントダウン
 */

'use client';

import { useEffect, useState } from 'react';

interface GameTimerProps {
  startedAt: string | null;
  durationMinutes: number;
  isRunning: boolean;
}

function formatTime(totalSeconds: number): string {
  if (totalSeconds <= 0) return '00:00:00';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export function GameTimer({
  startedAt,
  durationMinutes,
  isRunning,
}: GameTimerProps) {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    if (!isRunning || !startedAt) {
      setRemaining(0);
      return;
    }

    function calc() {
      const endMs =
        new Date(startedAt as string).getTime() + durationMinutes * 60 * 1000;
      const diff = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
      setRemaining(diff);
    }

    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMinutes, isRunning]);

  const isUrgent = remaining > 0 && remaining <= 300;

  if (!isRunning) {
    return <span className="font-mono text-lg text-text-muted">--:--:--</span>;
  }

  return (
    <span
      className={`font-mono text-lg font-bold ${
        isUrgent ? 'text-hn-error animate-pulse' : 'text-hn-accent'
      }`}
    >
      {formatTime(remaining)}
    </span>
  );
}
