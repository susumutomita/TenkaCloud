/**
 * Problem Form Component
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題作成・編集フォーム - 共通コンポーネント
 */

'use client';

import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  CreateProblemRequest,
  ProblemScoringCriterion,
} from '@/lib/api/admin-types';
import type {
  CloudProvider,
  DifficultyLevel,
  ProblemCategory,
  ProblemType,
} from '@/lib/api/types';

export interface ProblemFormProps {
  initialData?: Partial<CreateProblemRequest>;
  onSubmit: (data: CreateProblemRequest) => Promise<void>;
  formTitle: string;
  submitLabel: string;
  submitting?: boolean;
}

const TYPE_OPTIONS = [
  { value: 'gameday', label: 'GameDay' },
  { value: 'jam', label: 'JAM' },
];

const CATEGORY_OPTIONS = [
  { value: 'architecture', label: 'アーキテクチャ' },
  { value: 'security', label: 'セキュリティ' },
  { value: 'cost', label: 'コスト最適化' },
  { value: 'performance', label: 'パフォーマンス' },
  { value: 'reliability', label: '信頼性' },
  { value: 'operations', label: '運用' },
];

const DIFFICULTY_OPTIONS = [
  { value: 'easy', label: '初級' },
  { value: 'medium', label: '中級' },
  { value: 'hard', label: '上級' },
  { value: 'expert', label: 'エキスパート' },
];

const PROVIDER_OPTIONS = [
  { value: 'aws', label: 'AWS' },
  { value: 'gcp', label: 'GCP' },
  { value: 'azure', label: 'Azure' },
  { value: 'local', label: 'ローカル' },
];

const SCORING_TYPE_OPTIONS = [
  { value: 'lambda', label: 'Lambda' },
  { value: 'container', label: 'Container' },
  { value: 'api', label: 'API' },
  { value: 'manual', label: '手動' },
];

