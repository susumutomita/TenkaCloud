/**
 * EventForm Component Tests
 *
 * TDD: イベント作成・編集フォームのテスト
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventForm,
  type EventFormProps,
  type EventFormData,
} from '../event-form';

// テストヘルパー: 有効なフォームデータを作成
const createValidFormData = (
  overrides?: Partial<EventFormData>
): EventFormData => ({
  name: 'テストイベント',
  slug: 'test-event',
  description: 'テストイベントの説明です。',
  status: 'draft',
  startDate: '2025-04-01T09:00',
  endDate: '2025-04-01T18:00',
  maxParticipants: 100,
  maxTeamSize: 5,
  isPublic: true,
  ...overrides,
});

// テストヘルパー: デフォルトの props を作成
const createDefaultProps = (
  overrides?: Partial<EventFormProps>
): EventFormProps => ({
  mode: 'create',
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  ...overrides,
});

describe('EventForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('作成モード', () => {
    it('作成モードで空フォームを表示すべき', () => {
      render(<EventForm {...createDefaultProps()} />);

      // フォームが表示されていることを確認
      expect(screen.getByRole('form')).toBeInTheDocument();

      // 必須フィールドが存在することを確認
      expect(screen.getByLabelText(/イベント名/)).toBeInTheDocument();
      expect(screen.getByLabelText(/スラッグ/)).toBeInTheDocument();
      expect(screen.getByLabelText(/開始日時/)).toBeInTheDocument();
      expect(screen.getByLabelText(/終了日時/)).toBeInTheDocument();
      expect(screen.getByLabelText(/最大参加者数/)).toBeInTheDocument();
      expect(screen.getByLabelText(/チーム最大人数/)).toBeInTheDocument();

      // オプションフィールドが存在することを確認
      expect(screen.getByLabelText(/説明/)).toBeInTheDocument();
      expect(screen.getByLabelText(/ステータス/)).toBeInTheDocument();
      expect(screen.getByLabelText(/公開/)).toBeInTheDocument();

      // 作成ボタンが表示されていることを確認
      expect(screen.getByRole('button', { name: /作成/ })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /キャンセル/ })
      ).toBeInTheDocument();
    });

    it('作成モードで初期値がデフォルト値であるべき', () => {
      render(<EventForm {...createDefaultProps()} />);

      // ステータスのデフォルト値
      const statusSelect = screen.getByLabelText(
        /ステータス/
      ) as HTMLSelectElement;
      expect(statusSelect.value).toBe('draft');

      // 公開フラグのデフォルト値
      const isPublicCheckbox = screen.getByLabelText(
        /公開/
      ) as HTMLInputElement;
      expect(isPublicCheckbox.checked).toBe(true);
    });
  });

  describe('編集モード', () => {
    it('編集モードで初期値を表示すべき', () => {
      const initialData = createValidFormData({
        name: '既存イベント',
        slug: 'existing-event',
        status: 'active',
        isPublic: false,
      });

      render(
        <EventForm
          {...createDefaultProps({
            mode: 'edit',
            initialData,
          })}
        />
      );

      // 初期値が表示されていることを確認
      expect(screen.getByDisplayValue('既存イベント')).toBeInTheDocument();
      expect(screen.getByDisplayValue('existing-event')).toBeInTheDocument();

      const statusSelect = screen.getByLabelText(
        /ステータス/
      ) as HTMLSelectElement;
      expect(statusSelect.value).toBe('active');

      const isPublicCheckbox = screen.getByLabelText(
        /公開/
      ) as HTMLInputElement;
      expect(isPublicCheckbox.checked).toBe(false);

      // 更新ボタンが表示されていることを確認
      expect(screen.getByRole('button', { name: /更新/ })).toBeInTheDocument();
    });
  });

  describe('バリデーション', () => {
    it('必須フィールドのバリデーションすべき', async () => {
      const onSubmit = vi.fn();
      render(<EventForm {...createDefaultProps({ onSubmit })} />);

      // 空のまま送信
      fireEvent.click(screen.getByRole('button', { name: /作成/ }));

      await waitFor(() => {
        // エラーメッセージが表示されることを確認
        expect(screen.getByText(/イベント名は必須です/)).toBeInTheDocument();
        expect(screen.getByText(/スラッグは必須です/)).toBeInTheDocument();
        expect(screen.getByText(/開始日時は必須です/)).toBeInTheDocument();
        expect(screen.getByText(/終了日時は必須です/)).toBeInTheDocument();
      });

      // onSubmit が呼ばれないことを確認
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('イベント名の長さをバリデーションすべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      const nameInput = screen.getByLabelText(/イベント名/);

      // 2文字（短すぎる）
      await userEvent.type(nameInput, 'AB');
      fireEvent.blur(nameInput);

      await waitFor(() => {
        expect(
          screen.getByText(/イベント名は3文字以上100文字以下/)
        ).toBeInTheDocument();
      });

      // 有効な値（3文字以上）
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'ABC');
      fireEvent.blur(nameInput);

      await waitFor(() => {
        expect(
          screen.queryByText(/イベント名は3文字以上100文字以下/)
        ).not.toBeInTheDocument();
      });

      // 100文字超過は maxLength 属性で制限される
      expect(nameInput).toHaveAttribute('maxLength', '100');
    });

    it('slug フォーマットをバリデーションすべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      const slugInput = screen.getByLabelText(/スラッグ/);

      // 無効な文字（日本語）
      await userEvent.type(slugInput, 'テスト');
      fireEvent.blur(slugInput);

      await waitFor(() => {
        expect(
          screen.getByText(/スラッグは英数字とハイフンのみ/)
        ).toBeInTheDocument();
      });

      // 無効な文字（スペース）
      await userEvent.clear(slugInput);
      await userEvent.type(slugInput, 'test event');
      fireEvent.blur(slugInput);

      await waitFor(() => {
        expect(
          screen.getByText(/スラッグは英数字とハイフンのみ/)
        ).toBeInTheDocument();
      });

      // 無効な文字（大文字）
      await userEvent.clear(slugInput);
      await userEvent.type(slugInput, 'Test-Event');
      fireEvent.blur(slugInput);

      await waitFor(() => {
        expect(
          screen.getByText(/スラッグは英数字とハイフンのみ/)
        ).toBeInTheDocument();
      });

      // 有効な値
      await userEvent.clear(slugInput);
      await userEvent.type(slugInput, 'test-event-123');
      fireEvent.blur(slugInput);

      await waitFor(() => {
        expect(
          screen.queryByText(/スラッグは英数字とハイフンのみ/)
        ).not.toBeInTheDocument();
      });
    });

    it('日付範囲をバリデーションすべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      const startDateInput = screen.getByLabelText(/開始日時/);
      const endDateInput = screen.getByLabelText(/終了日時/);

      // 終了日時が開始日時より前
      await userEvent.type(startDateInput, '2025-04-02T10:00');
      await userEvent.type(endDateInput, '2025-04-01T10:00');
      fireEvent.blur(endDateInput);

      await waitFor(() => {
        expect(
          screen.getByText(/終了日時は開始日時より後/)
        ).toBeInTheDocument();
      });

      // 有効な日付範囲
      await userEvent.clear(endDateInput);
      await userEvent.type(endDateInput, '2025-04-03T10:00');
      fireEvent.blur(endDateInput);

      await waitFor(() => {
        expect(
          screen.queryByText(/終了日時は開始日時より後/)
        ).not.toBeInTheDocument();
      });
    });

    it('最大参加者数をバリデーションすべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      const maxParticipantsInput = screen.getByLabelText(/最大参加者数/);

      // 0（無効）
      await userEvent.type(maxParticipantsInput, '0');
      fireEvent.blur(maxParticipantsInput);

      await waitFor(() => {
        expect(
          screen.getByText(/最大参加者数は1以上10000以下/)
        ).toBeInTheDocument();
      });

      // 10001（無効）
      await userEvent.clear(maxParticipantsInput);
      await userEvent.type(maxParticipantsInput, '10001');
      fireEvent.blur(maxParticipantsInput);

      await waitFor(() => {
        expect(
          screen.getByText(/最大参加者数は1以上10000以下/)
        ).toBeInTheDocument();
      });
    });

    it('チーム最大人数をバリデーションすべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      const maxTeamSizeInput = screen.getByLabelText(/チーム最大人数/);

      // 0（無効）
      await userEvent.type(maxTeamSizeInput, '0');
      fireEvent.blur(maxTeamSizeInput);

      await waitFor(() => {
        expect(
          screen.getByText(/チーム最大人数は1以上100以下/)
        ).toBeInTheDocument();
      });

      // 101（無効）
      await userEvent.clear(maxTeamSizeInput);
      await userEvent.type(maxTeamSizeInput, '101');
      fireEvent.blur(maxTeamSizeInput);

      await waitFor(() => {
        expect(
          screen.getByText(/チーム最大人数は1以上100以下/)
        ).toBeInTheDocument();
      });
    });

    it('説明の長さ制限を持つべき', () => {
      render(<EventForm {...createDefaultProps()} />);

      const descriptionInput = screen.getByLabelText(/説明/);

      // 2000文字超過は maxLength 属性で制限される
      expect(descriptionInput).toHaveAttribute('maxLength', '2000');
    });
  });

  describe('送信', () => {
    it('送信時に onSubmit を呼ぶべき', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      render(<EventForm {...createDefaultProps({ onSubmit })} />);

      // フォームを入力
      await userEvent.type(
        screen.getByLabelText(/イベント名/),
        'テストイベント'
      );
      await userEvent.type(screen.getByLabelText(/スラッグ/), 'test-event');
      await userEvent.type(
        screen.getByLabelText(/開始日時/),
        '2025-04-01T09:00'
      );
      await userEvent.type(
        screen.getByLabelText(/終了日時/),
        '2025-04-01T18:00'
      );
      await userEvent.type(screen.getByLabelText(/最大参加者数/), '100');
      await userEvent.type(screen.getByLabelText(/チーム最大人数/), '5');

      // 送信
      fireEvent.click(screen.getByRole('button', { name: /作成/ }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'テストイベント',
            slug: 'test-event',
            startDate: '2025-04-01T09:00',
            endDate: '2025-04-01T18:00',
            maxParticipants: 100,
            maxTeamSize: 5,
            status: 'draft',
            isPublic: true,
          })
        );
      });
    });

    it('送信中は submit ボタンを無効化すべき', async () => {
      const onSubmit = vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 100))
        );
      render(
        <EventForm
          {...createDefaultProps({
            onSubmit,
            isSubmitting: true,
          })}
        />
      );

      const submitButton = screen.getByRole('button', { name: /作成/ });
      expect(submitButton).toBeDisabled();
    });

    it('サーバーエラーを表示すべき', () => {
      render(
        <EventForm
          {...createDefaultProps({
            serverError: 'イベントの作成に失敗しました',
          })}
        />
      );

      expect(
        screen.getByText('イベントの作成に失敗しました')
      ).toBeInTheDocument();
    });
  });

  describe('キャンセル', () => {
    it('キャンセル時に onCancel を呼ぶべき', async () => {
      const onCancel = vi.fn();
      render(<EventForm {...createDefaultProps({ onCancel })} />);

      fireEvent.click(screen.getByRole('button', { name: /キャンセル/ }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('アクセシビリティ', () => {
    it('必須フィールドにアスタリスクマークを表示すべき', () => {
      render(<EventForm {...createDefaultProps()} />);

      // 必須フィールドのラベルにアスタリスクがあることを確認
      const nameLabel = screen.getByText(/イベント名/).closest('label');
      expect(nameLabel?.textContent).toContain('*');

      const slugLabel = screen.getByText(/スラッグ/).closest('label');
      expect(slugLabel?.textContent).toContain('*');
    });

    it('エラーがあるフィールドに aria-invalid を設定すべき', async () => {
      render(<EventForm {...createDefaultProps()} />);

      // 空のまま送信
      fireEvent.click(screen.getByRole('button', { name: /作成/ }));

      await waitFor(() => {
        const nameInput = screen.getByLabelText(/イベント名/);
        expect(nameInput).toHaveAttribute('aria-invalid', 'true');
      });
    });
  });
});
