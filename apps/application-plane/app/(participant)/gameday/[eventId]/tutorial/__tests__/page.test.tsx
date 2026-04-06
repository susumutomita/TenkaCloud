import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TutorialPage from '../page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/hooks/use-gameday-session', () => ({
  useGamedaySession: () => ({
    eventId: 'ev-1',
    teamId: 'team-1',
    teamName: 'TeamAlpha',
  }),
}));

describe('TutorialPage', () => {
  it('ページタイトルを表示すべき', () => {
    render(<TutorialPage />);
    expect(screen.getByText('ルール & チュートリアル')).toBeInTheDocument();
  });

  it('スコアリングテーブルを表示すべき', () => {
    render(<TutorialPage />);
    expect(screen.getByText('10,000')).toBeInTheDocument();
    expect(screen.getByText('+1,000')).toBeInTheDocument();
    expect(screen.getByText('-3,000')).toBeInTheDocument();
    expect(screen.getByText('+1,500')).toBeInTheDocument();
    expect(screen.getByText('+200')).toBeInTheDocument();
  });

  it('ステップバイステップガイドを表示すべき', () => {
    render(<TutorialPage />);
    expect(screen.getByText('Step 1')).toBeInTheDocument();
    expect(screen.getByText('Step 2')).toBeInTheDocument();
    expect(screen.getByText('Step 3')).toBeInTheDocument();
    expect(screen.getByText('Step 4')).toBeInTheDocument();
    expect(screen.getByText('Step 5')).toBeInTheDocument();
    expect(screen.getByText('Step 6')).toBeInTheDocument();
  });

  it('キーコンセプトを表示すべき', () => {
    render(<TutorialPage />);
    expect(screen.getByText('Cooldown')).toBeInTheDocument();
    expect(screen.getByText('Blackout')).toBeInTheDocument();
    expect(screen.getByText('Score Weight')).toBeInTheDocument();
    expect(screen.getByText('Alliance')).toBeInTheDocument();
  });

  it('ゲーム概要セクションを表示すべき', () => {
    render(<TutorialPage />);
    expect(screen.getByText('GameDay とは？')).toBeInTheDocument();
  });
});
