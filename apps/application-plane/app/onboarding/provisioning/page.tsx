'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Cloud, Check, Loader2, Database, Server, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PROVISIONING_STEPS = [
  { id: 'realm', label: '認証基盤の構築', icon: Server },
  { id: 'database', label: 'データベースの作成', icon: Database },
  { id: 'deploy', label: 'アプリケーションのデプロイ', icon: Cloud },
  { id: 'dns', label: 'DNS の設定', icon: Globe },
];

export default function ProvisioningPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= PROVISIONING_STEPS.length - 1) {
          clearInterval(interval);
          setTimeout(() => setCompleted(true), 1000);
          return prev;
        }
        return prev + 1;
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <Link href="/" className="inline-flex items-center gap-2 mb-8">
          <Cloud className="w-8 h-8 text-hn-accent" />
          <span className="font-display text-2xl font-bold">TenkaCloud</span>
        </Link>

        {!completed ? (
          <>
            <h1 className="text-2xl font-bold mb-2">環境を構築中...</h1>
            <p className="text-text-muted mb-8">
              あなたのテナント環境を準備しています
            </p>

            <div className="space-y-4 text-left">
              {PROVISIONING_STEPS.map((step, index) => (
                <div
                  key={step.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border ${
                    index < currentStep
                      ? 'border-hn-success/50 bg-hn-success/5'
                      : index === currentStep
                        ? 'border-hn-accent bg-hn-accent/5'
                        : 'border-border'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      index < currentStep
                        ? 'bg-hn-success text-surface-0'
                        : index === currentStep
                          ? 'bg-hn-accent text-surface-0'
                          : 'bg-surface-2 text-text-muted'
                    }`}
                  >
                    {index < currentStep ? (
                      <Check className="w-4 h-4" />
                    ) : index === currentStep ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <step.icon className="w-4 h-4" />
                    )}
                  </div>
                  <span
                    className={index <= currentStep ? '' : 'text-text-muted'}
                  >
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-hn-success flex items-center justify-center">
              <Check className="w-8 h-8 text-surface-0" />
            </div>
            <h1 className="text-2xl font-bold mb-2">セットアップ完了！</h1>
            <p className="text-text-muted mb-8">
              あなたのテナント環境が準備できました
            </p>
            <Button onClick={() => router.push('/dashboard')} fullWidth>
              ダッシュボードへ
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
