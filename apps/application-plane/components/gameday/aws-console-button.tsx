/**
 * AWS Console Federation Button
 *
 * STS Federation を使用して AWS Console にログインするためのボタン
 * クリック時に API から Federation URL を取得し、新しいタブで開く
 */

'use client';

import Button from '@cloudscape-design/components/button';
import { useCallback, useState } from 'react';

interface AwsConsoleButtonProps {
  eventId: string;
  label?: string;
  variant?: 'primary' | 'normal' | 'link';
  fullWidth?: boolean;
}

export function AwsConsoleButton({
  eventId,
  label = 'AWS Console を開く',
  variant = 'primary',
  fullWidth = false,
}: AwsConsoleButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/participant/events/${encodeURIComponent(eventId)}/aws-console`,
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        url: string;
        expiresAt: string;
      };
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to open AWS Console';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  return (
    <div style={fullWidth ? { width: '100%' } : undefined}>
      <Button
        variant={variant}
        loading={loading}
        onClick={handleClick}
        iconName="external"
        fullWidth={fullWidth}
      >
        {label}
      </Button>
      {error && (
        <div
          style={{
            color: '#d91515',
            fontSize: '12px',
            marginTop: '4px',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
