/**
 * Admin Marketplace Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題マーケットプレイス - 問題の検索と選択
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import CloudscapeBadge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import CloudscapeButton from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Flashbar from '@cloudscape-design/components/flashbar';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Modal from '@cloudscape-design/components/modal';
import CloudscapeSelect from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import {
  ErrorState,
  getErrorMessage,
  getErrorType,
  Skeleton,
} from '@/components/ui';
import { getProblem, getProblems } from '@/lib/api/admin-problems';
import type { AdminProblem } from '@/lib/api/admin-types';
import type {
  DifficultyLevel,
  ParticipantEvent,
  ProblemCategory,
} from '@/lib/api/types';

interface MarketplaceProblem {
  id: string;
  title: string;
  description: string;
  type: AdminProblem['type'];
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  cloudProvider: string;
  estimatedTimeMinutes: number;
  authorName: string;
  rating: number;
  usageCount: number;
  tags: string[];
  createdAt: string;
}

function toMarketplaceProblem(p: AdminProblem): MarketplaceProblem {
  return {
    id: p.id,
    title: p.title,
    description: p.description.overview,
    type: p.type,
    category: p.category,
    difficulty: p.difficulty,
    cloudProvider: p.deployment.providers[0] ?? 'aws',
    estimatedTimeMinutes: p.description.estimatedTime ?? 0,
    authorName: p.metadata.author,
    rating: 0,
    usageCount: 0,
    tags: p.metadata.tags,
    createdAt: p.metadata.createdAt ?? p.createdAt ?? '',
  };
}

interface EventOption {
  id: string;
  name: string;
}

interface FlashMessage {
  id: string;
  type: 'success' | 'error';
  content: string;
}

export default function AdminMarketplacePage() {
  const [problems, setProblems] = useState<MarketplaceProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('');
  const [selectedCloudProvider, setSelectedCloudProvider] =
    useState<string>('');

  const [previewProblem, setPreviewProblem] = useState<AdminProblem | null>(
    null,
  );
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [addToEventVisible, setAddToEventVisible] = useState(false);
  const [addToEventProblemId, setAddToEventProblemId] = useState<string | null>(
    null,
  );
  const [events, setEvents] = useState<EventOption[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [addingToEvent, setAddingToEvent] = useState(false);
  const [flashMessages, setFlashMessages] = useState<FlashMessage[]>([]);

  const fetchProblems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getProblems();
      setProblems(data.problems.map(toMarketplaceProblem));
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('問題の取得に失敗しました'),
      );
      setProblems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProblems();
  }, [fetchProblems]);

  const handlePreview = useCallback(async (problemId: string) => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewVisible(true);
    setPreviewProblem(null);
    try {
      const problem = await getProblem(problemId);
      setPreviewProblem(problem);
    } catch {
      setPreviewError(
        '\u554f\u984c\u8a73\u7d30\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
      );
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const handleClosePreview = useCallback(() => {
    setPreviewVisible(false);
    setPreviewProblem(null);
    setPreviewError(null);
  }, []);

  const handleAddToEvent = useCallback(async (problemId: string) => {
    setAddToEventProblemId(problemId);
    setAddToEventVisible(true);
    setSelectedEventId(null);
    setEventsLoading(true);
    setEventsError(null);
    try {
      const response = await fetch('/api/admin/events?pageSize=100');
      if (!response.ok) throw new Error('Failed');
      const data = await response.json();
      setEvents(
        (data.events ?? []).map((e: ParticipantEvent) => ({
          id: e.id,
          name: e.name,
        })),
      );
    } catch {
      setEventsError(
        '\u30a4\u30d9\u30f3\u30c8\u4e00\u89a7\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
      );
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const handleCloseAddToEvent = useCallback(() => {
    setAddToEventVisible(false);
    setAddToEventProblemId(null);
    setSelectedEventId(null);
    setEventsError(null);
  }, []);

  const handleConfirmAddToEvent = useCallback(async () => {
    if (!selectedEventId || !addToEventProblemId) return;
    setAddingToEvent(true);
    try {
      const response = await fetch(
        `/api/admin/events/${selectedEventId}/problems`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ problemId: addToEventProblemId }),
        },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ||
            '\u30a4\u30d9\u30f3\u30c8\u3078\u306e\u8ffd\u52a0\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
        );
      }
      setFlashMessages((prev) => [
        ...prev,
        {
          id: `success-${Date.now()}`,
          type: 'success' as const,
          content:
            '\u554f\u984c\u3092\u30a4\u30d9\u30f3\u30c8\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f',
        },
      ]);
      handleCloseAddToEvent();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : '\u30a4\u30d9\u30f3\u30c8\u3078\u306e\u8ffd\u52a0\u306b\u5931\u6557\u3057\u307e\u3057\u305f';
      setFlashMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, type: 'error' as const, content: message },
      ]);
    } finally {
      setAddingToEvent(false);
    }
  }, [selectedEventId, addToEventProblemId, handleCloseAddToEvent]);

  const getDifficultyLabel = (difficulty: DifficultyLevel): string => {
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
  };

  const getCategoryLabel = (category: ProblemCategory): string => {
    switch (category) {
      case 'architecture':
        return 'アーキテクチャ';
      case 'security':
        return 'セキュリティ';
      case 'cost':
        return 'コスト最適化';
      case 'performance':
        return 'パフォーマンス';
      case 'reliability':
        return '信頼性';
      case 'operations':
        return '運用';
      default:
        return category;
    }
  };

  const getCategoryIcon = (category: ProblemCategory): string => {
    switch (category) {
      case 'architecture':
        return '🏗️';
      case 'security':
        return '🔒';
      case 'cost':
        return '💰';
      case 'performance':
        return '⚡';
      case 'reliability':
        return '🛡️';
      case 'operations':
        return '🔧';
      default:
        return '📦';
    }
  };

  const getCloudProviderLabel = (provider: string): string => {
    switch (provider) {
      case 'aws':
        return 'AWS';
      case 'gcp':
        return 'Google Cloud';
      case 'azure':
        return 'Azure';
      case 'local':
        return 'LocalStack';
      default:
        return provider;
    }
  };

  const filteredProblems = problems.filter((p) => {
    const matchesSearch =
      searchQuery === '' ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tags.some((tag) =>
        tag.toLowerCase().includes(searchQuery.toLowerCase()),
      );
    const matchesCategory =
      selectedCategory === '' || p.category === selectedCategory;
    const matchesDifficulty =
      selectedDifficulty === '' || p.difficulty === selectedDifficulty;
    const matchesCloudProvider =
      selectedCloudProvider === '' || p.cloudProvider === selectedCloudProvider;

    return (
      matchesSearch &&
      matchesCategory &&
      matchesDifficulty &&
      matchesCloudProvider
    );
  });

  const totalProblems = problems.length;
  const avgRating =
    problems.length > 0
      ? (
          problems.reduce((acc, p) => acc + p.rating, 0) / problems.length
        ).toFixed(1)
      : '0.0';

  const categoryOptions: SelectProps.Option[] = [
    { label: 'すべて', value: '' },
    { label: 'アーキテクチャ', value: 'architecture' },
    { label: 'セキュリティ', value: 'security' },
    { label: 'コスト最適化', value: 'cost' },
    { label: 'パフォーマンス', value: 'performance' },
    { label: '信頼性', value: 'reliability' },
    { label: '運用', value: 'operations' },
  ];

  const difficultyOptions: SelectProps.Option[] = [
    { label: 'すべて', value: '' },
    { label: '初級', value: 'easy' },
    { label: '中級', value: 'medium' },
    { label: '上級', value: 'hard' },
    { label: 'エキスパート', value: 'expert' },
  ];

  const providerOptions: SelectProps.Option[] = [
    { label: 'すべて', value: '' },
    { label: 'AWS', value: 'aws' },
    { label: 'Google Cloud', value: 'gcp' },
    { label: 'Azure', value: 'azure' },
    { label: 'LocalStack', value: 'local' },
  ];

  return (
    <SpaceBetween size="l">
      {flashMessages.length > 0 && (
        <Flashbar
          items={flashMessages.map((msg) => ({
            type: msg.type,
            content: msg.content,
            id: msg.id,
            dismissible: true,
            onDismiss: () =>
              setFlashMessages((prev) => prev.filter((m) => m.id !== msg.id)),
          }))}
        />
      )}

      <Header
        variant="h1"
        description="公開済みの問題を検索し、イベントへ追加できます"
      >
        問題マーケットプレイス
      </Header>

      <Container header={<Header variant="h2">検索と絞り込み</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <FormField label="検索">
            <Input
              value={searchQuery}
              onChange={({ detail }) => setSearchQuery(detail.value)}
              placeholder="タイトル、説明、タグで検索..."
              type="search"
              inputMode="search"
            />
          </FormField>
          <FormField label="カテゴリ">
            <CloudscapeSelect
              selectedOption={
                categoryOptions.find(
                  (option) => option.value === selectedCategory,
                ) ?? null
              }
              onChange={({ detail }) =>
                setSelectedCategory(detail.selectedOption.value ?? '')
              }
              options={categoryOptions}
            />
          </FormField>
          <FormField label="難易度">
            <CloudscapeSelect
              selectedOption={
                difficultyOptions.find(
                  (option) => option.value === selectedDifficulty,
                ) ?? null
              }
              onChange={({ detail }) =>
                setSelectedDifficulty(detail.selectedOption.value ?? '')
              }
              options={difficultyOptions}
            />
          </FormField>
          <FormField label="クラウド">
            <CloudscapeSelect
              selectedOption={
                providerOptions.find(
                  (option) => option.value === selectedCloudProvider,
                ) ?? null
              }
              onChange={({ detail }) =>
                setSelectedCloudProvider(detail.selectedOption.value ?? '')
              }
              options={providerOptions}
            />
          </FormField>
        </ColumnLayout>
      </Container>

      {error && (
        <ErrorState
          message={getErrorMessage(error)}
          type={getErrorType(error)}
          onRetry={fetchProblems}
        />
      )}

      {!error && (
        <ColumnLayout columns={3} variant="text-grid">
          <Container>
            <Box variant="awsui-key-label">公開問題数</Box>
            <Box variant="awsui-value-large">
              {loading ? <Skeleton className="h-9 w-12" /> : totalProblems}
            </Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">平均評価</Box>
            <Box variant="awsui-value-large">
              {loading ? <Skeleton className="h-9 w-12" /> : `★ ${avgRating}`}
            </Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">検索結果</Box>
            <Box variant="awsui-value-large">
              {loading ? <Skeleton className="h-9 w-12" /> : filteredProblems.length}
            </Box>
          </Container>
        </ColumnLayout>
      )}

      {!error && loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Container key={i}>
              <SpaceBetween size="m">
                <Skeleton className="h-6 w-3/4 mb-4" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
                <div className="flex gap-2 mt-4">
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-16" />
                </div>
              </SpaceBetween>
            </Container>
          ))}
        </div>
      ) : !error && filteredProblems.length === 0 ? (
        <Container>
          <Box textAlign="center" padding="xxl">
            <SpaceBetween size="m">
              <Box variant="h2">問題が見つかりません</Box>
              <Box color="text-body-secondary">
                検索条件または絞り込み条件を変更してください。
              </Box>
            </SpaceBetween>
          </Box>
        </Container>
      ) : !error ? (
        <Cards
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 700, cards: 2 },
          ]}
          items={filteredProblems}
          cardDefinition={{
            header: (problem) => (
              <SpaceBetween direction="horizontal" size="s">
                <Box fontSize="heading-m" fontWeight="bold">
                  {getCategoryIcon(problem.category)} {problem.title}
                </Box>
                <CloudscapeBadge color={problem.type === 'gameday' ? 'blue' : 'green'}>
                  {problem.type === 'gameday' ? 'Incident Drill' : 'Challenge'}
                </CloudscapeBadge>
              </SpaceBetween>
            ),
            sections: [
              {
                id: 'author',
                header: '作成者',
                content: (problem) => problem.authorName,
              },
              {
                id: 'description',
                header: '説明',
                content: (problem) => (
                  <Box color="text-body-secondary">{problem.description}</Box>
                ),
              },
              {
                id: 'meta',
                header: '属性',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    <CloudscapeBadge color="grey">
                      {getDifficultyLabel(problem.difficulty)}
                    </CloudscapeBadge>
                    <CloudscapeBadge color="grey">
                      {getCategoryLabel(problem.category)}
                    </CloudscapeBadge>
                    <CloudscapeBadge color="grey">
                      {problem.cloudProvider.toUpperCase()}
                    </CloudscapeBadge>
                  </SpaceBetween>
                ),
              },
              {
                id: 'summary',
                header: '概要',
                content: (problem) => (
                  <Box color="text-body-secondary">
                    推定 {problem.estimatedTimeMinutes} 分 / ★{' '}
                    {problem.rating.toFixed(1)} / {problem.usageCount} 回使用
                  </Box>
                ),
              },
              {
                id: 'tags',
                header: 'タグ',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    {problem.tags.slice(0, 3).map((tag) => (
                      <CloudscapeBadge key={tag}>{tag}</CloudscapeBadge>
                    ))}
                    {problem.tags.length > 3 ? (
                      <Box color="text-body-secondary">
                        +{problem.tags.length - 3}
                      </Box>
                    ) : null}
                  </SpaceBetween>
                ),
              },
              {
                id: 'actions',
                header: '操作',
                content: (problem) => (
                  <SpaceBetween direction="horizontal" size="xs">
                    <CloudscapeButton onClick={() => handlePreview(problem.id)}>
                      プレビュー
                    </CloudscapeButton>
                    <CloudscapeButton
                      variant="primary"
                      onClick={() => handleAddToEvent(problem.id)}
                    >
                      イベントに追加
                    </CloudscapeButton>
                  </SpaceBetween>
                ),
              },
            ],
          }}
        />
      ) : null}
      
      {/* Preview Modal */}
      <Modal
        visible={previewVisible}
        onDismiss={handleClosePreview}
        header="\u554f\u984c\u30d7\u30ec\u30d3\u30e5\u30fc"
        size="large"
        footer={
          <Box float="right">
            <CloudscapeButton onClick={handleClosePreview}>
              \u9589\u3058\u308b
            </CloudscapeButton>
          </Box>
        }
      >
        {previewLoading && (
          <Box textAlign="center" padding="xl">
            <Spinner size="large" />
          </Box>
        )}
        {previewError && (
          <StatusIndicator type="error">{previewError}</StatusIndicator>
        )}
        {previewProblem && (
          <SpaceBetween size="l">
            <Container
              header={<Header variant="h3">{previewProblem.title}</Header>}
            >
              <KeyValuePairs
                columns={3}
                items={[
                  {
                    label: '\u96e3\u6613\u5ea6',
                    value: (
                      <CloudscapeBadge
                        color={
                          previewProblem.difficulty === 'easy'
                            ? 'green'
                            : previewProblem.difficulty === 'medium'
                              ? 'blue'
                              : previewProblem.difficulty === 'hard'
                                ? 'red'
                                : 'grey'
                        }
                      >
                        {getDifficultyLabel(previewProblem.difficulty)}
                      </CloudscapeBadge>
                    ),
                  },
                  {
                    label: '\u30ab\u30c6\u30b4\u30ea',
                    value: getCategoryLabel(previewProblem.category),
                  },
                  {
                    label:
                      '\u30af\u30e9\u30a6\u30c9\u30d7\u30ed\u30d0\u30a4\u30c0\u30fc',
                    value: getCloudProviderLabel(
                      previewProblem.deployment.providers[0] ?? '',
                    ),
                  },
                  {
                    label: '\u63a8\u5b9a\u6642\u9593',
                    value: previewProblem.description.estimatedTime
                      ? `${previewProblem.description.estimatedTime} \u5206`
                      : '-',
                  },
                  {
                    label: '\u4f5c\u6210\u8005',
                    value: previewProblem.metadata.author,
                  },
                  {
                    label: '\u30d0\u30fc\u30b8\u30e7\u30f3',
                    value: previewProblem.metadata.version,
                  },
                ]}
              />
            </Container>
            <Container header={<Header variant="h3">\u8aac\u660e</Header>}>
              <SpaceBetween size="s">
                <Box>{previewProblem.description.overview}</Box>
                {previewProblem.description.objectives.length > 0 && (
                  <div>
                    <Box variant="h4" margin={{ bottom: 'xs' }}>
                      \u76ee\u6a19
                    </Box>
                    <ul>
                      {previewProblem.description.objectives.map((obj, idx) => (
                        <li key={idx}>{obj}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {previewProblem.description.prerequisites.length > 0 && (
                  <div>
                    <Box variant="h4" margin={{ bottom: 'xs' }}>
                      \u524d\u63d0\u6761\u4ef6
                    </Box>
                    <ul>
                      {previewProblem.description.prerequisites.map(
                        (pre, idx) => (
                          <li key={idx}>{pre}</li>
                        ),
                      )}
                    </ul>
                  </div>
                )}
              </SpaceBetween>
            </Container>
            <Container header={<Header variant="h3">\u30bf\u30b0</Header>}>
              <SpaceBetween direction="horizontal" size="xs">
                {previewProblem.metadata.tags.map((tag) => (
                  <CloudscapeBadge key={tag}>{tag}</CloudscapeBadge>
                ))}
              </SpaceBetween>
            </Container>
            <Container
              header={<Header variant="h3">\u63a1\u70b9\u57fa\u6e96</Header>}
            >
              <ColumnLayout columns={2}>
                {previewProblem.scoring.criteria.map((criterion) => (
                  <div key={criterion.name}>
                    <Box variant="h4">{criterion.name}</Box>
                    {criterion.description && (
                      <Box color="text-body-secondary">
                        {criterion.description}
                      </Box>
                    )}
                    <Box>
                      \u914d\u70b9: {criterion.maxPoints}{' '}
                      \u70b9\uff08\u91cd\u307f: {criterion.weight}\uff09
                    </Box>
                  </div>
                ))}
              </ColumnLayout>
            </Container>
            <Container
              header={
                <Header variant="h3">
                  \u30c7\u30d7\u30ed\u30a4\u60c5\u5831
                </Header>
              }
            >
              <KeyValuePairs
                columns={2}
                items={[
                  {
                    label:
                      '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u30bf\u30a4\u30d7',
                    value: Object.values(previewProblem.deployment.templates)
                      .map((t) => t.type)
                      .join(', '),
                  },
                  {
                    label: '\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8',
                    value: previewProblem.deployment.timeout
                      ? `${previewProblem.deployment.timeout} \u79d2`
                      : '-',
                  },
                  {
                    label: '\u30ea\u30fc\u30b8\u30e7\u30f3',
                    value: Object.entries(previewProblem.deployment.regions)
                      .map(
                        ([provider, regions]) =>
                          `${provider}: ${regions.join(', ')}`,
                      )
                      .join(' | '),
                  },
                ]}
              />
            </Container>
          </SpaceBetween>
        )}
      </Modal>

      {/* Add to Event Modal */}
      <Modal
        visible={addToEventVisible}
        onDismiss={handleCloseAddToEvent}
        header="\u30a4\u30d9\u30f3\u30c8\u306b\u554f\u984c\u3092\u8ffd\u52a0"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <CloudscapeButton onClick={handleCloseAddToEvent}>
                \u30ad\u30e3\u30f3\u30bb\u30eb
              </CloudscapeButton>
              <CloudscapeButton
                variant="primary"
                onClick={handleConfirmAddToEvent}
                disabled={!selectedEventId}
                loading={addingToEvent}
              >
                \u8ffd\u52a0
              </CloudscapeButton>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {eventsLoading && (
            <Box textAlign="center" padding="l">
              <Spinner />
            </Box>
          )}
          {eventsError && (
            <StatusIndicator type="error">{eventsError}</StatusIndicator>
          )}
          {!eventsLoading && !eventsError && (
            <CloudscapeSelect
              selectedOption={
                selectedEventId
                  ? {
                      value: selectedEventId,
                      label:
                        events.find((e) => e.id === selectedEventId)?.name ??
                        '',
                    }
                  : null
              }
              onChange={({ detail }) =>
                setSelectedEventId(detail.selectedOption.value ?? null)
              }
              options={events.map((e) => ({ value: e.id, label: e.name }))}
              placeholder="\u30a4\u30d9\u30f3\u30c8\u3092\u9078\u629e"
              empty="\u30a4\u30d9\u30f3\u30c8\u304c\u3042\u308a\u307e\u305b\u3093"
            />
          )}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
