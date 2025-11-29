"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { EnvironmentStep } from "@/components/onboarding/environment-step";
import { PlanStep } from "@/components/onboarding/plan-step";
import { ProfileStep } from "@/components/onboarding/profile-step";
import { ReviewStep } from "@/components/onboarding/review-step";
import { TenantStep } from "@/components/onboarding/tenant-step";
import { type Step, useOnboardingStore } from "@/lib/stores/onboarding-store";

const steps: { id: Step; label: string }[] = [
  { id: "profile", label: "プロフィール" },
  { id: "plan", label: "プラン選択" },
  { id: "tenant", label: "テナント設定" },
  { id: "environment", label: "環境設定" },
  { id: "review", label: "確認" },
];

export default function OnboardingPage() {
  const { currentStep } = useOnboardingStore();

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);

  const renderStep = () => {
    switch (currentStep) {
      case "profile":
        return <ProfileStep />;
      case "plan":
        return <PlanStep />;
      case "tenant":
        return <TenantStep />;
      case "environment":
        return <EnvironmentStep />;
      case "review":
        return <ReviewStep />;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen py-12 px-4">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl animate-float"
          style={{ background: "oklch(0.56 0.20 264)" }}
        />
        <div
          className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl animate-float"
          style={{ background: "oklch(0.56 0.20 180)", animationDelay: "-3s" }}
        />
      </div>

      <div className="relative max-w-4xl mx-auto">
        {/* Progress indicator */}
        <div className="mb-12">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => {
              const isCompleted = index < currentStepIndex;
              const isCurrent = index === currentStepIndex;

              return (
                <div key={step.id} className="flex items-center flex-1">
                  <div className="flex flex-col items-center">
                    <motion.div
                      initial={false}
                      animate={{
                        scale: isCurrent ? 1.1 : 1,
                        backgroundColor: isCompleted
                          ? "oklch(0.56 0.20 264)"
                          : isCurrent
                            ? "oklch(0.56 0.20 180)"
                            : "oklch(0.15 0.02 264)",
                      }}
                      className="w-10 h-10 rounded-full flex items-center justify-center border-2 border-white/20 transition-all"
                    >
                      {isCompleted ? (
                        <Check className="w-5 h-5 text-white" />
                      ) : (
                        <span className="text-sm font-semibold">
                          {index + 1}
                        </span>
                      )}
                    </motion.div>
                    <span
                      className={`mt-2 text-sm font-medium ${
                        isCurrent ? "text-white" : "text-white/50"
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>

                  {index < steps.length - 1 && (
                    <div className="flex-1 h-0.5 mx-4 mt-[-2rem]">
                      <div
                        className={`h-full transition-all ${
                          isCompleted ? "bg-primary-500" : "bg-white/10"
                        }`}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Step content */}
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.3 }}
        >
          {renderStep()}
        </motion.div>
      </div>
    </div>
  );
}
