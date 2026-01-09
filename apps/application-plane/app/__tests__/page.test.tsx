import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Home from '../page';

describe('Participant App ホームページ', () => {
  it('ページタイトル「TenkaCloud」が表示されるべき', () => {
    render(<Home />);
    const title = screen.getByText('TenkaCloud');
    expect(title).toBeInTheDocument();
  });

  it('サブタイトル「クラウド天下一武道会」が表示されるべき', () => {
    render(<Home />);
    const subtitle = screen.getByText('クラウド天下一武道会');
    expect(subtitle).toBeInTheDocument();
  });

  it('キャッチフレーズ「最強のクラウドエンジニアを目指せ」が表示されるべき', () => {
    render(<Home />);
    const catchphrase = screen.getByText('最強のクラウドエンジニアを目指せ');
    expect(catchphrase).toBeInTheDocument();
  });

  it('「バトルに参加する」ボタンが /events へのリンクを持つべき', () => {
    render(<Home />);
    const joinButton = screen.getByRole('button', { name: 'バトルに参加する' });
    expect(joinButton).toBeInTheDocument();
    const link = joinButton.closest('a');
    expect(link).toHaveAttribute('href', '/events');
  });

  it('「観戦モード」ボタンが /events へのリンクを持つべき', () => {
    render(<Home />);
    const spectateButton = screen.getByRole('button', { name: '観戦モード' });
    expect(spectateButton).toBeInTheDocument();
    const link = spectateButton.closest('a');
    expect(link).toHaveAttribute('href', '/events');
  });

  it('統計情報のプレースホルダーが3つ表示されるべき（API 接続前）', () => {
    render(<Home />);
    // API 接続前はプレースホルダー値「---」が表示される
    const placeholders = screen.getAllByText('---');
    expect(placeholders).toHaveLength(3);
  });

  it.each(['Status', 'Participants', 'Problems'])(
    '統計ラベル「%s」が表示されるべき',
    (label) => {
      render(<Home />);
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  );
});
