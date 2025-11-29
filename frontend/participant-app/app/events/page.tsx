/**
 * Events List Page
 *
 * イベント一覧ページ
 */

"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Header } from "../../components/layout";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EventStatusBadge,
  ProblemTypeBadge,
} from "../../components/ui";
import { getAvailableEvents } from "../../lib/api/events";
import type {
  EventStatus,
  ParticipantEvent,
  ProblemType,
} from "../../lib/api/types";

export default function EventsPage() {
  const [events, setEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<{
    status?: EventStatus;
    type?: ProblemType;
  }>({});
  const statusFilterId = useId();
  const typeFilterId = useId();

  useEffect(() => {
    async function fetchEvents() {
      try {
        setLoading(true);
        const statusFilter = filter.status
          ? [filter.status]
          : ["scheduled", "active"];
        const res = await getAvailableEvents({
          status: statusFilter as EventStatus[],
          type: filter.type,
          limit: 50,
        });
        setEvents(res.events);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [filter]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getTimeUntilStart = (startTime: string) => {
    const now = new Date();
    const start = new Date(startTime);
    const diff = start.getTime() - now.getTime();

    if (diff <= 0) return null;

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 0) {
      return `あと ${days} 日 ${hours} 時間`;
    }
    if (hours > 0) {
      return `あと ${hours} 時間`;
    }
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `あと ${minutes} 分`;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header userName="参加者" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-gray-900">イベント一覧</h1>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div>
            <label
              htmlFor={statusFilterId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              ステータス
            </label>
            <select
              id={statusFilterId}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
              value={filter.status || ""}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  status: (e.target.value as EventStatus) || undefined,
                }))
              }
            >
              <option value="">すべて</option>
              <option value="active">開催中</option>
              <option value="scheduled">開催予定</option>
            </select>
          </div>
          <div>
            <label
              htmlFor={typeFilterId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              タイプ
            </label>
            <select
              id={typeFilterId}
              className="border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
              value={filter.type || ""}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  type: (e.target.value as ProblemType) || undefined,
                }))
              }
            >
              <option value="">すべて</option>
              <option value="gameday">GameDay</option>
              <option value="jam">JAM</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : error ? (
          <Card className="p-8 text-center">
            <p className="text-red-600 mb-4">{error}</p>
            <Button onClick={() => window.location.reload()}>再読み込み</Button>
          </Card>
        ) : events.length === 0 ? (
          <Card className="text-center py-12">
            <div className="text-4xl mb-4">📭</div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              イベントが見つかりません
            </h2>
            <p className="text-gray-600">
              条件に一致するイベントがありません。
            </p>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => {
              const timeUntil =
                event.status === "scheduled"
                  ? getTimeUntilStart(event.startTime)
                  : null;

              return (
                <Link key={event.id} href={`/events/${event.id}`}>
                  <Card hoverable className="h-full">
                    <CardContent className="space-y-4">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-2">
                          <ProblemTypeBadge type={event.type} />
                          <EventStatusBadge status={event.status} />
                        </div>
                        {event.isRegistered && (
                          <Badge variant="success" size="sm">
                            登録済み
                          </Badge>
                        )}
                      </div>

                      <div>
                        <h3 className="font-semibold text-lg text-gray-900">
                          {event.name}
                        </h3>
                        {timeUntil && (
                          <p className="text-blue-600 font-medium text-sm mt-1">
                            {timeUntil}
                          </p>
                        )}
                      </div>

                      <div className="text-sm text-gray-600 space-y-1">
                        <p>
                          <span className="font-medium">開始:</span>{" "}
                          {formatDate(event.startTime)}
                        </p>
                        <p>
                          <span className="font-medium">終了:</span>{" "}
                          {formatDate(event.endTime)}
                        </p>
                      </div>

                      <div className="flex items-center justify-between text-sm text-gray-500">
                        <span>問題数: {event.problemCount}</span>
                        <span>参加者: {event.participantCount}</span>
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="px-2 py-1 bg-gray-100 rounded text-gray-700">
                          {event.cloudProvider.toUpperCase()}
                        </span>
                        <span className="text-gray-500">
                          {event.participantType === "team"
                            ? "チーム参加"
                            : "個人参加"}
                        </span>
                      </div>

                      <Button
                        variant={
                          event.status === "active" ? "primary" : "outline"
                        }
                        fullWidth
                      >
                        {event.status === "active"
                          ? event.isRegistered
                            ? "バトルに参加"
                            : "今すぐ参加"
                          : event.isRegistered
                            ? "詳細を見る"
                            : "登録する"}
                      </Button>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
