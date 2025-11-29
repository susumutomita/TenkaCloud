'use client';

import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Event } from '@/lib/api/events';

interface EventCardProps {
  event: Event;
  onViewDetails?: (eventId: string) => void;
  onDeploy?: (eventId: string) => void;
  onStart?: (eventId: string) => void;
}

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-800',
  scheduled: 'bg-blue-100 text-blue-800',
  active: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-purple-100 text-purple-800',
  cancelled: 'bg-red-100 text-red-800',
};

const statusLabels: Record<string, string> = {
  draft: '下書き',
  scheduled: '予定',
  active: '開催中',
  paused: '一時停止',
  completed: '終了',
  cancelled: 'キャンセル',
};

const typeLabels: Record<string, string> = {
  gameday: 'GameDay',
  jam: 'JAM',
};

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startTime: string, endTime: string): string {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const hours = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60));
  return `${hours}時間`;
}

export function EventCard({ event, onViewDetails, onDeploy, onStart }: EventCardProps) {
  const canDeploy = event.status === 'draft' || event.status === 'scheduled';
  const canStart = event.status === 'scheduled';

  return (
    <Card className="flex flex-col h-full hover:shadow-lg transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline">{typeLabels[event.type]}</Badge>
              <Badge className={statusColors[event.status]}>
                {statusLabels[event.status]}
              </Badge>
            </div>
            <h3 className="font-semibold text-lg truncate" title={event.name}>
              {event.name}
            </h3>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pb-3">
        <div className="space-y-3 text-sm">
          {/* 日時 */}
          <div className="flex items-start gap-2">
            <svg className="h-4 w-4 text-muted-foreground mt-0.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
            </svg>
            <div>
              <div>{formatDateTime(event.startTime)}</div>
              <div className="text-muted-foreground">
                〜 {formatDateTime(event.endTime)} ({formatDuration(event.startTime, event.endTime)})
              </div>
            </div>
          </div>

          {/* 参加者 */}
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <span>
              {event.participantCount} / {event.maxParticipants}{' '}
              {event.participantType === 'team' ? 'チーム' : '人'}
            </span>
            {event.participantType === 'team' && event.minTeamSize && event.maxTeamSize && (
              <span className="text-muted-foreground">
                ({event.minTeamSize}〜{event.maxTeamSize}人/チーム)
              </span>
            )}
          </div>

          {/* 問題数 */}
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
            </svg>
            <span>{event.problemCount} 問題</span>
          </div>

          {/* クラウド・リージョン */}
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="currentColor">
              <path d="M5.5 16a3.5 3.5 0 01-.369-6.98 4 4 0 117.753-1.977A4.5 4.5 0 1113.5 16h-8z" />
            </svg>
            <span className="uppercase font-medium">{event.cloudProvider}</span>
            <span className="text-muted-foreground">
              ({event.regions.join(', ')})
            </span>
          </div>

          {/* 採点設定 */}
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
            </svg>
            <span>
              {event.scoringType === 'realtime' ? 'リアルタイム' : 'バッチ'}採点
              ({event.scoringIntervalMinutes}分間隔)
            </span>
          </div>
        </div>
      </CardContent>

      <CardFooter className="pt-0 gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => onViewDetails?.(event.id)}
        >
          詳細
        </Button>
        {canDeploy && (
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() => onDeploy?.(event.id)}
          >
            デプロイ
          </Button>
        )}
        {canStart && (
          <Button
            size="sm"
            className="flex-1"
            onClick={() => onStart?.(event.id)}
          >
            開始
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