export function ProblemForm({
  initialData,
  onSubmit,
  formTitle,
  submitLabel,
  submitting = false,
}: ProblemFormProps) {
  const [title, setTitle] = useState(initialData?.title ?? '');
  const [type, setType] = useState<ProblemType>(initialData?.type ?? 'gameday');
  const [category, setCategory] = useState<ProblemCategory>(
    initialData?.category ?? 'architecture'
  );
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(
    initialData?.difficulty ?? 'medium'
  );
  const [overview, setOverview] = useState(
    initialData?.description?.overview ?? ''
  );
  const [objectives, setObjectives] = useState<string[]>(
    initialData?.description?.objectives ?? ['']
  );
  const [estimatedTime, setEstimatedTime] = useState(
    initialData?.description?.estimatedTime?.toString() ?? ''
  );
  const [selectedProviders, setSelectedProviders] = useState<CloudProvider[]>(
    initialData?.deployment?.providers ?? ['aws']
  );
  const [region, setRegion] = useState(
    Object.values(initialData?.deployment?.regions ?? {})[0]?.[0] ?? ''
  );
  const [scoringType, setScoringType] = useState<
    'lambda' | 'container' | 'api' | 'manual'
  >(initialData?.scoring?.type ?? 'lambda');
  const [scoringPath, setScoringPath] = useState(
    initialData?.scoring?.path ?? ''
  );
  const [scoringTimeout, setScoringTimeout] = useState(
    initialData?.scoring?.timeoutMinutes?.toString() ?? '30'
  );
  const [criteria, setCriteria] = useState<ProblemScoringCriterion[]>(
    initialData?.scoring?.criteria ?? [
      { name: '', description: '', weight: 1, maxPoints: 100 },
    ]
  );
  const [author, setAuthor] = useState(initialData?.metadata?.author ?? '');
  const [version, setVersion] = useState(
    initialData?.metadata?.version ?? '1.0.0'
  );
  const [tags, setTags] = useState<string[]>(initialData?.metadata?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAddObjective = () => setObjectives([...objectives, '']);
  const handleRemoveObjective = (index: number) =>
    setObjectives(objectives.filter((_, i) => i !== index));
  const handleObjectiveChange = (index: number, value: string) => {
    const updated = [...objectives];
    updated[index] = value;
    setObjectives(updated);
  };

  const handleProviderToggle = (provider: CloudProvider) =>
    setSelectedProviders((prev) =>
      prev.includes(provider)
        ? prev.filter((p) => p !== provider)
        : [...prev, provider]
    );

  const handleAddCriterion = () =>
    setCriteria([
      ...criteria,
      { name: '', description: '', weight: 1, maxPoints: 100 },
    ]);
  const handleRemoveCriterion = (index: number) =>
    setCriteria(criteria.filter((_, i) => i !== index));
  const handleCriterionChange = (
    index: number,
    field: keyof ProblemScoringCriterion,
    value: string | number
  ) => {
    const updated = [...criteria];
    updated[index] = { ...updated[index], [field]: value };
    setCriteria(updated);
  };

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
      setTagInput('');
    }
  };
  const handleRemoveTag = (tag: string) =>
    setTags(tags.filter((t) => t !== tag));
  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('タイトルは必須です');
      return;
    }
    if (!overview.trim()) {
      setError('概要は必須です');
      return;
    }
    if (selectedProviders.length === 0) {
      setError('プロバイダーを1つ以上選択してください');
      return;
    }

    const filteredObjectives = objectives.filter((o) => o.trim());
    const filteredCriteria = criteria.filter((c) => c.name.trim());
    const regions: Record<string, string[]> = {};
    for (const provider of selectedProviders) {
      regions[provider] = region.trim() ? [region.trim()] : [];
    }

    const data: CreateProblemRequest = {
      title: title.trim(),
      type,
      category,
      difficulty,
      description: {
        overview: overview.trim(),
        objectives: filteredObjectives,
        hints: initialData?.description?.hints ?? [],
        prerequisites: initialData?.description?.prerequisites ?? [],
        estimatedTime: estimatedTime ? Number(estimatedTime) : undefined,
      },
      deployment: {
        providers: selectedProviders,
        templates: initialData?.deployment?.templates ?? {},
        regions,
      },
      scoring: {
        type: scoringType,
        path: scoringPath.trim(),
        timeoutMinutes: Number(scoringTimeout) || 30,
        criteria: filteredCriteria.map((c) => ({
          name: c.name,
          description: c.description,
          weight: Number(c.weight),
          maxPoints: Number(c.maxPoints),
        })),
      },
      metadata: {
        author: author.trim(),
        version: version.trim(),
        tags,
      },
    };

    try {
      await onSubmit(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : '送信に失敗しました';
      setError(message);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          {formTitle}
        </h1>
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? '送信中...' : submitLabel}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-hn-error">
          <CardContent className="p-4 text-hn-error">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-hn-accent font-mono">01</span>
            基本情報
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            label="タイトル"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="問題のタイトルを入力"
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select
              label="タイプ"
              value={type}
              onChange={(e) => setType(e.target.value as ProblemType)}
              options={TYPE_OPTIONS}
            />
            <Select
              label="カテゴリ"
              value={category}
              onChange={(e) => setCategory(e.target.value as ProblemCategory)}
              options={CATEGORY_OPTIONS}
            />
            <Select
              label="難易度"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as DifficultyLevel)}
              options={DIFFICULTY_OPTIONS}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-hn-accent font-mono">02</span>
            説明
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            label="概要"
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            placeholder="問題の概要を入力"
            rows={5}
          />
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-text-secondary">
                目標
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAddObjective}
              >
                + 追加
              </Button>
            </div>
            <div className="space-y-2">
              {objectives.map((objective, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={objective}
                    onChange={(e) =>
                      handleObjectiveChange(index, e.target.value)
                    }
                    placeholder={`目標 ${index + 1}`}
                  />
                  {objectives.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-hn-error hover:text-hn-error shrink-0"
                      onClick={() => handleRemoveObjective(index)}
                    >
                      削除
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <Input
            label="推定時間（分）"
            type="number"
            value={estimatedTime}
            onChange={(e) => setEstimatedTime(e.target.value)}
            placeholder="60"
            hint="問題の推定所要時間を分で入力"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-hn-accent font-mono">03</span>
            デプロイメント
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              対応プロバイダー
            </label>
            <div className="flex flex-wrap gap-2">
              {PROVIDER_OPTIONS.map((option) => {
                const isSelected = selectedProviders.includes(
                  option.value as CloudProvider
                );
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() =>
                      handleProviderToggle(option.value as CloudProvider)
                    }
                    className={`px-4 py-2 rounded-[var(--radius)] border text-sm font-medium transition-all duration-[var(--animation-duration-fast)] ${
                      isSelected
                        ? 'border-hn-accent bg-hn-accent/10 text-hn-accent'
                        : 'border-border bg-surface-1 text-text-muted hover:border-hn-accent/50'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Input
            label="リージョン"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="ap-northeast-1"
            hint="デプロイ先のリージョンを入力"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-hn-accent font-mono">04</span>
            採点設定
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Select
              label="採点方式"
              value={scoringType}
              onChange={(e) =>
                setScoringType(
                  e.target.value as 'lambda' | 'container' | 'api' | 'manual'
                )
              }
              options={SCORING_TYPE_OPTIONS}
            />
            <Input
              label="採点パス"
              value={scoringPath}
              onChange={(e) => setScoringPath(e.target.value)}
              placeholder="scoring/"
            />
            <Input
              label="タイムアウト（分）"
              type="number"
              value={scoringTimeout}
              onChange={(e) => setScoringTimeout(e.target.value)}
              placeholder="30"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-text-secondary">
                採点基準
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleAddCriterion}
              >
                + 追加
              </Button>
            </div>
            <div className="space-y-3">
              {criteria.map((criterion, index) => (
                <div
                  key={index}
                  className="p-3 bg-surface-2 rounded-[var(--radius)] space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-mono text-text-muted">
                      基準 {index + 1}
                    </span>
                    {criteria.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-hn-error hover:text-hn-error"
                        onClick={() => handleRemoveCriterion(index)}
                      >
                        削除
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Input
                      placeholder="基準名"
                      value={criterion.name}
                      onChange={(e) =>
                        handleCriterionChange(index, 'name', e.target.value)
                      }
                    />
                    <Input
                      placeholder="説明"
                      value={criterion.description ?? ''}
                      onChange={(e) =>
                        handleCriterionChange(
                          index,
                          'description',
                          e.target.value
                        )
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="重み"
                      type="number"
                      inputSize="sm"
                      value={criterion.weight.toString()}
                      onChange={(e) =>
                        handleCriterionChange(
                          index,
                          'weight',
                          Number(e.target.value)
                        )
                      }
                    />
                    <Input
                      label="最大ポイント"
                      type="number"
                      inputSize="sm"
                      value={criterion.maxPoints.toString()}
                      onChange={(e) =>
                        handleCriterionChange(
                          index,
                          'maxPoints',
                          Number(e.target.value)
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <span className="text-hn-accent font-mono">05</span>
            メタデータ
          </h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="作成者"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="作成者名"
            />
            <Input
              label="バージョン"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.0.0"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              タグ
            </label>
            <div className="flex gap-2 mb-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                placeholder="タグを入力してEnter"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={handleAddTag}
              >
                追加
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-surface-2 text-text-muted rounded-[var(--radius)] font-mono"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="text-text-muted hover:text-hn-error transition-colors"
                      aria-label={`タグ「${tag}」を削除`}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? '送信中...' : submitLabel}
        </Button>
      </div>

      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> problem --
        {initialData ? 'edit' : 'new'}
      </div>
    </form>
  );
}
