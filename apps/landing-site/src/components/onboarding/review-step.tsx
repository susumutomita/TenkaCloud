'use client';

import { motion } from 'framer-motion';
import { ArrowLeft, Rocket } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useOnboardingStore } from '@/lib/stores/onboarding-store';

const planLabels = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

const modelLabels = {
  pool: 'Pool (共有リソース)',
  silo: 'Silo (専用リソース)',
};

const computeLabels = {
  serverless: 'Serverless',
  kubernetes: 'Kubernetes',
};

export function ReviewStep() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { profileData, planData, tenantData, environmentData, setCurrentStep } =
    useOnboardingStore();

  const handleSubmit = async () => {
    setIsSubmitting(true);

    try {
      const payload = {
        name: tenantData.name,
        slug: tenantData.slug,
        adminEmail: profileData.email,
        tier: planData.tier?.toUpperCase(),
        region: tenantData.region,
        isolationModel: environmentData.model?.toUpperCase(),
        computeType: environmentData.compute?.toUpperCase(),
        status: 'ACTIVE',
      };

      console.log('Creating tenant:', payload);

      const response = await fetch('http://localhost:3004/api/tenants', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create tenant');
      }

      const result = await response.json();
      console.log('Tenant created:', result);

      // Redirect to provisioning page
      router.push('/onboarding/provisioning');
    } catch (error) {
      console.error('Failed to create tenant:', error);
      alert(error instanceof Error ? error.message : 'Failed to create tenant');
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    setCurrentStep('environment');
  };

  return (
    <div className="glass rounded-3xl p-8 max-w-2xl mx-auto">
      <div className="space-y-8">
        <div>
          <h2 className="text-3xl font-bold gradient-text mb-2">
            設定内容の確認
          </h2>
          <p className="text-white/60">
            内容を確認して、テナントを作成しましょう
          </p>
        </div>

        <div className="space-y-6">
          {/* Profile */}
          <div className="p-6 bg-white/5 rounded-xl border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-4">
              プロフィール
            </h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-white/60">お名前</dt>
                <dd className="text-white font-medium">
                  {profileData.fullName}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/60">組織名</dt>
                <dd className="text-white font-medium">
                  {profileData.organizationName}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/60">用途</dt>
                <dd className="text-white font-medium text-right max-w-xs">
                  {profileData.purpose}
                </dd>
              </div>
            </dl>
          </div>

          {/* Plan */}
          <div className="p-6 bg-white/5 rounded-xl border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-4">プラン</h3>
            <p className="text-2xl font-bold text-primary-400">
              {planData.tier && planLabels[planData.tier]}
            </p>
          </div>

          {/* Tenant */}
          <div className="p-6 bg-white/5 rounded-xl border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-4">
              テナント設定
            </h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-white/60">テナント名</dt>
                <dd className="text-white font-medium">{tenantData.name}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/60">URL</dt>
                <dd className="text-white font-medium">
                  https://{tenantData.slug}.tenkacloud.io
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/60">リージョン</dt>
                <dd className="text-white font-medium">{tenantData.region}</dd>
              </div>
            </dl>
          </div>

          {/* Environment */}
          <div className="p-6 bg-white/5 rounded-xl border border-white/10">
            <h3 className="text-lg font-semibold text-white mb-4">環境設定</h3>
            <dl className="space-y-3">
              <div className="flex justify-between">
                <dt className="text-white/60">テナントモデル</dt>
                <dd className="text-white font-medium">
                  {environmentData.model && modelLabels[environmentData.model]}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-white/60">コンピュートタイプ</dt>
                <dd className="text-white font-medium">
                  {environmentData.compute &&
                    computeLabels[environmentData.compute]}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="flex items-center justify-between pt-6">
          <motion.button
            type="button"
            onClick={handleBack}
            disabled={isSubmitting}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="flex items-center gap-2 px-6 py-3 glass rounded-xl font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowLeft className="w-5 h-5" />
            戻る
          </motion.button>

          <motion.button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            whileHover={{ scale: isSubmitting ? 1 : 1.05 }}
            whileTap={{ scale: isSubmitting ? 1 : 0.95 }}
            className="flex items-center gap-2 px-8 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              '作成中...'
            ) : (
              <>
                <Rocket className="w-5 h-5" />
                テナントを作成
              </>
            )}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
