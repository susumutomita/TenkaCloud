/**
 * Challenge Detail Page
 *
 * チャレンジ（問題）詳細ページ - GameDay / JAM 共通
 * Cloudscape Design System を使用したリッチな問題表示
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import CloudscapeButton from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import CloudscapeHeader from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import CloudscapeLink from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import '@cloudscape-design/global-styles/index.css';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '../../../../../components/layout';
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

function getDifficultyColor(
  difficulty: string,
): 'blue' | 'green' | 'red' | 'grey' {
  switch (difficulty) {
    case 'easy':
      return 'green';
    case 'medium':
      return 'blue';
    case 'hard':
      return 'red';
    case 'expert':
      return 'red';
    default:
      return 'grey';
  }
}

function getDifficultyLabel(difficulty: string): string {
  switch (difficulty) {
    case 'easy':
      return '初級';
    case 'medium':
      return '中級';
    case 'hard':
      return '上級';
    case 'expert':
      return 'エキスパート';
    default:
      return difficulty;
  }
}

function getResourceTypeLabel(type: string): string {
  switch (type) {
    case 'video':
      return '動画';
    case 'document':
      return 'ドキュメント';
    case 'link':
      return 'リンク';
    default:
      return type;
  }
}

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
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '256px',
          }}
        >
          <Spinner size="large" />
        </div>
      </div>
    );
  }

  if (error || !challenge) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px' }}>
          <Container>
            <Box textAlign="center" padding="xl">
              <SpaceBetween size="m">
                <StatusIndicator type="error">
                  {error || 'チャレンジが見つかりません'}
                </StatusIndicator>
                <Link href={`/events/${eventId}`}>
                  <CloudscapeButton>イベントに戻る</CloudscapeButton>
                </Link>
              </SpaceBetween>
            </Box>
          </Container>
        </main>
      </div>
    );
  }

  const jamChallenge = isJam ? (challenge as JamChallenge) : null;

  const submissionStatusType = latestSubmission
    ? latestSubmission.status === 'completed'
      ? 'success'
      : latestSubmission.status === 'failed'
        ? 'error'
        : latestSubmission.status === 'scoring'
          ? 'in-progress'
          : 'pending'
    : undefined;

  const submissionStatusLabel = latestSubmission
    ? latestSubmission.status === 'completed'
      ? '完了'
      : latestSubmission.status === 'failed'
        ? '失敗'
        : latestSubmission.status === 'scoring'
          ? '採点中'
          : '待機中'
    : undefined;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <main style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px' }}>
        <SpaceBetween size="l">
          {/* Breadcrumb */}
          <Link href={`/events/${eventId}`}>
            <CloudscapeLink>&larr; イベントに戻る</CloudscapeLink>
          </Link>

          {/* Page Header with Badges */}
          <CloudscapeHeader
            variant="h1"
            info={
              <SpaceBetween direction="horizontal" size="xs">
                <Badge color={getDifficultyColor(challenge.difficulty)}>
                  {getDifficultyLabel(challenge.difficulty)}
                </Badge>
                {challenge.estimatedTimeMinutes && (
                  <Badge color="blue">{challenge.estimatedTimeMinutes}分</Badge>
                )}
                {challenge.isCompleted && <Badge color="green">完了</Badge>}
              </SpaceBetween>
            }
            description={challenge.overview}
          >
            {challenge.title}
          </CloudscapeHeader>

          <ColumnLayout columns={3} variant="default">
            {/* Main Content — spans 2 columns */}
            <div style={{ gridColumn: 'span 2' }}>
              <SpaceBetween size="l">
                {/* Metadata */}
                <Container
                  header={
                    <CloudscapeHeader variant="h2">基本情報</CloudscapeHeader>
                  }
                >
                  <KeyValuePairs
                    columns={3}
                    items={[
                      {
                        label: 'タイプ',
                        value: challenge.type === 'gameday' ? 'GameDay' : 'JAM',
                      },
                      {
                        label: 'カテゴリ',
                        value: challenge.category,
                      },
                      {
                        label: '難易度',
                        value: (
                          <Badge
                            color={getDifficultyColor(challenge.difficulty)}
                          >
                            {getDifficultyLabel(challenge.difficulty)}
                          </Badge>
                        ),
                      },
                      {
                        label: '最大スコア',
                        value: `${challenge.maxScore} pts`,
                      },
                      {
                        label: '現在のスコア',
                        value: `${challenge.myScore ?? 0} pts`,
                      },
                      ...(challenge.estimatedTimeMinutes
                        ? [
                            {
                              label: '推定所要時間',
                              value: `${challenge.estimatedTimeMinutes}分`,
                            },
                          ]
                        : []),
                    ]}
                  />
                </Container>

                {/* Description */}
                <Container
                  header={
                    <CloudscapeHeader variant="h2">概要</CloudscapeHeader>
                  }
                >
                  <Box variant="p">{challenge.description}</Box>
                </Container>

                {/* Objectives */}
                <Container
                  header={
                    <CloudscapeHeader variant="h2">目標</CloudscapeHeader>
                  }
                >
                  <SpaceBetween size="s">
                    {challenge.objectives.map((obj, i) => (
                      <Box key={i} variant="p">
                        <StatusIndicator type="info">
                          {i + 1}. {obj}
                        </StatusIndicator>
                      </Box>
                    ))}
                  </SpaceBetween>
                </Container>

                {/* Instructions */}
                {challenge.instructions.length > 0 && (
                  <Container
                    header={
                      <CloudscapeHeader variant="h2">手順</CloudscapeHeader>
                    }
                  >
                    <SpaceBetween size="s">
                      {challenge.instructions.map((inst, i) => (
                        <Box key={i} variant="p">
                          <Box variant="span" fontWeight="bold">
                            ステップ {i + 1}:
                          </Box>{' '}
                          {inst}
                        </Box>
                      ))}
                    </SpaceBetween>
                  </Container>
                )}

                {/* JAM: Clues Section */}
                {isJam && jamChallenge && (
                  <Container
                    header={
                      <CloudscapeHeader
                        variant="h2"
                        counter={`(${jamChallenge.clues.length})`}
                      >
                        クルー（ヒント）
                      </CloudscapeHeader>
                    }
                  >
                    <SpaceBetween size="m">
                      {jamChallenge.clues.map((clue: JamClue) => (
                        <ExpandableSection
                          key={clue.id}
                          variant="container"
                          headerText={`クルー #${clue.order}: ${clue.title}`}
                          headerInfo={
                            clue.isRevealed ? (
                              <Badge color="blue">公開済み</Badge>
                            ) : (
                              <Badge color="grey">未公開</Badge>
                            )
                          }
                          headerDescription={`使用すると ${clue.costPoints} ポイント減点`}
                        >
                          {clue.isRevealed ? (
                            <SpaceBetween size="s">
                              <Box variant="p">{clue.content}</Box>
                              <Box color="text-status-error" fontSize="body-s">
                                -{clue.costPoints} pts
                              </Box>
                            </SpaceBetween>
                          ) : (
                            <Box textAlign="center" padding="m">
                              <SpaceBetween size="s" alignItems="center">
                                <Box variant="p">
                                  このクルーを公開すると{clue.costPoints}
                                  ポイント減点されます
                                </Box>
                                <CloudscapeButton
                                  onClick={() => handleRevealClue(clue.id)}
                                >
                                  公開する
                                </CloudscapeButton>
                              </SpaceBetween>
                            </Box>
                          )}
                        </ExpandableSection>
                      ))}
                    </SpaceBetween>
                  </Container>
                )}

                {/* GameDay: Hints Section */}
                {!isJam && challenge.hints.length > 0 && (
                  <Container
                    header={
                      <CloudscapeHeader
                        variant="h2"
                        counter={`(${challenge.hints.length})`}
                      >
                        ヒント
                      </CloudscapeHeader>
                    }
                  >
                    <SpaceBetween size="m">
                      {challenge.hints.map((hint: ChallengeHint, index) => (
                        <ExpandableSection
                          key={hint.id}
                          variant="container"
                          headerText={`ヒント ${index + 1}`}
                          headerInfo={
                            hint.isRevealed ? (
                              <Badge color="blue">公開済み</Badge>
                            ) : (
                              <Badge color="grey">未公開</Badge>
                            )
                          }
                          headerDescription={`使用すると ${hint.costPoints} ポイント減点`}
                        >
                          {hint.isRevealed ? (
                            <SpaceBetween size="s">
                              <Box variant="p">{hint.content}</Box>
                              <Box color="text-status-error" fontSize="body-s">
                                -{hint.costPoints} pts
                              </Box>
                            </SpaceBetween>
                          ) : (
                            <Box textAlign="center" padding="m">
                              <SpaceBetween size="s" alignItems="center">
                                <Box variant="p">
                                  このヒントを公開すると{hint.costPoints}
                                  ポイント減点されます
                                </Box>
                                <CloudscapeButton
                                  onClick={() => handleRevealHint(hint.id)}
                                >
                                  公開する
                                </CloudscapeButton>
                              </SpaceBetween>
                            </Box>
                          )}
                        </ExpandableSection>
                      ))}
                    </SpaceBetween>
                  </Container>
                )}

                {/* Resources */}
                {challenge.resources.length > 0 && (
                  <Container
                    header={
                      <CloudscapeHeader
                        variant="h2"
                        counter={`(${challenge.resources.length})`}
                      >
                        リソース
                      </CloudscapeHeader>
                    }
                  >
                    <SpaceBetween size="s">
                      {challenge.resources.map((resource, i) => (
                        <Box key={i}>
                          <SpaceBetween direction="horizontal" size="xs">
                            <Badge color="blue">
                              {getResourceTypeLabel(resource.type)}
                            </Badge>
                            <CloudscapeLink
                              href={resource.url}
                              external
                              externalIconAriaLabel="外部リンク"
                            >
                              {resource.name}
                            </CloudscapeLink>
                          </SpaceBetween>
                        </Box>
                      ))}
                    </SpaceBetween>
                  </Container>
                )}

                {/* Scoring Criteria Table */}
                <Table
                  header={
                    <CloudscapeHeader
                      variant="h2"
                      counter={`(${challenge.scoringCriteria.length})`}
                    >
                      採点基準
                    </CloudscapeHeader>
                  }
                  columnDefinitions={[
                    {
                      id: 'name',
                      header: '基準名',
                      cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
                      width: 200,
                    },
                    {
                      id: 'description',
                      header: '説明',
                      cell: (item) => item.description,
                    },
                    {
                      id: 'points',
                      header: 'ポイント',
                      cell: (item) => (
                        <Box>
                          {item.currentPoints ?? 0} / {item.maxPoints} pts
                        </Box>
                      ),
                      width: 140,
                    },
                    {
                      id: 'status',
                      header: 'ステータス',
                      cell: (item) =>
                        item.isPassed !== undefined ? (
                          item.isPassed ? (
                            <StatusIndicator type="success">
                              達成
                            </StatusIndicator>
                          ) : (
                            <StatusIndicator type="stopped">
                              未達成
                            </StatusIndicator>
                          )
                        ) : (
                          <StatusIndicator type="pending">
                            未判定
                          </StatusIndicator>
                        ),
                      width: 120,
                    },
                  ]}
                  items={challenge.scoringCriteria}
                  variant="container"
                  empty={
                    <Box textAlign="center" padding="l">
                      採点基準がありません
                    </Box>
                  }
                />
              </SpaceBetween>
            </div>

            {/* Sidebar */}
            <div>
              <SpaceBetween size="l">
                {/* Score Card */}
                <Container
                  header={
                    <CloudscapeHeader variant="h2">スコア</CloudscapeHeader>
                  }
                >
                  <SpaceBetween size="m">
                    <Box textAlign="center">
                      <Box
                        variant="h1"
                        fontSize="display-l"
                        color="text-status-info"
                      >
                        {challenge.myScore ?? 0}
                      </Box>
                      <Box variant="p" color="text-body-secondary">
                        / {challenge.maxScore} pts
                      </Box>
                    </Box>

                    {/* Progress bar */}
                    <div
                      style={{
                        width: '100%',
                        height: '8px',
                        backgroundColor: '#e9ebed',
                        borderRadius: '4px',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, ((challenge.myScore ?? 0) / challenge.maxScore) * 100)}%`,
                          height: '100%',
                          backgroundColor: '#0972d3',
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>

                    {/* GameDay: Request Scoring */}
                    {!isJam && (
                      <CloudscapeButton
                        onClick={handleRequestScoring}
                        loading={scoring}
                        fullWidth
                        variant="primary"
                        disabled={
                          scoring || latestSubmission?.status === 'scoring'
                        }
                      >
                        {latestSubmission?.status === 'scoring'
                          ? '採点中...'
                          : '採点をリクエスト'}
                      </CloudscapeButton>
                    )}

                    {/* JAM: Submit Answer */}
                    {isJam && (
                      <SpaceBetween size="s">
                        <Textarea
                          value={answer}
                          onChange={({ detail }) => setAnswer(detail.value)}
                          placeholder="回答を入力..."
                          rows={3}
                        />
                        <CloudscapeButton
                          onClick={handleSubmitAnswer}
                          loading={submitting}
                          fullWidth
                          variant="primary"
                          disabled={!answer.trim() || submitting}
                        >
                          回答を提出
                        </CloudscapeButton>
                      </SpaceBetween>
                    )}

                    {/* Latest Submission Result */}
                    {latestSubmission &&
                      submissionStatusType &&
                      submissionStatusLabel && (
                        <Container
                          header={
                            <CloudscapeHeader variant="h3">
                              最新の提出
                            </CloudscapeHeader>
                          }
                        >
                          <SpaceBetween size="s">
                            <StatusIndicator type={submissionStatusType}>
                              {submissionStatusLabel}
                            </StatusIndicator>
                            {latestSubmission.score !== undefined && (
                              <Box>
                                {latestSubmission.score} /{' '}
                                {latestSubmission.maxScore} pts
                              </Box>
                            )}
                            {/* JAM specific: show if correct */}
                            {isJam &&
                              'isCorrect' in latestSubmission &&
                              latestSubmission.isCorrect !== undefined && (
                                <div>
                                  {latestSubmission.isCorrect ? (
                                    <StatusIndicator type="success">
                                      正解
                                    </StatusIndicator>
                                  ) : (
                                    <StatusIndicator type="error">
                                      不正解
                                    </StatusIndicator>
                                  )}
                                </div>
                              )}
                          </SpaceBetween>
                        </Container>
                      )}
                  </SpaceBetween>
                </Container>

                {/* AWS Credentials (GameDay only) */}
                {!isJam && credentials && (
                  <Container
                    header={
                      <CloudscapeHeader variant="h2">
                        AWS クレデンシャル
                      </CloudscapeHeader>
                    }
                  >
                    <SpaceBetween size="m">
                      <KeyValuePairs
                        columns={1}
                        items={[
                          {
                            label: 'アカウント ID',
                            value: (
                              <Box variant="code">{challenge.awsAccountId}</Box>
                            ),
                          },
                          {
                            label: 'リージョン',
                            value: (
                              <Box variant="code">{credentials.region}</Box>
                            ),
                          },
                          {
                            label: '有効期限',
                            value: (
                              <Box variant="code">
                                {new Date(credentials.expiresAt).toLocaleString(
                                  'ja-JP',
                                )}
                              </Box>
                            ),
                          },
                        ]}
                      />
                      <a
                        href={challenge.awsConsoleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <CloudscapeButton fullWidth iconName="external">
                          AWS コンソールを開く
                        </CloudscapeButton>
                      </a>
                    </SpaceBetween>
                  </Container>
                )}
              </SpaceBetween>
            </div>
          </ColumnLayout>
        </SpaceBetween>
      </main>
    </div>
  );
}
