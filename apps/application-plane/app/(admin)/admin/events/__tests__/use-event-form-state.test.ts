import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  buildPayload,
  CLOUD_PROVIDER_OPTIONS,
  DEFAULT_FORM_STATE,
  findOption,
  PARTICIPANT_TYPE_OPTIONS,
  SCORING_TYPE_OPTIONS,
  STATUS_OPTIONS,
  TIMEZONE_OPTIONS,
  TYPE_OPTIONS,
  useEventFormState,
  validateEventForm,
} from '../use-event-form-state';

describe('useEventFormState フック', () => {
  it('デフォルト値で初期化されるべき', () => {
    const { result } = renderHook(() => useEventFormState());
    expect(result.current.form.name).toBe('');
    expect(result.current.form.type).toEqual(TYPE_OPTIONS[0]);
    expect(result.current.form.status).toEqual(STATUS_OPTIONS[0]);
    expect(result.current.form.maxParticipants).toBe('100');
    expect(result.current.errors).toEqual({});
    expect(result.current.submitting).toBe(false);
    expect(result.current.serverError).toBeNull();
  });

  it('カスタム初期値で初期化されるべき', () => {
    const custom = {
      ...DEFAULT_FORM_STATE,
      name: 'テスト',
      maxParticipants: '50',
    };
    const { result } = renderHook(() => useEventFormState(custom));
    expect(result.current.form.name).toBe('テスト');
    expect(result.current.form.maxParticipants).toBe('50');
  });

  it('setField でフォーム値を更新できるべき', () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', '新しいイベント');
    });
    expect(result.current.form.name).toBe('新しいイベント');
  });

  it('setField で Select オプションを更新できるべき', () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('type', TYPE_OPTIONS[1]);
    });
    expect(result.current.form.type).toEqual(TYPE_OPTIONS[1]);
  });

  it('setField で全フィールドを個別に更新できるべき', () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('startTime', '2026-05-01');
      result.current.setField('endTime', '2026-05-02');
      result.current.setField('timezone', TIMEZONE_OPTIONS[1]);
      result.current.setField('participantType', PARTICIPANT_TYPE_OPTIONS[1]);
      result.current.setField('cloudProvider', CLOUD_PROVIDER_OPTIONS[1]);
      result.current.setField('maxParticipants', '500');
      result.current.setField('scoringType', SCORING_TYPE_OPTIONS[1]);
      result.current.setField('status', STATUS_OPTIONS[1]);
    });
    expect(result.current.form.startTime).toBe('2026-05-01');
    expect(result.current.form.endTime).toBe('2026-05-02');
    expect(result.current.form.timezone).toEqual(TIMEZONE_OPTIONS[1]);
    expect(result.current.form.participantType).toEqual(
      PARTICIPANT_TYPE_OPTIONS[1],
    );
    expect(result.current.form.cloudProvider).toEqual(
      CLOUD_PROVIDER_OPTIONS[1],
    );
    expect(result.current.form.maxParticipants).toBe('500');
    expect(result.current.form.scoringType).toEqual(SCORING_TYPE_OPTIONS[1]);
    expect(result.current.form.status).toEqual(STATUS_OPTIONS[1]);
  });

  it('名前が空の場合にバリデーションエラーを返すべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit(async () => ({}));
    });
    expect(ok).toBe(false);
    expect(result.current.errors.name).toBe('イベント名は必須です');
  });

  it('終了日が開始日より前の場合にバリデーションエラーを返すべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', 'テスト');
      result.current.setField('startTime', '2026-05-10');
      result.current.setField('endTime', '2026-05-01');
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit(async () => ({}));
    });
    expect(ok).toBe(false);
    expect(result.current.errors.endTime).toBe(
      '終了日は開始日より後に設定してください',
    );
  });

  it('バリデーション成功時に API を呼び出して true を返すべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', 'テストイベント');
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit(async () => ({ id: 'evt-1' }));
    });
    expect(ok).toBe(true);
    expect(result.current.errors).toEqual({});
    expect(result.current.serverError).toBeNull();
  });

  it('API エラー時に serverError をセットして false を返すべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', 'テスト');
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit(async () => {
        throw new Error('サーバーエラー');
      });
    });
    expect(ok).toBe(false);
    expect(result.current.serverError).toBe('サーバーエラー');
  });

  it('Error 以外の例外時にデフォルトエラーメッセージを返すべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', 'テスト');
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.submit(async () => {
        throw 'string error';
      });
    });
    expect(ok).toBe(false);
    expect(result.current.serverError).toBe('エラーが発生しました');
  });

  it('submit 完了後に submitting が false になるべき', async () => {
    const { result } = renderHook(() => useEventFormState());
    act(() => {
      result.current.setField('name', 'テスト');
    });
    await act(async () => {
      await result.current.submit(async () => ({ id: 'evt-1' }));
    });
    expect(result.current.submitting).toBe(false);
  });
});

