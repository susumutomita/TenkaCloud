/**
 * Input Component
 *
 * フォーム入力用コンポーネント
 */

import { forwardRef, useId, type InputHTMLAttributes } from 'react';

type InputVariant = 'default' | 'error';
type InputSize = 'sm' | 'md' | 'lg';

interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  variant?: InputVariant;
  size?: InputSize;
  label?: string;
  error?: string;
}

const variantClasses: Record<InputVariant, string> = {
  default: 'border-gray-300 focus:border-blue-500 focus:ring-blue-500',
  error: 'border-red-500 focus:border-red-500 focus:ring-red-500',
};

const sizeClasses: Record<InputSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-4 py-3 text-lg',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      variant = 'default',
      size = 'md',
      label,
      error,
      className = '',
      id,
      required,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const inputId = id || generatedId;

    // error があれば error variant を適用
    const effectiveVariant = error ? 'error' : variant;

    const baseClasses =
      'block w-full rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[size]} ${className}`}
          required={required}
          disabled={disabled}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
