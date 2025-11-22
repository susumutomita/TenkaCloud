'use client';

import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useState } from 'react';
import {
  useOnboardingStore,
  type PlanTier,
} from '@/lib/stores/onboarding-store';

const plans = [
  {
    tier: 'free' as PlanTier,
    name: 'Free',
    price: '¥0',
    period: '/月',
    description: '個人開発者や小規模イベント向け',
    features: [
      '最大100参加者',
      'Pool モデル',
      '基本的な問題管理',
      'コミュニティサポート',
    ],
  },
  {
    tier: 'pro' as PlanTier,
    name: 'Pro',
    price: '¥9,800',
    period: '/月',
    description: '成長企業や定期開催イベント向け',
    features: [
      '最大1,000参加者',
      'Silo モデル',
      '高度な分析',
      '優先サポート',
      'カスタムドメイン',
    ],
    popular: true,
  },
  {
    tier: 'enterprise' as PlanTier,
    name: 'Enterprise',
    price: 'お問い合わせ',
    period: '',
    description: '大規模イベント向け',
    features: [
      '無制限参加者',
      '専用インフラ',
      'SLA 保証',
      '専任サポート',
      'カスタム統合',
    ],
  },
];

export function PlanStep() {
  const { planData, setPlanData, setCurrentStep } = useOnboardingStore();
  const [selectedTier, setSelectedTier] = useState<PlanTier | null>(
    planData.tier || null
  );

  const handleNext = () => {
    if (selectedTier) {
      setPlanData({ tier: selectedTier });
      setCurrentStep('tenant');
    }
  };

  const handleBack = () => {
    setCurrentStep('profile');
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-3xl font-bold gradient-text mb-2">
          プランを選択してください
        </h2>
        <p className="text-white/60">後からいつでも変更できます</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {plans.map((plan) => (
          <motion.button
            key={plan.tier}
            type="button"
            onClick={() => setSelectedTier(plan.tier)}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-6 rounded-2xl text-left transition-all ${
              selectedTier === plan.tier
                ? 'glass border-primary-500 glow'
                : 'glass'
            }`}
          >
            {plan.popular && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <div className="px-3 py-1 bg-gradient-to-r from-primary-500 to-accent-500 rounded-full text-xs font-semibold">
                  人気
                </div>
              </div>
            )}

            {selectedTier === plan.tier && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center">
                  <Check className="w-4 h-4 text-white" />
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-bold text-white">{plan.name}</h3>
                <p className="text-sm text-white/60 mt-1">{plan.description}</p>
              </div>

              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold text-white">
                  {plan.price}
                </span>
                {plan.period && (
                  <span className="text-white/60">{plan.period}</span>
                )}
              </div>

              <ul className="space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="w-4 h-4 text-accent-400 flex-shrink-0 mt-0.5" />
                    <span className="text-white/80">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.button>
        ))}
      </div>

      <div className="flex items-center justify-between pt-6">
        <motion.button
          type="button"
          onClick={handleBack}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="flex items-center gap-2 px-6 py-3 glass rounded-xl font-semibold"
        >
          <ArrowLeft className="w-5 h-5" />
          戻る
        </motion.button>

        <motion.button
          type="button"
          onClick={handleNext}
          disabled={!selectedTier}
          whileHover={{ scale: selectedTier ? 1.05 : 1 }}
          whileTap={{ scale: selectedTier ? 0.95 : 1 }}
          className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
        >
          次へ
          <ArrowRight className="w-5 h-5" />
        </motion.button>
      </div>
    </div>
  );
}
