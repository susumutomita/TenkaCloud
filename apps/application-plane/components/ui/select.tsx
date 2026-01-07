/**
 * Select Component
 *
 * フォーム選択用コンポーネント
 */

import { forwardRef, useId, type SelectHTMLAttributes } from 'react';

type SelectVariant = 'default' | 'error';
type SelectSize = 'sm' | 'md' | 'lg';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'size'
> {
  options: SelectOption[];
  variant?: SelectVariant;
  size?: SelectSize;
  label?: string;
  error?: string;
  placeholder?: string;
}

const variantClasses: Record<SelectVariant, string> = {
  default: 'border-gray-300 focus:border-blue-500 focus:ring-blue-500',
  error: 'border-red-500 focus:border-red-500 focus:ring-red-500',
};

const sizeClasses: Record<SelectSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-4 py-3 text-lg',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      options,
      variant = 'default',
      size = 'md',
      label,
      error,
      placeholder,
      className = '',
      id,
      required,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = id || generatedId;

    // error があれば error variant を適用
    const effectiveVariant = error ? 'error' : variant;

    const baseClasses =
      'block w-full rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed transition-colors appearance-none bg-no-repeat bg-right pr-10';

    // Custom dropdown arrow using CSS
    const arrowStyle = {
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236B7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`,
      backgroundSize: '1.5rem',
      backgroundPosition: 'right 0.5rem center',
    };

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            {label}
            {required && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`${baseClasses} ${variantClasses[effectiveVariant]} ${sizeClasses[size]} ${className}`}
          style={arrowStyle}
          required={required}
          disabled={disabled}
          {...props}
        >
          {placeholder && (
            <option value="" disabled={required}>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
      </div>
    );
  }
);

Select.displayName = 'Select';
