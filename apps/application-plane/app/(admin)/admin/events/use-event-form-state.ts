/**
 * useEventFormState Hook
 *
 * イベント作成・編集フォームの状態管理
 */

import type { SelectProps } from '@cloudscape-design/components/select';
import { useCallback, useState } from 'react';

// =============================================================================
// Options
// =============================================================================

export const TYPE_OPTIONS: SelectProps.Options = [
  { label: 'GameDay', value: 'gameday' },
  { label: 'Jam', value: 'jam' },
];

export const STATUS_OPTIONS: SelectProps.Options = [
  { label: '下書き', value: 'draft' },
  { label: '予定', value: 'scheduled' },
];

export const PARTICIPANT_TYPE_OPTIONS: SelectProps.Options = [
  { label: '個人', value: 'individual' },
  { label: 'チーム', value: 'team' },
];

export const CLOUD_PROVIDER_OPTIONS: SelectProps.Options = [
  { label: 'AWS', value: 'aws' },
  { label: 'GCP', value: 'gcp' },
  { label: 'Azure', value: 'azure' },
  { label: 'ローカル', value: 'local' },
];

export const SCORING_TYPE_OPTIONS: SelectProps.Options = [
  { label: 'リアルタイム', value: 'realtime' },
  { label: 'バッチ', value: 'batch' },
];

export const TIMEZONE_OPTIONS: SelectProps.Options = [
  { label: 'Asia/Tokyo (JST)', value: 'Asia/Tokyo' },
  { label: 'UTC', value: 'UTC' },
  { label: 'America/New_York (EST)', value: 'America/New_York' },
  { label: 'Europe/London (GMT)', value: 'Europe/London' },
];

// =============================================================================
// Types
// =============================================================================

export interface EventFormState {
  name: string;
  type: SelectProps.Option | null;
  status: SelectProps.Option | null;
  startTime: string;
  endTime: string;
  timezone: SelectProps.Option | null;
  participantType: SelectProps.Option | null;
  cloudProvider: SelectProps.Option | null;
  maxParticipants: string;
  scoringType: SelectProps.Option | null;
}

export interface EventFormErrors {
  name?: string;
  endTime?: string;
}

// =============================================================================
// Helpers
// =============================================================================

export function findOption(
  options: SelectProps.Options,
  value: string | undefined,
): SelectProps.Option | null {
  if (!value) return null;
  return (
    (options as SelectProps.Option[]).find((o) => o.value === value) ?? null
  );
}

export function buildPayload(form: EventFormState) {
  return {
    name: form.name,
    type: form.type?.value,
    status: form.status?.value,
    startTime: form.startTime,
    endTime: form.endTime,
    timezone: form.timezone?.value,
    participantType: form.participantType?.value,
    cloudProvider: form.cloudProvider?.value,
    maxParticipants: Number(form.maxParticipants),
    scoringType: form.scoringType?.value,
  };
}

export function validateEventForm(form: EventFormState): EventFormErrors {
  const errs: EventFormErrors = {};
  if (!form.name.trim()) {
    errs.name = 'イベント名は必須です';
  }
  if (form.startTime && form.endTime && form.endTime <= form.startTime) {
    errs.endTime = '終了日は開始日より後に設定してください';
  }
  return errs;
}

export const DEFAULT_FORM_STATE: EventFormState = {
  name: '',
  type: TYPE_OPTIONS[0],
  status: STATUS_OPTIONS[0],
  startTime: '',
  endTime: '',
  timezone: TIMEZONE_OPTIONS[0],
  participantType: PARTICIPANT_TYPE_OPTIONS[0],
  cloudProvider: CLOUD_PROVIDER_OPTIONS[0],
  maxParticipants: '100',
  scoringType: SCORING_TYPE_OPTIONS[0],
};

export interface UseEventFormStateReturn {
  form: EventFormState;
  errors: EventFormErrors;
  submitting: boolean;
  serverError: string | null;
  setField: <K extends keyof EventFormState>(
    key: K,
    value: EventFormState[K],
  ) => void;
  submit: (apiCall: () => Promise<unknown>) => Promise<boolean>;
}

export function useEventFormState(
  initialState: EventFormState = DEFAULT_FORM_STATE,
): UseEventFormStateReturn {
  const [form, setForm] = useState<EventFormState>(initialState);
  const [errors, setErrors] = useState<EventFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const setField = useCallback(
    <K extends keyof EventFormState>(key: K, value: EventFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const submit = useCallback(
    async (apiCall: () => Promise<unknown>): Promise<boolean> => {
      const validationErrors = validateEventForm(form);
      setErrors(validationErrors);
      if (Object.keys(validationErrors).length > 0) return false;

      try {
        setSubmitting(true);
        setServerError(null);
        await apiCall();
        return true;
      } catch (err) {
        setServerError(
          err instanceof Error ? err.message : 'エラーが発生しました',
        );
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [form],
  );

  return { form, errors, submitting, serverError, setField, submit };
}
