"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  type ProfileData,
  useOnboardingStore,
} from "@/lib/stores/onboarding-store";

const profileSchema = z.object({
  fullName: z.string().min(1, "氏名を入力してください"),
  email: z.string().email("有効なメールアドレスを入力してください"),
  organizationName: z.string().min(1, "組織名を入力してください"),
  purpose: z.string().min(10, "用途を10文字以上で入力してください"),
});

export function ProfileStep() {
  const { profileData, setProfileData, setCurrentStep } = useOnboardingStore();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileData>({
    resolver: zodResolver(profileSchema),
    defaultValues: profileData,
  });

  const onSubmit = (data: ProfileData) => {
    setProfileData(data);
    setCurrentStep("plan");
  };

  return (
    <div className="glass rounded-3xl p-8 max-w-2xl mx-auto">
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold gradient-text mb-2">
            プロフィールを教えてください
          </h2>
          <p className="text-white/60">
            あなたとあなたの組織について教えてください
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <label
              htmlFor="fullName"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              お名前 *
            </label>
            <input
              id="fullName"
              type="text"
              {...register("fullName")}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
              placeholder="山田 太郎"
            />
            {errors.fullName && (
              <p className="mt-1 text-sm text-red-400">
                {errors.fullName.message}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              メールアドレス *
            </label>
            <input
              id="email"
              type="email"
              {...register("email")}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
              placeholder="you@example.com"
            />
            {errors.email && (
              <p className="mt-1 text-sm text-red-400">
                {errors.email.message}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="organizationName"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              組織名 *
            </label>
            <input
              id="organizationName"
              type="text"
              {...register("organizationName")}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors"
              placeholder="株式会社サンプル"
            />
            {errors.organizationName && (
              <p className="mt-1 text-sm text-red-400">
                {errors.organizationName.message}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="purpose"
              className="block text-sm font-medium text-white/80 mb-2"
            >
              TenkaCloud の利用目的 *
            </label>
            <textarea
              id="purpose"
              {...register("purpose")}
              rows={4}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:border-primary-500 transition-colors resize-none"
              placeholder="例: 社内ハッカソンでプログラミングコンテストを開催したい"
            />
            {errors.purpose && (
              <p className="mt-1 text-sm text-red-400">
                {errors.purpose.message}
              </p>
            )}
          </div>

          <motion.button
            type="submit"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-primary-500 to-accent-500 rounded-xl font-semibold shadow-lg shadow-primary-500/25 hover:shadow-primary-500/40 transition-shadow"
          >
            次へ
            <ArrowRight className="w-5 h-5" />
          </motion.button>
        </form>
      </div>
    </div>
  );
}
