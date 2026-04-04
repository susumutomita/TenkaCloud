/**
 * EventForm Component
 *
 * イベント作成・編集用フォームコンポーネント
 */

'use client';

import { type ChangeEvent, type FormEvent, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

// =============================================================================
// Types
// =============================================================================

/**
 * イベントステータス
 */
export type EventFormStatus =
  | 'draft'
  | 'upcoming'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'paused';

/**
 * フォームデータ型
 */
export interface EventFormData {
  name: string;
  slug: string;
  description: string;
  status: EventFormStatus;
  startDate: string;
  endDate: string;
  maxParticipants: number;
  maxTeamSize: number;
  isPublic: boolean;
}

/**
 * EventForm Props
 */
export interface EventFormProps {
  mode: 'create' | 'edit';
  initialData?: Partial<EventFormData>;
  onSubmit: (data: EventFormData) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  serverError?: string;
}

/**
 * フォームエラー型
 */
interface FormErrors {
  name?: string;
  slug?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  maxParticipants?: string;
  maxTeamSize?: string;
}

/**
 * フォームの touched 状態
 */
interface FormTouched {
  name?: boolean;
  slug?: boolean;
  description?: boolean;
  startDate?: boolean;
  endDate?: boolean;
  maxParticipants?: boolean;
  maxTeamSize?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const STATUS_OPTIONS = [
  { value: 'draft', label: '下書き' },
  { value: 'upcoming', label: '予定' },
  { value: 'active', label: '開催中' },
  { value: 'completed', label: '終了' },
  { value: 'cancelled', label: 'キャンセル' },
  { value: 'paused', label: '一時停止' },
];

const DEFAULT_VALUES: EventFormData = {
  name: '',
  slug: '',
  description: '',
  status: 'draft',
  startDate: '',
  endDate: '',
  maxParticipants: 0,
  maxTeamSize: 0,
  isPublic: true,
};

// =============================================================================
// Validation
// =============================================================================

/**
 * フォームバリデーション
 */
function validateForm(values: EventFormData): FormErrors {
  const errors: FormErrors = {};

  // イベント名のバリデーション
  if (!values.name.trim()) {
    errors.name = 'イベント名は必須です';
  } else if (values.name.length < 3 || values.name.length > 100) {
    errors.name = 'イベント名は3文字以上100文字以下で入力してください';
  }

  // スラッグのバリデーション
  if (!values.slug.trim()) {
    errors.slug = 'スラッグは必須です';
  } else if (!/^[a-z0-9-]+$/.test(values.slug)) {
    errors.slug = 'スラッグは英数字とハイフンのみ使用できます';
  }

  // 説明のバリデーション
  if (values.description.length > 2000) {
    errors.description = '説明は2000文字以下で入力してください';
  }

  // 開始日時のバリデーション
  if (!values.startDate) {
    errors.startDate = '開始日時は必須です';
  }

  // 終了日時のバリデーション
  if (!values.endDate) {
    errors.endDate = '終了日時は必須です';
  } else if (
    values.startDate &&
    new Date(values.endDate) <= new Date(values.startDate)
  ) {
    errors.endDate = '終了日時は開始日時より後の日時を設定してください';
  }

  // 最大参加者数のバリデーション
  if (values.maxParticipants < 1 || values.maxParticipants > 10000) {
    errors.maxParticipants = '最大参加者数は1以上10000以下で入力してください';
  }

  // チーム最大人数のバリデーション
  if (values.maxTeamSize < 1 || values.maxTeamSize > 100) {
    errors.maxTeamSize = 'チーム最大人数は1以上100以下で入力してください';
  }

  return errors;
}

/**
 * 単一フィールドのバリデーション
 */
function validateField(
  field: keyof FormErrors,
  value: string | number,
  allValues: EventFormData
): string | undefined {
  const testValues = { ...allValues, [field]: value };
  const errors = validateForm(testValues);
  return errors[field];
}

// =============================================================================
// Hook: useEventForm
// =============================================================================

interface UseEventFormReturn {
  values: EventFormData;
  errors: FormErrors;
  touched: FormTouched;
  handleChange: (
    field: keyof EventFormData
  ) => (
    e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => void;
  handleBlur: (field: keyof FormTouched) => () => void;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  isValid: boolean;
}

/**
 * イベントフォームのカスタムフック
 */
export function useEventForm(
  initialData: Partial<EventFormData> | undefined,
  onSubmit: (data: EventFormData) => Promise<void>
): UseEventFormReturn {
  const [values, setValues] = useState<EventFormData>({
    ...DEFAULT_VALUES,
    ...initialData,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState<FormTouched>({});

  const handleChange = useCallback(
    (field: keyof EventFormData) =>
      (
        e: ChangeEvent<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >
      ) => {
        const target = e.target;
        let newValue: string | number | boolean;

        if (target instanceof HTMLInputElement && target.type === 'checkbox') {
          newValue = target.checked;
        } else if (
          target instanceof HTMLInputElement &&
          target.type === 'number'
        ) {
          newValue = target.value === '' ? 0 : parseInt(target.value, 10);
        } else {
          newValue = target.value;
        }

        setValues((prev) => {
          const updated = { ...prev, [field]: newValue };
          return updated;
        });

        // touched されていればリアルタイムでバリデーション
        if (touched[field as keyof FormTouched]) {
          const fieldError = validateField(
            field as keyof FormErrors,
            newValue as string | number,
            { ...values, [field]: newValue }
          );
          setErrors((prev) => ({
            ...prev,
            [field]: fieldError,
          }));
        }
      },
    [values, touched]
  );

  const handleBlur = useCallback(
    (field: keyof FormTouched) => () => {
      setTouched((prev) => ({ ...prev, [field]: true }));

      // blur 時にバリデーション
      const fieldError = validateField(
        field as keyof FormErrors,
        values[field as keyof EventFormData] as string | number,
        values
      );
      setErrors((prev) => ({
        ...prev,
        [field]: fieldError,
      }));
    },
    [values]
  );

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      // 全フィールドを touched に
      const allTouched: FormTouched = {
        name: true,
        slug: true,
        description: true,
        startDate: true,
        endDate: true,
        maxParticipants: true,
        maxTeamSize: true,
      };
      setTouched(allTouched);

      // バリデーション
      const validationErrors = validateForm(values);
      setErrors(validationErrors);

      // エラーがなければ送信
      if (Object.keys(validationErrors).length === 0) {
        await onSubmit(values);
      }
    },
    [values, onSubmit]
  );

  const isValid = Object.keys(validateForm(values)).length === 0;

  return {
    values,
    errors,
    touched,
    handleChange,
    handleBlur,
    handleSubmit,
    isValid,
  };
}

// =============================================================================
// Component: EventForm
// =============================================================================

/**
 * イベントフォームコンポーネント
 */
export function EventForm({
  mode,
  initialData,
  onSubmit,
  onCancel,
  isSubmitting = false,
  serverError,
}: EventFormProps) {
  const { values, errors, touched, handleChange, handleBlur, handleSubmit } =
    useEventForm(initialData, onSubmit);

  const submitLabel = mode === 'create' ? '作成' : '更新';

  return (
    <Card>
      <form role="form" noValidate onSubmit={handleSubmit}>
        <CardHeader>
          <h2 className="text-xl font-semibold">
            {mode === 'create' ? 'イベント作成' : 'イベント編集'}
          </h2>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* サーバーエラー */}
          {serverError && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-600">{serverError}</p>
            </div>
          )}

          {/* イベント名 */}
          <Input
            label="イベント名"
            name="name"
            value={values.name}
            onChange={handleChange('name')}
            onBlur={handleBlur('name')}
            error={touched.name ? errors.name : undefined}
            required
            aria-invalid={touched.name && !!errors.name}
            maxLength={100}
            placeholder="例: クラウドチャレンジ 2025 春"
          />

          {/* スラッグ */}
          <Input
            label="スラッグ"
            name="slug"
            value={values.slug}
            onChange={handleChange('slug')}
            onBlur={handleBlur('slug')}
            error={touched.slug ? errors.slug : undefined}
            required
            aria-invalid={touched.slug && !!errors.slug}
            placeholder="例: cloud-challenge-2025-spring"
          />

          {/* 説明 */}
          <Textarea
            label="説明"
            name="description"
            value={values.description}
            onChange={handleChange('description')}
            onBlur={handleBlur('description')}
            error={touched.description ? errors.description : undefined}
            aria-invalid={touched.description && !!errors.description}
            rows={4}
            maxLength={2000}
            placeholder="イベントの説明を入力してください"
          />

          {/* ステータス */}
          <Select
            label="ステータス"
            name="status"
            value={values.status}
            onChange={handleChange('status')}
            options={STATUS_OPTIONS}
          />

          {/* 日時設定 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 開始日時 */}
            <Input
              label="開始日時"
              name="startDate"
              type="datetime-local"
              value={values.startDate}
              onChange={handleChange('startDate')}
              onBlur={handleBlur('startDate')}
              error={touched.startDate ? errors.startDate : undefined}
              required
              aria-invalid={touched.startDate && !!errors.startDate}
            />

            {/* 終了日時 */}
            <Input
              label="終了日時"
              name="endDate"
              type="datetime-local"
              value={values.endDate}
              onChange={handleChange('endDate')}
              onBlur={handleBlur('endDate')}
              error={touched.endDate ? errors.endDate : undefined}
              required
              aria-invalid={touched.endDate && !!errors.endDate}
            />
          </div>

          {/* 参加者設定 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 最大参加者数 */}
            <Input
              label="最大参加者数"
              name="maxParticipants"
              type="number"
              value={values.maxParticipants || ''}
              onChange={handleChange('maxParticipants')}
              onBlur={handleBlur('maxParticipants')}
              error={
                touched.maxParticipants ? errors.maxParticipants : undefined
              }
              required
              aria-invalid={touched.maxParticipants && !!errors.maxParticipants}
              min={1}
              max={10000}
              placeholder="1-10000"
            />

            {/* チーム最大人数 */}
            <Input
              label="チーム最大人数"
              name="maxTeamSize"
              type="number"
              value={values.maxTeamSize || ''}
              onChange={handleChange('maxTeamSize')}
              onBlur={handleBlur('maxTeamSize')}
              error={touched.maxTeamSize ? errors.maxTeamSize : undefined}
              required
              aria-invalid={touched.maxTeamSize && !!errors.maxTeamSize}
              min={1}
              max={100}
              placeholder="1-100"
            />
          </div>

          {/* 公開設定 */}
          <div className="flex items-center space-x-3">
            <input
              type="checkbox"
              id="isPublic"
              name="isPublic"
              checked={values.isPublic}
              onChange={handleChange('isPublic')}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label
              htmlFor="isPublic"
              className="text-sm font-medium text-gray-700"
            >
              公開
            </label>
          </div>
        </CardContent>

        <CardFooter className="flex justify-end space-x-4">
          <Button type="button" variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting}
            loading={isSubmitting}
          >
            {submitLabel}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
