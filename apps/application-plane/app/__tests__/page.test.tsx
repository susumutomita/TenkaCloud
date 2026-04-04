import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Home from '../page';

describe('Participant App ホームページ', () => {
  it('ヒーローセクションのキャッチコピーが表示されるべき', () => {
    render(<Home />);
    expect(screen.getByText('クラウドスキルを競い')).toBeInTheDocument();
    expect(screen.getByText('高め合う場所')).toBeInTheDocument();
  });

  it('「イベントを探す」リンクが /events へのリンクを持つべき', () => {
    render(<Home />);
    const link = screen.getByRole('link', { name: /イベントを探す/ });
    expect(link).toHaveAttribute('href', '/events');
  });

  it('「ランキングを見る」リンクが /rankings へのリンクを持つべき', () => {
    render(<Home />);
    const links = screen.getAllByRole('link', { name: /ランキングを見る/ });
    expect(links[0]).toHaveAttribute('href', '/rankings');
  });

  describe('統計セクション', () => {
    it.each(['Cloud Providers', 'Problems', 'Auto Grading', 'Engineers'])(
      '統計ラベル「%s」が表示されるべき',
      (label) => {
        render(<Home />);
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    );
  });

  describe('特徴セクション', () => {
    it('「TenkaCloud とは」セクションが表示されるべき', () => {
      render(<Home />);
      expect(screen.getByText('TenkaCloud とは')).toBeInTheDocument();
    });

    it.each([
      'マルチクラウド対応',
      '実践的な課題',
      'チーム or 個人',
      'リアルタイム採点',
    ])('特徴「%s」が表示されるべき', (feature) => {
      render(<Home />);
      expect(screen.getByText(feature)).toBeInTheDocument();
    });
  });

  describe('イベントタイプセクション', () => {
    it('「イベントタイプ」セクションが表示されるべき', () => {
      render(<Home />);
      expect(screen.getByText('イベントタイプ')).toBeInTheDocument();
    });

    it.each(['GameDay', 'Jam'])(
      'イベントタイプ「%s」が表示されるべき',
      (eventType) => {
        render(<Home />);
        expect(screen.getByText(eventType)).toBeInTheDocument();
      }
    );
  });

  it('観戦 CTA セクションが表示されるべき', () => {
    render(<Home />);
    expect(screen.getByText('まずは観戦してみよう')).toBeInTheDocument();
  });

  it('フッターが表示されるべき', () => {
    render(<Home />);
    expect(
      screen.getByText('TenkaCloud - The Open Cloud Battle Arena')
    ).toBeInTheDocument();
  });
});