describe('validateEventForm', () => {
  it('名前が空の場合にエラーを返すべき', () => {
    expect(validateEventForm({ ...DEFAULT_FORM_STATE, name: '' }).name).toBe(
      'イベント名は必須です',
    );
  });

  it('空白のみの名前にエラーを返すべき', () => {
    expect(validateEventForm({ ...DEFAULT_FORM_STATE, name: '   ' }).name).toBe(
      'イベント名は必須です',
    );
  });

  it('正常な名前にはエラーを返さないべき', () => {
    expect(
      validateEventForm({ ...DEFAULT_FORM_STATE, name: 'テスト' }).name,
    ).toBeUndefined();
  });

  it('終了日が開始日以前の場合にエラーを返すべき', () => {
    expect(
      validateEventForm({
        ...DEFAULT_FORM_STATE,
        name: 'テスト',
        startTime: '2026-05-10',
        endTime: '2026-05-01',
      }).endTime,
    ).toBe('終了日は開始日より後に設定してください');
  });

  it('終了日が開始日と同じ場合にエラーを返すべき', () => {
    expect(
      validateEventForm({
        ...DEFAULT_FORM_STATE,
        name: 'テスト',
        startTime: '2026-05-10',
        endTime: '2026-05-10',
      }).endTime,
    ).toBe('終了日は開始日より後に設定してください');
  });

  it('開始日が空の場合に終了日エラーを返さないべき', () => {
    expect(
      validateEventForm({
        ...DEFAULT_FORM_STATE,
        name: 'テスト',
        startTime: '',
        endTime: '2026-05-01',
      }).endTime,
    ).toBeUndefined();
  });

  it('終了日が空の場合にエラーを返さないべき', () => {
    expect(
      validateEventForm({
        ...DEFAULT_FORM_STATE,
        name: 'テスト',
        startTime: '2026-05-01',
        endTime: '',
      }).endTime,
    ).toBeUndefined();
  });
});

describe('findOption', () => {
  it('値にマッチするオプションを返すべき', () => {
    expect(findOption(TYPE_OPTIONS, 'jam')).toEqual({
      label: 'Challenge',
      value: 'jam',
    });
  });

  it('マッチしない場合に null を返すべき', () => {
    expect(findOption(TYPE_OPTIONS, 'unknown')).toBeNull();
  });

  it('value が undefined の場合に null を返すべき', () => {
    expect(findOption(TYPE_OPTIONS, undefined)).toBeNull();
  });

  it('value が空文字の場合に null を返すべき', () => {
    expect(findOption(TYPE_OPTIONS, '')).toBeNull();
  });
});

describe('buildPayload', () => {
  it('フォーム状態からペイロードを正しく構築すべき', () => {
    expect(buildPayload(DEFAULT_FORM_STATE)).toEqual({
      name: '',
      type: 'gameday',
      status: 'draft',
      startTime: '',
      endTime: '',
      timezone: 'Asia/Tokyo',
      participantType: 'individual',
      cloudProvider: 'aws',
      maxParticipants: 100,
      scoringType: 'realtime',
    });
  });

  it('null オプションの場合に undefined を返すべき', () => {
    const payload = buildPayload({
      ...DEFAULT_FORM_STATE,
      type: null,
      status: null,
    });
    expect(payload.type).toBeUndefined();
    expect(payload.status).toBeUndefined();
  });
});

describe('定数オプション', () => {
  it('TYPE_OPTIONS に gameday と jam が含まれるべき', () => {
    expect(TYPE_OPTIONS).toHaveLength(2);
  });
  it('STATUS_OPTIONS に draft と scheduled が含まれるべき', () => {
    expect(STATUS_OPTIONS).toHaveLength(2);
  });
  it('PARTICIPANT_TYPE_OPTIONS に individual と team が含まれるべき', () => {
    expect(PARTICIPANT_TYPE_OPTIONS).toHaveLength(2);
  });
  it('CLOUD_PROVIDER_OPTIONS に 4 つのプロバイダーが含まれるべき', () => {
    expect(CLOUD_PROVIDER_OPTIONS).toHaveLength(4);
  });
  it('SCORING_TYPE_OPTIONS に realtime と batch が含まれるべき', () => {
    expect(SCORING_TYPE_OPTIONS).toHaveLength(2);
  });
  it('TIMEZONE_OPTIONS に 4 つのタイムゾーンが含まれるべき', () => {
    expect(TIMEZONE_OPTIONS).toHaveLength(4);
  });
});
