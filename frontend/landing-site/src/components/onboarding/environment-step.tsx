"use client";

import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Database, Zap } from "lucide-react";
import { useState } from "react";
import {
  type ComputeType,
  type TenantModel,
  useOnboardingStore,
} from "@/lib/stores/onboarding-store";

export function EnvironmentStep() {
  const { environmentData, setEnvironmentData, setCurrentStep } =
    useOnboardingStore();

  const [model, setModel] = useState<TenantModel | null>(
    environmentData.model || null,
  );
  const [compute, setCompute] = useState<ComputeType | null>(
    environmentData.compute || null,
  );

  const handleNext = () => {
    if (model && compute) {
      setEnvironmentData({ model, compute });
      setCurrentStep("review");
    }
  };

  const handleBack = () => {
    setCurrentStep("tenant");
  };

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold gradient-text mb-2">環境設定</h2>
        <p className="text-white/60">
          リソースモデルとコンピュートタイプを選択してください
        </p>
      </div>

      {/* Tenant Model Selection */}
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-white">テナントモデル</h3>

        <div className="grid md:grid-cols-2 gap-4">
          <motion.button
            type="button"
            onClick={() => setModel("pool")}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-6 rounded-2xl text-left transition-all ${
              model === "pool" ? "glass border-primary-500 glow" : "glass"
            }`}
          >
            {model === "pool" && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center">
                  <Check className="w-4 h-4 text-white" />
                </div>
              </div>
            )}

            <Database className="w-10 h-10 text-accent-400 mb-4" />

            <h4 className="text-lg font-semibold text-white mb-2">
              Pool (共有リソース)
            </h4>
            <p className="text-sm text-white/70 mb-4">
              コストを最小限に抑えた共有リソースモデル
            </p>

            <ul className="space-y-2 text-sm text-white/60">
              <li>✓ 低コスト</li>
              <li>✓ 高速起動</li>
              <li>✓ 小〜中規模イベント向け</li>
            </ul>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => setModel("silo")}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-6 rounded-2xl text-left transition-all ${
              model === "silo" ? "glass border-primary-500 glow" : "glass"
            }`}
          >
            {model === "silo" && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center">
                  <Check className="w-4 h-4 text-white" />
                </div>
              </div>
            )}

            <Database className="w-10 h-10 text-primary-400 mb-4" />

            <h4 className="text-lg font-semibold text-white mb-2">
              Silo (専用リソース)
            </h4>
            <p className="text-sm text-white/70 mb-4">
              完全に分離された専用リソースモデル
            </p>

            <ul className="space-y-2 text-sm text-white/60">
              <li>✓ 完全分離</li>
              <li>✓ 高パフォーマンス</li>
              <li>✓ 大規模イベント向け</li>
            </ul>
          </motion.button>
        </div>
      </div>

      {/* Compute Type Selection */}
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-white">コンピュートタイプ</h3>

        <div className="grid md:grid-cols-2 gap-4">
          <motion.button
            type="button"
            onClick={() => setCompute("serverless")}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-6 rounded-2xl text-left transition-all ${
              compute === "serverless"
                ? "glass border-primary-500 glow"
                : "glass"
            }`}
          >
            {compute === "serverless" && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center">
                  <Check className="w-4 h-4 text-white" />
                </div>
              </div>
            )}

            <Zap className="w-10 h-10 text-accent-400 mb-4" />

            <h4 className="text-lg font-semibold text-white mb-2">
              Serverless
            </h4>
            <p className="text-sm text-white/70 mb-4">
              使用時のみ課金される自動スケーリング
            </p>

            <ul className="space-y-2 text-sm text-white/60">
              <li>✓ ゼロからスケール</li>
              <li>✓ 使用時のみ課金</li>
              <li>✓ 運用不要</li>
            </ul>
          </motion.button>

          <motion.button
            type="button"
            onClick={() => setCompute("kubernetes")}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`relative p-6 rounded-2xl text-left transition-all ${
              compute === "kubernetes"
                ? "glass border-primary-500 glow"
                : "glass"
            }`}
          >
            {compute === "kubernetes" && (
              <div className="absolute top-4 right-4">
                <div className="w-6 h-6 bg-primary-500 rounded-full flex items-center justify-center">
                  <Check className="w-4 h-4 text-white" />
                </div>
              </div>
            )}

            <Zap className="w-10 h-10 text-primary-400 mb-4" />

            <h4 className="text-lg font-semibold text-white mb-2">
              Kubernetes
            </h4>
            <p className="text-sm text-white/70 mb-4">
              予測可能なパフォーマンスで常時稼働
            </p>

            <ul className="space-y-2 text-sm text-white/60">
              <li>✓ 予約リソース</li>
              <li>✓ 安定したパフォーマンス</li>
              <li>✓ 高度なカスタマイズ</li>
            </ul>
          </motion.button>
        </div>
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
          disabled={!model || !compute}
          whileHover={{ scale: model && compute ? 1.05 : 1 }}
          whileTap={{ scale: model && compute ? 0.95 : 1 }}
          className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
        >
          次へ
          <ArrowRight className="w-5 h-5" />
        </motion.button>
      </div>
    </div>
  );
}
