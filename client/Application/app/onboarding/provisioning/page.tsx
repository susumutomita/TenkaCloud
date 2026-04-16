'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Cloud, Check, Loader2, Database, Server, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PROVISIONING_STEPS = [
  {
    id: 'realm',
    label: '\u8a8d\u8a3c\u57fa\u76e4\u306e\u69cb\u7bc9',
    icon: Server,
  },
  {
    id: 'database',
    label: '\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9\u306e\u4f5c\u6210',
    icon: Database,
  },
  {
    id: 'deploy',
    label:
      '\u30a2\u30d7\u30ea\u30b1\u30fc\u30b7\u30e7\u30f3\u306e\u30c7\u30d7\u30ed\u30a4',
    icon: Cloud,
  },
  { id: 'dns', label: 'DNS \u306e\u8a2d\u5b9a', icon: Globe },
];

const STATUS_TO_STEP: Record<string, number> = {
  PENDING: 0,
  AUTH_PROVISIONING: 0,
  DB_PROVISIONING: 1,
  DEPLOYING: 2,
  DNS_CONFIGURING: 3,
  COMPLETED: 4,
  FAILED: -1,
};

export default function ProvisioningPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = searchParams.get('tenantId');
  const [currentStep, setCurrentStep] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [failed, setFailed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollStatus = useCallback(async () => {
    if (!tenantId) return;
    try {
      const response = await fetch(
        `/api/onboarding/status?tenantId=${tenantId}`,
      );
      if (!response.ok) return;
      const data = await response.json();
      const step = STATUS_TO_STEP[data.provisioningStatus] ?? 0;
      if (step === -1) {
        setFailed(true);
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else if (step >= PROVISIONING_STEPS.length) {
        setCurrentStep(PROVISIONING_STEPS.length - 1);
        setCompleted(true);
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else {
        setCurrentStep(step);
      }
    } catch {
      // Silently continue polling
    }
  }, [tenantId]);

  useEffect(() => {
    if (tenantId) {
      // Poll registration status
      pollStatus();
      intervalRef.current = setInterval(pollStatus, 3000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }

    // Fallback: no tenantId, use progressive animation
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
  }, [tenantId, pollStatus]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <Link href="/" className="inline-flex items-center gap-2 mb-8">
          <Cloud className="w-8 h-8 text-hn-accent" />
          <span className="font-display text-2xl font-bold">TenkaCloud</span>
        </Link>

        {failed ? (
          <>
            <h1 className="text-2xl font-bold mb-2">
              {
                '\u30bb\u30c3\u30c8\u30a2\u30c3\u30d7\u306b\u5931\u6557\u3057\u307e\u3057\u305f'
              }
            </h1>
            <p className="text-text-muted mb-8">
              {
                '\u74b0\u5883\u306e\u69cb\u7bc9\u4e2d\u306b\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
              }
            </p>
            <Button onClick={() => router.push('/onboarding')} fullWidth>
              {'\u3084\u308a\u76f4\u3059'}
            </Button>
          </>
        ) : !completed ? (
          <>
            <h1 className="text-2xl font-bold mb-2">
              {'\u74b0\u5883\u3092\u69cb\u7bc9\u4e2d...'}
            </h1>
            <p className="text-text-muted mb-8">
              {
                '\u3042\u306a\u305f\u306e\u30c6\u30ca\u30f3\u30c8\u74b0\u5883\u3092\u6e96\u5099\u3057\u3066\u3044\u307e\u3059'
              }
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
            <h1 className="text-2xl font-bold mb-2">
              {'\u30bb\u30c3\u30c8\u30a2\u30c3\u30d7\u5b8c\u4e86\uff01'}
            </h1>
            <p className="text-text-muted mb-8">
              {
                '\u3042\u306a\u305f\u306e\u30c6\u30ca\u30f3\u30c8\u74b0\u5883\u304c\u6e96\u5099\u3067\u304d\u307e\u3057\u305f'
              }
            </p>
            <Button onClick={() => router.push('/dashboard')} fullWidth>
              {'\u30c0\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9\u3078'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
