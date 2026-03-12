/**
 * Participant GameDay - Event Entry
 *
 * イベントID入力でゲームに参加するランディングページ
 */

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Button, Card, CardContent, Input } from '@/components/ui';

export default function GamedayEntryPage() {
  const router = useRouter();
  const [eventId, setEventId] = useState('');

  const handleJoin = useCallback(() => {
    const trimmed = eventId.trim();
    if (!trimmed) return;
    router.push(`/gameday/${trimmed}`);
  }, [eventId, router]);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-3xl">⚔️</span>
          GameDay
        </h1>
        <p className="text-text-secondary mt-1">
          イベントIDを入力してバトルに参加します
        </p>
      </div>

      {/* Event ID Input */}
      <Card>
        <CardContent>
          <div className="flex items-end gap-4">
            <Input
              label="イベント ID"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              placeholder="event-id-here"
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            />
            <Button
              variant="primary"
              onClick={handleJoin}
              disabled={!eventId.trim()}
            >
              参加
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quick Navigation Guide */}
      <Card>
        <CardContent className="space-y-3">
          <h3 className="font-semibold text-text-primary">はじめかた</h3>
          <ol className="list-decimal list-inside space-y-2 text-text-secondary text-sm">
            <li>
              <Link href="/events" className="text-hn-accent hover:underline">
                イベント一覧
              </Link>
              から参加するイベントを選択
            </li>
            <li>イベント詳細ページで参加登録</li>
            <li>
              「バトルに参加」ボタンまたはこのページからイベントIDを入力して参加
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
