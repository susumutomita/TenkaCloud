"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  type TenantData,
  useOnboardingStore,
} from "@/lib/stores/onboarding-store";

const tenantSchema = z.object({
  name: z.string().min(1, "テナント名を入力してください"),
  slug: z
    .string()
    .min(3, "スラッグは3文字以上必要です")
    .regex(/^[a-z0-9-]+$/, "小文字英数字とハイフンのみ使用できます"),
  region: z.string().min(1, "リージョンを選択してください"),
});

const regions = [
  { value: "ap-northeast-1", label: "東京 (ap-northeast-1)" },
  { value: "us-west-2", label: "オレゴン (us-west-2)" },
  { value: "eu-west-1", label: "アイルランド (eu-west-1)" },
  { value: "ap-southeast-1", label: "シンガポール (ap-southeast-1)" },
];

export function TenantStep() {
  const { tenantData, setTenantData, setCurrentStep } = useOnboardingStore();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<TenantData>({
    resolver: zodResolver(tenantSchema),
    defaultValues: tenantData,
  });

  const onSubmit = (data: TenantData) => {
    setTenantData(data);
    setCurrentStep("environment");
  };

  const handleBack = () => {
    setCurrentStep("plan");
  };

  // Auto-generate slug from name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const slug = e.target.value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const slugInput = document.getElementById("slug") as HTMLInputElement;
    if (slugInput && !slugInput.value) {
      slugInput.value = slug;
    }
  };

  return (
    <div className="glass rounded-3xl p-8 max-w-2xl mx-auto">
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold gradient-text mb-2">
            テナント設定
          </h2>
          <p className="text-white/60">あなたの環境に名前をつけましょう</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              テナント名 *
            </label>
            <input
              id="name"
              type="text"
              {...register("name")}
              onChange={(e) => {
                register("name").onChange(e);
                handleNameChange(e);
              }}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
              placeholder="My Awesome Contest"
            />
            {errors.name && (
              <p className="mt-1 text-sm text-red-400">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="slug"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              スラッグ (URL) *
            </label>
            <div className="flex items-center gap-2">
              <span className="text-white/60 text-sm">https://</span>
              <input
                id="slug"
                type="text"
                {...register("slug")}
                className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
                placeholder="my-awesome-contest"
              />
              <span className="text-white/60 text-sm">.tenkacloud.io</span>
            </div>
            {errors.slug && (
              <p className="mt-1 text-sm text-red-400">{errors.slug.message}</p>
            )}
            <p className="mt-1 text-xs text-white/50">
              小文字英数字とハイフンのみ使用できます
            </p>
          </div>

          <div>
            <label
              htmlFor="region"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              リージョン *
            </label>
            <select
              id="region"
              {...register("region")}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
            >
              <option value="">選択してください</option>
              {regions.map((region) => (
                <option
                  key={region.value}
                  value={region.value}
                  className="bg-gray-900"
                >
                  {region.label}
                </option>
              ))}
            </select>
            {errors.region && (
              <p className="mt-1 text-sm text-red-400">
                {errors.region.message}
              </p>
            )}
            <p className="mt-1 text-xs text-white/50">
              あなたの参加者に最も近いリージョンを選択してください
            </p>
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
              type="submit"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow"
            >
              次へ
              <ArrowRight className="w-5 h-5" />
            </motion.button>
          </div>
        </form>
      </div>
    </div>
  );
}
