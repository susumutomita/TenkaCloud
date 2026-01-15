'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Cloud,
  Building2,
  Settings,
  Rocket,
  ChevronRight,
  ChevronLeft,
  Check,
} from 'lucide-react';

const STEPS = [
  { id: 'profile', title: 'プロフィール', icon: Building2 },
  { id: 'plan', title: 'プラン選択', icon: Settings },
  { id: 'tenant', title: 'テナント設定', icon: Cloud },
  { id: 'confirm', title: '確認', icon: Rocket },
];

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '¥0',
    period: '/月',
    features: ['1テナント', '基本問題', 'コミュニティサポート'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '¥4,980',
    period: '/月',
    features: ['5テナント', '全問題アクセス', '優先サポート', 'AI コーチング'],
    recommended: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'お問い合わせ',
    period: '',
    features: ['無制限テナント', 'カスタム問題', '専用サポート', 'SLA 保証'],
  },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    organizationName: '',
    role: '',
    plan: 'free',
    tenantName: '',
    tenantSlug: '',
    region: 'ap-northeast-1',
  });

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      router.push('/onboarding/provisioning');
    } finally {
      setIsLoading(false);
    }
  };

  const updateSlug = (name: string) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    setFormData({ ...formData, tenantName: name, tenantSlug: slug });
  };

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-4">
            <Cloud className="w-8 h-8 text-hn-accent" />
            <span className="font-display text-2xl font-bold">TenkaCloud</span>
          </Link>
          <h1 className="text-2xl font-bold">セットアップ</h1>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-between mb-8">
          {STEPS.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center border-2 ${
                  index < currentStep
                    ? 'bg-hn-accent border-hn-accent text-surface-0'
                    : index === currentStep
                      ? 'border-hn-accent text-hn-accent'
                      : 'border-border text-text-muted'
                }`}
              >
                {index < currentStep ? (
                  <Check className="w-5 h-5" />
                ) : (
                  <step.icon className="w-5 h-5" />
                )}
              </div>
              {index < STEPS.length - 1 && (
                <div
                  className={`w-12 h-0.5 mx-2 ${
                    index < currentStep ? 'bg-hn-accent' : 'bg-border'
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="bg-surface-1 rounded-lg border border-border p-6 mb-6">
          <h2 className="text-xl font-bold mb-6">{STEPS[currentStep].title}</h2>

          {currentStep === 0 && (
            <div className="space-y-4">
              <Input
                label="組織名"
                placeholder="株式会社〇〇"
                value={formData.organizationName}
                onChange={(e) =>
                  setFormData({ ...formData, organizationName: e.target.value })
                }
              />
              <Input
                label="役割"
                placeholder="エンジニア、マネージャー等"
                value={formData.role}
                onChange={(e) =>
                  setFormData({ ...formData, role: e.target.value })
                }
              />
            </div>
          )}

          {currentStep === 1 && (
            <div className="grid gap-4">
              {PLANS.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setFormData({ ...formData, plan: plan.id })}
                  className={`p-4 rounded-lg border-2 text-left transition-all ${
                    formData.plan === plan.id
                      ? 'border-hn-accent bg-hn-accent/5'
                      : 'border-border hover:border-hn-accent/50'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="font-bold">{plan.name}</span>
                      {plan.recommended && (
                        <span className="ml-2 px-2 py-0.5 text-xs bg-hn-accent text-surface-0 rounded">
                          おすすめ
                        </span>
                      )}
                    </div>
                    <span className="font-bold text-hn-accent">
                      {plan.price}
                      <span className="text-sm text-text-muted">
                        {plan.period}
                      </span>
                    </span>
                  </div>
                  <ul className="mt-2 text-sm text-text-muted space-y-1">
                    {plan.features.map((f) => (
                      <li key={f}>✓ {f}</li>
                    ))}
                  </ul>
                </button>
              ))}
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-4">
              <Input
                label="テナント名"
                placeholder="My Team"
                value={formData.tenantName}
                onChange={(e) => updateSlug(e.target.value)}
              />
              <Input
                label="スラッグ"
                placeholder="my-team"
                value={formData.tenantSlug}
                onChange={(e) =>
                  setFormData({ ...formData, tenantSlug: e.target.value })
                }
                hint={`URL: ${formData.tenantSlug || 'your-slug'}.tenkacloud.io`}
              />
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-4">
              <div className="p-4 bg-surface-2 rounded-lg space-y-2">
                <p>
                  <span className="text-text-muted">組織:</span>{' '}
                  {formData.organizationName || '未設定'}
                </p>
                <p>
                  <span className="text-text-muted">プラン:</span>{' '}
                  {PLANS.find((p) => p.id === formData.plan)?.name}
                </p>
                <p>
                  <span className="text-text-muted">テナント:</span>{' '}
                  {formData.tenantName || '未設定'}
                </p>
                <p>
                  <span className="text-text-muted">URL:</span>{' '}
                  {formData.tenantSlug}.tenkacloud.io
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="ghost"
            onClick={handleBack}
            disabled={currentStep === 0}
          >
            <ChevronLeft className="w-4 h-4" />
            戻る
          </Button>
          {currentStep === STEPS.length - 1 ? (
            <Button onClick={handleSubmit} loading={isLoading}>
              環境を作成
              <Rocket className="w-4 h-4" />
            </Button>
          ) : (
            <Button onClick={handleNext}>
              次へ
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
