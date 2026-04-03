/**
 * Challenge Detail Page
 *
 * チャレンジ（問題）詳細ページ - GameDay / JAM 共通
 */

'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AwsConsoleButton } from '@/components/gameday';
import { Header } from '../../../../../components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  DifficultyBadge,
  ProblemTypeBadge,
  ScoreProgress,
} from '../../../../../components/ui';
import {
  getAWSCredentials,
  getChallengeDetails,
  getJamChallengeDetails,
  getLatestSubmission,
  requestGameDayScoring,
  revealClue,
  revealHint,
  submitJamAnswer,
} from '../../../../../lib/api/challenges';
import type {
  AWSCredentials,
  ChallengeDetails,
  ChallengeHint,
  JamChallenge,
  JamClue,
  JamSubmission,
  Submission,
} from '../../../../../lib/api/types';

export default function ChallengeDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;
  const challengeId = params.challengeId as string;

  const [challenge, setChallenge] = useState<
    ChallengeDetails | JamChallenge | null
  >(null);
  const [credentials, setCredentials] = useState<AWSCredentials | null>(null);
  const [latestSubmission, setLatestSubmission] = useState<
    Submission | JamSubmission | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // JAM specific state
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isJam = challenge?.type === 'jam';

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);

        // First try JAM endpoint, fallback to GameDay
        let challengeData: ChallengeDetails | JamChallenge | null =
          await getJamChallengeDetails(eventId, challengeId);
        if (!challengeData) {
          challengeData = await getChallengeDetails(eventId, challengeId);
        }

        if (!challengeData) {
          router.push(`/events/${eventId}`);
          return;
        }

        setChallenge(challengeData);

        // Fetch credentials for GameDay
        if (challengeData.type === 'gameday') {
          const creds = await getAWSCredentials(eventId, challengeId);
          setCredentials(creds);
        }

        // Fetch latest submission
        const submission = await getLatestSubmission(eventId, challengeId);
        setLatestSubmission(submission);
      } catch (err) {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [eventId, challengeId, router]);

  const handleRevealHint = async (hintId: string) => {
    if (!challenge) return;

    try {
      const revealedHint = await revealHint(eventId, challengeId, hintId);
      setChallenge({
        ...challenge,
        hints: challenge.hints.map((h) => (h.id === hintId ? revealedHint : h)),
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'ヒントの公開に失敗しました',
      );
    }
  };

  const handleRevealClue = async (clueId: string) => {
    if (!challenge || !isJam) return;

    try {
      const revealedClue = await revealClue(eventId, challengeId, clueId);
      const jamChallenge = challenge as JamChallenge;
      setChallenge({
        ...jamChallenge,
        clues: jamChallenge.clues.map((c) =>
          c.id === clueId ? revealedClue : c,
        ),
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'クルーの公開に失敗しました',
      );
    }
  };

  const handleRequestScoring = async () => {
    try {
      setScoring(true);
      const result = await requestGameDayScoring(eventId, challengeId);
      // Show submission ID and poll for results
      setLatestSubmission({
        id: result.submissionId,
        problemId: challengeId,
        eventId,
        submittedAt: new Date().toISOString(),
        status: 'pending',
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '採点リクエストに失敗しました',
      );
    } finally {
      setScoring(false);
    }
  };

  const handleSubmitAnswer = async () => {
    if (!answer.trim()) return;

    try {
      setSubmitting(true);
      const submission = await submitJamAnswer(eventId, challengeId, {
        answer,
      });
      setLatestSubmission(submission);
      if (submission.isCorrect) {
        setAnswer('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '回答の提出に失敗しました');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error || !challenge) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-8 text-center">
            <p className="text-red-600 mb-4">
              {error || 'チャレンジが見つかりません'}
            </p>
            <Link href={`/events/${eventId}`}>
              <Button>イベントに戻る</Button>
            </Link>
          </Card>
        </main>
      </div>
    );
  }

  const jamChallenge = isJam ? (challenge as JamChallenge) : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6">
          <Link
            href={`/events/${eventId}`}
            className="text-blue-600 hover:text-blue-700"
          >
            ← イベントに戻る
          </Link>
        </nav>

        {/* Challenge Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ProblemTypeBadge type={challenge.type} />
            <DifficultyBadge difficulty={challenge.difficulty} />
            {challenge.isCompleted && <Badge variant="success">✓ 完了</Badge>}
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {challenge.title}
          </h1>
          <p className="text-gray-600">{challenge.overview}</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Description */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">問題詳細</h2>
              </CardHeader>
              <CardContent>
                <div className="prose max-w-none">
                  <p>{challenge.description}</p>
                </div>

                {/* Objectives */}
                <div className="mt-6">
                  <h3 className="font-semibold mb-3">目標</h3>
                  <ul className="space-y-2">
                    {challenge.objectives.map((obj, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-blue-600">●</span>
                        <span>{obj}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Instructions */}
                {challenge.instructions.length > 0 && (
                  <div className="mt-6">
                    <h3 className="font-semibold mb-3">手順</h3>
                    <ol className="list-decimal list-inside space-y-2 text-gray-700">
                      {challenge.instructions.map((inst, i) => (
                        <li key={i}>{inst}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* JAM: Clues Section */}
            {isJam && jamChallenge && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">クルー（ヒント）</h2>
                </CardHeader>
                <CardContent className="space-y-4">
                  {jamChallenge.clues.map((clue: JamClue) => (
                    <ClueCard
                      key={clue.id}
                      clue={clue}
                      onReveal={() => handleRevealClue(clue.id)}
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* GameDay: Hints Section */}
            {!isJam && challenge.hints.length > 0 && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">ヒント</h2>
                </CardHeader>
                <CardContent className="space-y-4">
                  {challenge.hints.map((hint: ChallengeHint) => (
                    <HintCard
                      key={hint.id}
                      hint={hint}
                      onReveal={() => handleRevealHint(hint.id)}
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Scoring Criteria */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">採点基準</h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {challenge.scoringCriteria.map((criterion, i) => (
                    <div key={i} className="p-4 bg-gray-50 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium">{criterion.name}</h4>
                        <span className="font-semibold text-blue-600">
                          {criterion.currentPoints ?? 0} / {criterion.maxPoints}{' '}
                          pts
                        </span>
                      </div>
                      <p className="text-sm text-gray-600">
                        {criterion.description}
                      </p>
                      {criterion.isPassed !== undefined && (
                        <div className="mt-2">
                          {criterion.isPassed ? (
                            <Badge variant="success" size="sm">
                              ✓ 達成
                            </Badge>
                          ) : (
                            <Badge variant="default" size="sm">
                              未達成
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Resources */}
            {challenge.resources.length > 0 && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">参考資料</h2>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {challenge.resources.map((resource, i) => (
                      <li key={i}>
                        <a
                          href={resource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-700 hover:underline flex items-center gap-2"
                        >
                          {resource.type === 'video' && '🎬'}
                          {resource.type === 'document' && '📄'}
                          {resource.type === 'link' && '🔗'}
                          {resource.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Score Card */}
            <Card>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-4xl font-bold text-blue-600">
                    {challenge.myScore ?? 0}
                  </div>
                  <div className="text-gray-500">
                    / {challenge.maxScore} pts
                  </div>
                </div>

                <ScoreProgress
                  score={challenge.myScore ?? 0}
                  maxScore={challenge.maxScore}
                />

                {/* GameDay: Request Scoring */}
                {!isJam && (
                  <Button
                    onClick={handleRequestScoring}
                    loading={scoring}
                    fullWidth
                    size="lg"
                    disabled={scoring || latestSubmission?.status === 'scoring'}
                  >
                    {latestSubmission?.status === 'scoring'
                      ? '採点中...'
                      : '採点をリクエスト'}
                  </Button>
                )}

                {/* JAM: Submit Answer */}
                {isJam && (
                  <div className="space-y-3">
                    <textarea
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="回答を入力..."
                      className="w-full p-3 border rounded-lg focus:ring-blue-500 focus:border-blue-500"
                      rows={3}
                    />
                    <Button
                      onClick={handleSubmitAnswer}
                      loading={submitting}
                      fullWidth
                      size="lg"
                      disabled={!answer.trim() || submitting}
                    >
                      回答を提出
                    </Button>
                  </div>
                )}

                {/* Latest Submission Result */}
                {latestSubmission && (
                  <div className="p-3 bg-gray-50 rounded-lg">
                    <div className="text-sm text-gray-500 mb-1">最新の提出</div>
                    <div className="flex items-center justify-between">
                      <Badge
                        variant={
                          latestSubmission.status === 'completed'
                            ? 'success'
                            : latestSubmission.status === 'failed'
                              ? 'danger'
                              : 'default'
                        }
                      >
                        {latestSubmission.status === 'completed' && '完了'}
                        {latestSubmission.status === 'scoring' && '採点中'}
                        {latestSubmission.status === 'pending' && '待機中'}
                        {latestSubmission.status === 'failed' && '失敗'}
                      </Badge>
                      {latestSubmission.score !== undefined && (
                        <span className="font-semibold">
                          {latestSubmission.score} / {latestSubmission.maxScore}
                        </span>
                      )}
                    </div>
                    {/* JAM specific: show if correct */}
                    {isJam &&
                      'isCorrect' in latestSubmission &&
                      latestSubmission.isCorrect !== undefined && (
                        <div className="mt-2">
                          {latestSubmission.isCorrect ? (
                            <span className="text-green-600 font-medium">
                              ✓ 正解！
                            </span>
                          ) : (
                            <span className="text-red-600 font-medium">
                              ✗ 不正解
                            </span>
                          )}
                        </div>
                      )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* AWS Credentials (GameDay only) */}
            {!isJam && credentials && (
              <Card>
                <CardHeader>
                  <h2 className="font-semibold">AWS クレデンシャル</h2>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <div className="text-xs text-gray-500">アカウント ID</div>
                    <code className="text-sm">{challenge.awsAccountId}</code>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">リージョン</div>
                    <code className="text-sm">{credentials.region}</code>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">有効期限</div>
                    <code className="text-sm">
                      {new Date(credentials.expiresAt).toLocaleString('ja-JP')}
                    </code>
                  </div>
                  <AwsConsoleButton
                    eventId={eventId}
                    label="AWS Console を開く"
                    variant="primary"
                    fullWidth
                  />
                </CardContent>
              </Card>
            )}

            {/* Estimated Time */}
            {challenge.estimatedTimeMinutes && (
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">推定所要時間</span>
                    <span className="font-medium">
                      {challenge.estimatedTimeMinutes}分
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// Hint Card Component (GameDay)
function HintCard({
  hint,
  onReveal,
}: {
  hint: ChallengeHint;
  onReveal: () => void;
}) {
  return (
    <div className="p-4 border rounded-lg">
      {hint.isRevealed ? (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="info" size="sm">
              公開済み
            </Badge>
            <span className="text-sm text-red-600">-{hint.costPoints} pts</span>
          </div>
          <p className="text-gray-700">{hint.content}</p>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">ヒントを表示</p>
            <p className="text-sm text-red-600">
              使用すると {hint.costPoints} ポイント減点
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onReveal}>
            公開する
          </Button>
        </div>
      )}
    </div>
  );
}

// Clue Card Component (JAM)
function ClueCard({ clue, onReveal }: { clue: JamClue; onReveal: () => void }) {
  return (
    <div className="p-4 border rounded-lg">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-medium">クルー #{clue.order}</span>
        {clue.isRevealed && (
          <Badge variant="info" size="sm">
            公開済み
          </Badge>
        )}
      </div>

      {clue.isRevealed ? (
        <div>
          <h4 className="font-medium text-gray-900">{clue.title}</h4>
          <p className="text-gray-700 mt-1">{clue.content}</p>
          <p className="text-sm text-red-600 mt-2">-{clue.costPoints} pts</p>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-600">{clue.title}</p>
            <p className="text-sm text-red-600">
              使用すると {clue.costPoints} ポイント減点
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onReveal}>
            公開する
          </Button>
        </div>
      )}
    </div>
  );
}
