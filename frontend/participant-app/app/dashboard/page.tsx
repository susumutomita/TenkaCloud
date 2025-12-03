/**
 * Dashboard Page
 *
 * 参加者ダッシュボード
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Header } from "../../components/layout";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EventStatusBadge,
  ProblemTypeBadge,
} from "../../components/ui";
import { getAvailableEvents, getMyEvents } from "../../lib/api/events";
import type { ParticipantEvent } from "../../lib/api/types";

export default function DashboardPage() {
  const [myEvents, setMyEvents] = useState<ParticipantEvent[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [myEventsRes, upcomingRes] = await Promise.all([
          getMyEvents(),
          getAvailableEvents({ status: ["scheduled", "active"], limit: 5 }),
        ]);
        setMyEvents(myEventsRes.events);
        setUpcomingEvents(
          upcomingRes.events.filter(
            (e) => !myEventsRes.events.some((me) => me.id === e.id),
          ),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("ja-JP", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const activeEvents = myEvents.filter((e) => e.status === "active");
  const scheduledEvents = myEvents.filter((e) => e.status === "scheduled");

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-primary-500/20 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] bg-accent-500/20 rounded-full blur-[100px]" />
      </div>

      <Header userName="参加者" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-white mb-8">ダッシュボード</h1>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : error ? (
          <Card className="p-8 text-center">
            <p className="text-red-600 mb-4">{error}</p>
            <Button onClick={() => window.location.reload()}>再読み込み</Button>
          </Card>
        ) : (
          <div className="space-y-8">
            {/* Active Events */}
            {activeEvents.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold text-white mb-4 flex items-center">
                  <span className="w-3 h-3 bg-emerald-500 rounded-full mr-2 animate-pulse" />
                  開催中のイベント
                </h2>
                <div className="grid gap-4 md:grid-cols-2">
                  {activeEvents.map((event) => (
                    <Link key={event.id} href={`/events/${event.id}`}>
                      <Card hoverable className="h-full">
                        <CardHeader>
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-semibold text-lg text-white">
                                {event.name}
                              </h3>
                              <div className="flex items-center gap-2 mt-1">
                                <ProblemTypeBadge type={event.type} />
                                <EventStatusBadge status={event.status} />
                              </div>
                            </div>
                            {event.myRank && (
                              <div className="text-right">
                                <div className="text-2xl font-bold text-primary-400">
                                  #{event.myRank}
                                </div>
                                <div className="text-sm text-white/50">
                                  {event.myScore} pts
                                </div>
                              </div>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="text-sm text-white/60 space-y-1">
                            <p>終了: {formatDate(event.endTime)}</p>
                            <p>
                              問題数: {event.problemCount} | 参加者:{" "}
                              {event.participantCount}
                            </p>
                          </div>
                          <Button className="mt-4" fullWidth>
                            バトルに参加
                          </Button>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* Scheduled Events */}
            {scheduledEvents.length > 0 && (
              <section>
                <h2 className="text-xl font-semibold text-white mb-4">
                  登録済みのイベント
                </h2>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {scheduledEvents.map((event) => (
                    <Link key={event.id} href={`/events/${event.id}`}>
                      <Card hoverable className="h-full">
                        <CardContent>
                          <div className="flex items-start justify-between mb-2">
                            <ProblemTypeBadge type={event.type} />
                            <EventStatusBadge status={event.status} />
                          </div>
                          <h3 className="font-semibold text-white">
                            {event.name}
                          </h3>
                          <p className="text-sm text-white/60 mt-2">
                            開始: {formatDate(event.startTime)}
                          </p>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* Upcoming Events */}
            {upcomingEvents.length > 0 && (
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-white">
                    開催予定のイベント
                  </h2>
                  <Link
                    href="/events"
                    className="text-primary-400 hover:text-primary-300 font-medium"
                  >
                    すべて見る →
                  </Link>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {upcomingEvents.map((event) => (
                    <Link key={event.id} href={`/events/${event.id}`}>
                      <Card hoverable className="h-full">
                        <CardContent>
                          <div className="flex items-start justify-between mb-2">
                            <ProblemTypeBadge type={event.type} />
                            <span className="text-sm text-white/50">
                              {event.participantCount} 人登録
                            </span>
                          </div>
                          <h3 className="font-semibold text-white">
                            {event.name}
                          </h3>
                          <p className="text-sm text-white/60 mt-2">
                            {formatDate(event.startTime)} 開始
                          </p>
                          <Button variant="outline" className="mt-4" fullWidth>
                            詳細を見る
                          </Button>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* Empty State */}
            {myEvents.length === 0 && upcomingEvents.length === 0 && (
              <Card className="text-center py-12">
                <div className="text-4xl mb-4">⚔️</div>
                <h2 className="text-xl font-semibold text-white mb-2">
                  イベントがありません
                </h2>
                <p className="text-white/60 mb-6">
                  現在参加可能なイベントはありません。
                  <br />
                  新しいイベントが公開されるまでお待ちください。
                </p>
                <Link href="/events">
                  <Button>イベント一覧を見る</Button>
                </Link>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
