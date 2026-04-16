/**
 * Health Indicator
 *
 * 健全/異常のパルスインジケータ
 */

interface HealthIndicatorProps {
  isHealthy: boolean;
  label?: string;
  size?: 'sm' | 'md';
}

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
};

export function HealthIndicator({
  isHealthy,
  label,
  size = 'md',
}: HealthIndicatorProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`${sizeClasses[size]} rounded-full shrink-0 ${
          isHealthy ? 'bg-hn-success animate-pulse' : 'bg-hn-error'
        }`}
      />
      {label && (
        <span
          className={`text-sm ${isHealthy ? 'text-hn-success' : 'text-hn-error'}`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
