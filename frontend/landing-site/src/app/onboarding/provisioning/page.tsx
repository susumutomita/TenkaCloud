"use client";

import { motion } from "framer-motion";
import { Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ProvisioningStep = {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export default function ProvisioningPage() {
  const router = useRouter();
  const [steps, setSteps] = useState<ProvisioningStep[]>([
    { id: "realm", label: "Keycloak Realm 作成中", status: "pending" },
    { id: "database", label: "データベース作成中", status: "pending" },
    {
      id: "namespace",
      label: "Kubernetes Namespace 作成中",
      status: "pending",
    },
    {
      id: "deployment",
      label: "アプリケーションデプロイ中",
      status: "pending",
    },
    { id: "dns", label: "DNS 設定中", status: "pending" },
  ]);

  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    // Simulate provisioning progress
    const stepDurations = [2000, 2500, 2000, 3000, 1500];
    let currentStep = 0;

    const processNextStep = () => {
      if (currentStep >= steps.length) {
        setIsComplete(true);
        setTimeout(() => {
          router.push("/dashboard");
        }, 2000);
        return;
      }

      // Set current step to in_progress
      setSteps((prev) =>
        prev.map((step, index) =>
          index === currentStep ? { ...step, status: "in_progress" } : step,
        ),
      );

      // Complete current step after duration
      setTimeout(() => {
        setSteps((prev) =>
          prev.map((step, index) =>
            index === currentStep ? { ...step, status: "completed" } : step,
          ),
        );

        currentStep++;
        processNextStep();
      }, stepDurations[currentStep]);
    };

    processNextStep();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
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

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-2xl"
      >
        <div className="glass rounded-3xl p-12 text-center">
          <div className="space-y-8">
            {!isComplete ? (
              <>
                {/* Loading spinner */}
                <div className="flex justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{
                      duration: 2,
                      repeat: Number.POSITIVE_INFINITY,
                      ease: "linear",
                    }}
                    className="w-20 h-20 border-4 border-primary-500/20 border-t-primary-500 rounded-full"
                  />
                </div>

                <div>
                  <h1 className="text-3xl font-bold gradient-text mb-2">
                    環境をセットアップ中...
                  </h1>
                  <p className="text-white/60">
                    このプロセスには数分かかる場合があります
                  </p>
                </div>
              </>
            ) : (
              <>
                {/* Success checkmark */}
                <div className="flex justify-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 200,
                      damping: 15,
                    }}
                    className="w-20 h-20 bg-gradient-to-br from-primary-500 to-accent-500 rounded-full flex items-center justify-center"
                  >
                    <Check className="w-10 h-10 text-white" />
                  </motion.div>
                </div>

                <div>
                  <h1 className="text-3xl font-bold gradient-text mb-2">
                    すべて完了しました！
                  </h1>
                  <p className="text-white/60">
                    ダッシュボードにリダイレクトしています...
                  </p>
                </div>
              </>
            )}

            {/* Progress steps */}
            <div className="space-y-4 pt-8">
              {steps.map((step) => (
                <motion.div
                  key={step.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-4 p-4 bg-white/5 rounded-xl border border-white/10"
                >
                  <div className="flex-shrink-0">
                    {step.status === "completed" ? (
                      <div className="w-6 h-6 bg-accent-500 rounded-full flex items-center justify-center">
                        <Check className="w-4 h-4 text-white" />
                      </div>
                    ) : step.status === "in_progress" ? (
                      <Loader2 className="w-6 h-6 text-primary-400 animate-spin" />
                    ) : (
                      <div className="w-6 h-6 border-2 border-white/20 rounded-full" />
                    )}
                  </div>

                  <div className="flex-1 text-left">
                    <p
                      className={`font-medium ${
                        step.status === "completed"
                          ? "text-white"
                          : step.status === "in_progress"
                            ? "text-primary-400"
                            : "text-white/50"
                      }`}
                    >
                      {step.label}
                    </p>
                  </div>

                  {step.status === "completed" && (
                    <span className="text-xs text-accent-400">完了</span>
                  )}
                  {step.status === "in_progress" && (
                    <span className="text-xs text-primary-400">処理中</span>
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
