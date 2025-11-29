/**
 * Progress Component
 *
 * 進捗バーコンポーネント
 */

interface ProgressProps {
  value: number;
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'warning' | 'danger';
  showLabel?: boolean;
  className?: string;
}

const sizeClasses = {
  sm: 'h-1',
  md: 'h-2',
  lg: 'h-4',
};

const variantClasses = {
  default: 'bg-blue-600',
  success: 'bg-green-600',
  warning: 'bg-yellow-600',
  danger: 'bg-red-600',
};

export function Progress({
  value,
  max = 100,
  size = 'md',
  variant = 'default',
  showLabel = false,
  className = '',
}: ProgressProps) {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  return (
    <div className={`w-full ${className}`}>
      {showLabel && (
        <div className="flex justify-between text-sm text-gray-600 mb-1">
          <span>
            {value} / {max}
          </span>
          <span>{Math.round(percentage)}%</span>
        </div>
      )}
      <div
        className={`w-full bg-gray-200 rounded-full overflow-hidden ${sizeClasses[size]}`}
      >
        <div
          className={`${sizeClasses[size]} ${variantClasses[variant]} transition-all duration-300 rounded-full`}
          style={{ width: `${percentage}%` }}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
        />
      </div>
    </div>
  );
}

// Score Progress with color based on percentage
export function ScoreProgress({
  score,
  maxScore,
  size = 'md',
  showLabel = true,
  className = '',
}: {
  score: number;
  maxScore: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}) {
  const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;

  let variant: 'default' | 'success' | 'warning' | 'danger' = 'default';
  if (percentage >= 80) {
    variant = 'success';
  } else if (percentage >= 50) {
    variant = 'warning';
  } else if (percentage > 0) {
    variant = 'danger';
  }

  return (
    <Progress
      value={score}
      max={maxScore}
      size={size}
      variant={variant}
      showLabel={showLabel}
      className={className}
    />
  );
}
