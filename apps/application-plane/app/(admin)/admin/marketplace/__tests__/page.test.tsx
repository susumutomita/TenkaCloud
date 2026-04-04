import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProblem } from '@/lib/api/admin-types';
import AdminMarketplacePage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/tenant', () => ({ useTenantOptional: () => null }));

const mockGetProblems = vi.fn();
const mockGetProblem = vi.fn();
vi.mock('@/lib/api/admin-problems', () => ({
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
  getProblem: (...args: unknown[]) => mockGetProblem(...args),
}));

const baseProblem: AdminProblem = {
  id: 'prob-1',
  title: 'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
  type: 'gameday',
  category: 'security',
  difficulty: 'medium',
  description: {
    overview:
      'S3 \u30d0\u30b1\u30c3\u30c8\u306e\u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u3092\u5f37\u5316\u3059\u308b\u554f\u984c\u3067\u3059',
    objectives: [
      '\u30d1\u30d6\u30ea\u30c3\u30af\u30a2\u30af\u30bb\u30b9\u3092\u7121\u52b9\u5316',
      '\u6697\u53f7\u5316\u3092\u6709\u52b9\u5316',
    ],
    hints: [
      '\u30d0\u30b1\u30c3\u30c8\u30dd\u30ea\u30b7\u30fc\u3092\u78ba\u8a8d',
    ],
    prerequisites: ['AWS \u306e\u57fa\u672c\u77e5\u8b58'],
    estimatedTime: 45,
  },
  metadata: {
    author: '\u30c6\u30b9\u30c8\u592a\u90ce',
    version: '1.0.0',
    tags: ['s3', 'security', 'encryption'],
    createdAt: '2026-01-01T00:00:00Z',
  },
  deployment: {
    providers: ['aws'],
    timeout: 300,
    templates: { main: { type: 'cloudformation', path: '/templates/s3.yaml' } },
    regions: { aws: ['ap-northeast-1'] },
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/s3-check.ts',
    timeoutMinutes: 5,
    criteria: [
      {
        name: '\u30d1\u30d6\u30ea\u30c3\u30af\u30a2\u30af\u30bb\u30b9\u7121\u52b9\u5316',
        weight: 50,
        maxPoints: 50,
      },
      {
        name: '\u6697\u53f7\u5316\u6709\u52b9\u5316',
        description: 'SSE-S3 or SSE-KMS',
        weight: 50,
        maxPoints: 50,
      },
    ],
  },
  createdAt: '2026-01-01T00:00:00Z',
};
const problemsResponse = { problems: [baseProblem], total: 1 };

describe('Admin \u30de\u30fc\u30b1\u30c3\u30c8\u30d7\u30ec\u30a4\u30b9\u30da\u30fc\u30b8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('\u30d7\u30ec\u30d3\u30e5\u30fc\u30e2\u30fc\u30c0\u30eb', () => {
    it('\u30d7\u30ec\u30d3\u30e5\u30fc\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u554f\u984c\u8a73\u7d30\u30e2\u30fc\u30c0\u30eb\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      );
      await waitFor(() => {
        expect(screen.getByText('1.0.0')).toBeInTheDocument();
      });
    });

    it('\u30d7\u30ec\u30d3\u30e5\u30fc\u30e2\u30fc\u30c0\u30eb\u306b\u63a1\u70b9\u57fa\u6e96\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      );
      await waitFor(() => {
        expect(
          screen.getByText(
            '\u30d1\u30d6\u30ea\u30c3\u30af\u30a2\u30af\u30bb\u30b9\u7121\u52b9\u5316',
          ),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByText('\u6697\u53f7\u5316\u6709\u52b9\u5316'),
      ).toBeInTheDocument();
    });

    it('\u30d7\u30ec\u30d3\u30e5\u30fc\u30e2\u30fc\u30c0\u30eb\u306b\u30c7\u30d7\u30ed\u30a4\u60c5\u5831\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      );
      await waitFor(() => {
        expect(screen.getByText('cloudformation')).toBeInTheDocument();
      });
    });

    it('getProblem \u3067\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u3066\u3082\u30e2\u30fc\u30c0\u30eb\u306f\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockRejectedValue(new Error('Not found'));
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      );
      await waitFor(() => {
        expect(
          screen.getByText(
            '\u554f\u984c\u8a73\u7d30\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
          ),
        ).toBeInTheDocument();
      });
    });

    it('\u30d7\u30ec\u30d3\u30e5\u30fc\u30e2\u30fc\u30c0\u30eb\u306b\u76ee\u6a19\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      );
      await waitFor(() => {
        expect(
          screen.getByText(
            '\u30d1\u30d6\u30ea\u30c3\u30af\u30a2\u30af\u30bb\u30b9\u3092\u7121\u52b9\u5316',
          ),
        ).toBeInTheDocument();
      });
    });
  });

  describe('\u30a4\u30d9\u30f3\u30c8\u306b\u8ffd\u52a0\u30e2\u30fc\u30c0\u30eb', () => {
    it('\u30a4\u30d9\u30f3\u30c8\u53d6\u5f97\u30a8\u30e9\u30fc\u6642\u306f\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Failed' }),
      });
      vi.stubGlobal('fetch', mockFetch);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole('button', {
          name: '\u30a4\u30d9\u30f3\u30c8\u306b\u8ffd\u52a0',
        }),
      );
      await waitFor(() => {
        expect(
          screen.getByText(
            '\u30a4\u30d9\u30f3\u30c8\u4e00\u89a7\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
          ),
        ).toBeInTheDocument();
      });
    });
  });

  describe('\u30dc\u30bf\u30f3\u306e\u72b6\u614b', () => {
    it('\u30d7\u30ec\u30d3\u30e5\u30fc\u30dc\u30bf\u30f3\u304c\u6709\u52b9\u3067\u3042\u308b\u3079\u304d', async () => {
      mockGetProblems.mockResolvedValue(problemsResponse);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc' }),
      ).not.toBeDisabled();
    });

    it('\u30a4\u30d9\u30f3\u30c8\u306b\u8ffd\u52a0\u30dc\u30bf\u30f3\u304c\u6709\u52b9\u3067\u3042\u308b\u3079\u304d', async () => {
      mockGetProblems.mockResolvedValue(problemsResponse);
      render(<AdminMarketplacePage />);
      await waitFor(() => {
        expect(
          screen.getByText(
            'S3 \u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u8a2d\u5b9a',
          ),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole('button', {
          name: '\u30a4\u30d9\u30f3\u30c8\u306b\u8ffd\u52a0',
        }),
      ).not.toBeDisabled();
    });
  });
});
