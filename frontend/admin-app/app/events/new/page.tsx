'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { createEvent, type CreateEventInput } from '@/lib/api/events';
import {
  searchMarketplaceProblems,
  type MarketplaceProblem,
  type ProblemType,
  type CloudProvider,
} from '@/lib/api/problems';

type Step = 'basic' | 'problems' | 'settings' | 'review';

const steps: { id: Step; label: string }[] = [
  { id: 'basic', label: '基本情報' },
  { id: 'problems', label: '問題選択' },
  { id: 'settings', label: '詳細設定' },
  { id: 'review', label: '確認' },
];

export default function NewEventPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<Step>('basic');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 基本情報
  const [name, setName] = useState('');
  const [type, setType] = useState<ProblemType>('gameday');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('17:00');

  // 参加者設定
  const [participantType, setParticipantType] = useState<'individual' | 'team'>('team');
  const [maxParticipants, setMaxParticipants] = useState(20);
  const [minTeamSize, setMinTeamSize] = useState(2);
  const [maxTeamSize, setMaxTeamSize] = useState(5);

  // クラウド設定
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('aws');
  const [selectedRegions, setSelectedRegions] = useState<string[]>(['ap-northeast-1']);

  // 採点設定
  const [scoringType, setScoringType] = useState<'realtime' | 'batch'>('realtime');
  const [scoringInterval, setScoringInterval] = useState(5);
  const [leaderboardVisible, setLeaderboardVisible] = useState(true);
  const [freezeMinutes, setFreezeMinutes] = useState(30);

  // 問題選択
  const [availableProblems, setAvailableProblems] = useState<MarketplaceProblem[]>([]);
  const [selectedProblemIds, setSelectedProblemIds] = useState<string[]>([]);
  const [loadingProblems, setLoadingProblems] = useState(false);

  const loadProblems = useCallback(async () => {
    setLoadingProblems(true);
    try {
      const result = await searchMarketplaceProblems({
        type,
        provider: cloudProvider,
        limit: 50,
      });
      setAvailableProblems(result.problems);
    } catch (error) {
      console.error('Failed to load problems:', error);
    } finally {
      setLoadingProblems(false);
    }
  }, [type, cloudProvider]);

  useEffect(() => {
    if (currentStep === 'problems') {
      loadProblems();
    }
  }, [currentStep, loadProblems]);

  const handleToggleProblem = (problemId: string) => {
    setSelectedProblemIds((prev) =>
      prev.includes(problemId)
        ? prev.filter((id) => id !== problemId)
        : [...prev, problemId]
    );
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const startDateTime = `${startDate}T${startTime}:00+09:00`;
      const endDateTime = `${endDate}T${endTime}:00+09:00`;

      const input: CreateEventInput = {
        name,
        type,
        startTime: startDateTime,
        endTime: endDateTime,
        timezone: 'Asia/Tokyo',
        participantType,
        maxParticipants,
        minTeamSize: participantType === 'team' ? minTeamSize : undefined,
        maxTeamSize: participantType === 'team' ? maxTeamSize : undefined,
        cloudProvider,
        regions: selectedRegions,
        scoringType,
        scoringIntervalMinutes: scoringInterval,
        leaderboardVisible,
        freezeLeaderboardMinutes: freezeMinutes || undefined,
        problemIds: selectedProblemIds,
      };

      const event = await createEvent(input);
      alert(`イベントを作成しました (ID: ${event.id})`);
      router.push('/events');
    } catch (error) {
      console.error('Failed to create event:', error);
      alert('イベントの作成に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  const canProceed = (): boolean => {
    switch (currentStep) {
      case 'basic':
        return !!(name && startDate && endDate);
      case 'problems':
        return selectedProblemIds.length > 0;
      case 'settings':
        return true;
      case 'review':
        return true;
      default:
        return false;
    }
  };

  const goToNext = () => {
    const currentIndex = steps.findIndex((s) => s.id === currentStep);
    if (currentIndex < steps.length - 1) {
      setCurrentStep(steps[currentIndex + 1]!.id);
    }
  };

  const goToPrev = () => {
    const currentIndex = steps.findIndex((s) => s.id === currentStep);
    if (currentIndex > 0) {
      setCurrentStep(steps[currentIndex - 1]!.id);
    }
  };

  const selectedProblems = availableProblems.filter((p) =>
    selectedProblemIds.includes(p.id)
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">新規イベント作成</h1>

      {/* ステッププログレス */}
      <div className="flex items-center justify-between mb-8">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-center">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                currentStep === step.id
                  ? 'bg-primary text-primary-foreground'
                  : steps.findIndex((s) => s.id === currentStep) > index
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-200 text-gray-600'
              }`}
            >
              {steps.findIndex((s) => s.id === currentStep) > index ? '✓' : index + 1}
            </div>
            <span className="ml-2 text-sm hidden sm:inline">{step.label}</span>
            {index < steps.length - 1 && (
              <div className="w-8 sm:w-16 h-0.5 bg-gray-200 mx-2" />
            )}
          </div>
        ))}
      </div>

      {/* ステップコンテンツ */}
      <Card>
        <CardContent className="p-6">
          {/* 基本情報 */}
          {currentStep === 'basic' && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium mb-2">イベント名 *</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例: AWS GameDay 2025 Spring"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">イベントタイプ *</label>
                <Select
                  value={type}
                  onChange={(e) => setType(e.target.value as ProblemType)}
                >
                  <option value="gameday">GameDay (トラブルシューティング)</option>
                  <option value="jam">JAM (チャレンジ解決)</option>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">開始日時 *</label>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                    <Input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-32"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">終了日時 *</label>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                    <Input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-32"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">参加形式</label>
                  <Select
                    value={participantType}
                    onChange={(e) => setParticipantType(e.target.value as 'individual' | 'team')}
                  >
                    <option value="team">チーム参加</option>
                    <option value="individual">個人参加</option>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">
                    最大{participantType === 'team' ? 'チーム' : '参加者'}数
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(Number(e.target.value))}
                  />
                </div>
              </div>

              {participantType === 'team' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">最小チームサイズ</label>
                    <Input
                      type="number"
                      min={1}
                      value={minTeamSize}
                      onChange={(e) => setMinTeamSize(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">最大チームサイズ</label>
                    <Input
                      type="number"
                      min={1}
                      value={maxTeamSize}
                      onChange={(e) => setMaxTeamSize(Number(e.target.value))}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">クラウドプロバイダー</label>
                  <Select
                    value={cloudProvider}
                    onChange={(e) => setCloudProvider(e.target.value as CloudProvider)}
                  >
                    <option value="aws">AWS</option>
                    <option value="gcp">Google Cloud</option>
                    <option value="azure">Azure</option>
                    <option value="local">Local (開発用)</option>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">リージョン</label>
                  <Select
                    value={selectedRegions[0]}
                    onChange={(e) => setSelectedRegions([e.target.value])}
                  >
                    <option value="ap-northeast-1">東京 (ap-northeast-1)</option>
                    <option value="us-east-1">バージニア (us-east-1)</option>
                    <option value="us-west-2">オレゴン (us-west-2)</option>
                    <option value="eu-west-1">アイルランド (eu-west-1)</option>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* 問題選択 */}
          {currentStep === 'problems' && (
            <div>
              <div className="mb-4">
                <h3 className="font-medium mb-2">問題を選択 ({selectedProblemIds.length} 件選択中)</h3>
                <p className="text-sm text-muted-foreground">
                  イベントで出題する問題を選択してください
                </p>
              </div>

              {loadingProblems ? (
                <div className="space-y-2">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-20 bg-gray-100 animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {availableProblems.map((problem) => (
                    <div
                      key={problem.id}
                      className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                        selectedProblemIds.includes(problem.id)
                          ? 'border-primary bg-primary/5'
                          : 'hover:bg-gray-50'
                      }`}
                      onClick={() => handleToggleProblem(problem.id)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{problem.title}</span>
                            {problem.isVerified && (
                              <svg className="h-4 w-4 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground line-clamp-1">
                            {problem.overview}
                          </p>
                          <div className="flex items-center gap-2 mt-2">
                            <Badge variant="outline" className="text-xs">
                              {problem.difficulty}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              {problem.category}
                            </Badge>
                            {problem.estimatedTimeMinutes && (
                              <span className="text-xs text-muted-foreground">
                                {problem.estimatedTimeMinutes}分
                              </span>
                            )}
                          </div>
                        </div>
                        <div className={`w-5 h-5 rounded border flex items-center justify-center ${
                          selectedProblemIds.includes(problem.id)
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-gray-300'
                        }`}>
                          {selectedProblemIds.includes(problem.id) && '✓'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 詳細設定 */}
          {currentStep === 'settings' && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium mb-2">採点方式</label>
                <Select
                  value={scoringType}
                  onChange={(e) => setScoringType(e.target.value as 'realtime' | 'batch')}
                >
                  <option value="realtime">リアルタイム採点</option>
                  <option value="batch">バッチ採点</option>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  リアルタイム: 定期的に自動採点 / バッチ: 手動または定期的なバッチ処理
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">採点間隔 (分)</label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={scoringInterval}
                  onChange={(e) => setScoringInterval(Number(e.target.value))}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="leaderboardVisible"
                  checked={leaderboardVisible}
                  onChange={(e) => setLeaderboardVisible(e.target.checked)}
                  className="w-4 h-4"
                />
                <label htmlFor="leaderboardVisible" className="text-sm font-medium">
                  リーダーボードを表示
                </label>
              </div>

              {leaderboardVisible && (
                <div>
                  <label className="block text-sm font-medium mb-2">
                    リーダーボード凍結時間 (終了前の分数)
                  </label>
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={freezeMinutes}
                    onChange={(e) => setFreezeMinutes(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    0 の場合は凍結しません
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 確認 */}
          {currentStep === 'review' && (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium mb-3">基本情報</h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">イベント名</dt>
                  <dd>{name}</dd>
                  <dt className="text-muted-foreground">タイプ</dt>
                  <dd>{type === 'gameday' ? 'GameDay' : 'JAM'}</dd>
                  <dt className="text-muted-foreground">開始</dt>
                  <dd>{startDate} {startTime}</dd>
                  <dt className="text-muted-foreground">終了</dt>
                  <dd>{endDate} {endTime}</dd>
                  <dt className="text-muted-foreground">参加形式</dt>
                  <dd>
                    {participantType === 'team'
                      ? `チーム (${minTeamSize}〜${maxTeamSize}人)`
                      : '個人'}
                  </dd>
                  <dt className="text-muted-foreground">最大参加数</dt>
                  <dd>{maxParticipants}</dd>
                  <dt className="text-muted-foreground">クラウド</dt>
                  <dd className="uppercase">{cloudProvider} ({selectedRegions.join(', ')})</dd>
                </dl>
              </div>

              <div>
                <h3 className="font-medium mb-3">選択した問題 ({selectedProblems.length} 件)</h3>
                <ul className="space-y-1 text-sm">
                  {selectedProblems.map((problem, index) => (
                    <li key={problem.id} className="flex items-center gap-2">
                      <span className="text-muted-foreground">{index + 1}.</span>
                      <span>{problem.title}</span>
                      <Badge variant="outline" className="text-xs">
                        {problem.difficulty}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="font-medium mb-3">採点設定</h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">採点方式</dt>
                  <dd>{scoringType === 'realtime' ? 'リアルタイム' : 'バッチ'}</dd>
                  <dt className="text-muted-foreground">採点間隔</dt>
                  <dd>{scoringInterval}分</dd>
                  <dt className="text-muted-foreground">リーダーボード</dt>
                  <dd>{leaderboardVisible ? '表示' : '非表示'}</dd>
                  {leaderboardVisible && freezeMinutes > 0 && (
                    <>
                      <dt className="text-muted-foreground">凍結時間</dt>
                      <dd>終了{freezeMinutes}分前</dd>
                    </>
                  )}
                </dl>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ナビゲーションボタン */}
      <div className="flex items-center justify-between mt-6">
        <Button
          variant="outline"
          onClick={goToPrev}
          disabled={currentStep === 'basic'}
        >
          戻る
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => router.push('/events')}
          >
            キャンセル
          </Button>
          {currentStep === 'review' ? (
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? '作成中...' : 'イベントを作成'}
            </Button>
          ) : (
            <Button
              onClick={goToNext}
              disabled={!canProceed()}
            >
              次へ
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
