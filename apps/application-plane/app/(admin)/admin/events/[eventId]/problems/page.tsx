/**
 * Admin Event Problems Page
 *
 * Cloudscape Design System - イベントに紐づく問題の管理
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { AdminProblem } from '@/lib/api/admin-types';
import {
  addProblemToEvent,
  getEventProblems,
  getProblems,
  removeProblemFromEvent,
} from '@/lib/api/admin-problems';

function getDifficultyBadge(difficulty: string) {
  switch (difficulty) {
    case 'easy':
      return <Badge color="green">Easy</Badge>;
    case 'medium':
      return <Badge color="blue">Medium</Badge>;
    case 'hard':
      return <Badge color="red">Hard</Badge>;
    default:
      return <Badge>{difficulty}</Badge>;
  }
}

export default function AdminEventProblemsPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;

  const [problems, setProblems] = useState<AdminProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());

  const [showAddModal, setShowAddModal] = useState(false);
  const [allProblems, setAllProblems] = useState<AdminProblem[]>([]);
  const [addModalLoading, setAddModalLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  const fetchProblems = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getEventProblems(eventId);
      setProblems(data.problems);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '\u554f\u984c\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchProblems();
  }, [fetchProblems]);

  const handleRemove = async (problemId: string) => {
    setRemovingIds((prev) => new Set(prev).add(problemId));
    try {
      await removeProblemFromEvent(eventId, problemId);
      await fetchProblems();
    } catch {
      // Error handling
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(problemId);
        return next;
      });
    }
  };

  const handleOpenAddModal = async () => {
    setShowAddModal(true);
    setAddModalLoading(true);
    try {
      const data = await getProblems({ limit: 100 });
      const existingIds = new Set(problems.map((p) => p.id));
      setAllProblems(data.problems.filter((p) => !existingIds.has(p.id)));
    } catch {
      setAllProblems([]);
    } finally {
      setAddModalLoading(false);
    }
  };

  const handleAddProblem = async (problemId: string) => {
    setAddingId(problemId);
    try {
      await addProblemToEvent(eventId, problemId);
      setShowAddModal(false);
      await fetchProblems();
    } catch {
      // Error handling
    } finally {
      setAddingId(null);
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xl">
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" onClick={handleOpenAddModal}>
              {'\u554f\u984c\u3092\u8ffd\u52a0'}
            </Button>
            <Button onClick={() => router.push('/admin/problems/new')}>
              {'\u65b0\u898f\u554f\u984c\u4f5c\u6210'}
            </Button>
            <Button onClick={() => router.push(`/admin/events/${eventId}`)}>
              {'\u30a4\u30d9\u30f3\u30c8\u306b\u623b\u308b'}
            </Button>
          </SpaceBetween>
        }
      >
        {'\u554f\u984c\u7ba1\u7406'}
      </Header>

      {error && (
        <Container>
          <SpaceBetween size="m" direction="vertical" alignItems="center">
            <StatusIndicator type="error">{error}</StatusIndicator>
            <Button onClick={fetchProblems}>
              {'\u518d\u8aad\u307f\u8fbc\u307f'}
            </Button>
          </SpaceBetween>
        </Container>
      )}

      {!error && (
        <Table
          loading={loading}
          loadingText={'\u554f\u984c\u3092\u8aad\u307f\u8fbc\u307f\u4e2d...'}
          items={problems}
          header={
            <Header counter={`(${problems.length})`}>
              {'\u30a4\u30d9\u30f3\u30c8\u306e\u554f\u984c\u4e00\u89a7'}
            </Header>
          }
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="m">
                <Box variant="h3">
                  {
                    '\u554f\u984c\u304c\u307e\u3060\u3042\u308a\u307e\u305b\u3093'
                  }
                </Box>
                <Box color="text-body-secondary">
                  {
                    '\u554f\u984c\u3092\u8ffd\u52a0\u3057\u3066\u30a4\u30d9\u30f3\u30c8\u3092\u69cb\u6210\u3057\u307e\u3057\u3087\u3046\u3002'
                  }
                </Box>
                <Button variant="primary" onClick={handleOpenAddModal}>
                  {'\u554f\u984c\u3092\u8ffd\u52a0'}
                </Button>
              </SpaceBetween>
            </Box>
          }
          columnDefinitions={[
            {
              id: 'title',
              header: '\u30bf\u30a4\u30c8\u30eb',
              cell: (item) => <Box fontWeight="bold">{item.title}</Box>,
            },
            {
              id: 'category',
              header: '\u30ab\u30c6\u30b4\u30ea',
              cell: (item) => item.category,
            },
            {
              id: 'difficulty',
              header: '\u96e3\u6613\u5ea6',
              cell: (item) => getDifficultyBadge(item.difficulty),
            },
            {
              id: 'scoring',
              header: '\u914d\u70b9',
              cell: (item) => {
                const total = item.scoring.criteria.reduce(
                  (sum, c) => sum + c.maxPoints,
                  0,
                );
                return `${total} pts`;
              },
            },
            {
              id: 'actions',
              header: '\u30a2\u30af\u30b7\u30e7\u30f3',
              cell: (item) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="link"
                    onClick={() =>
                      router.push(`/admin/problems/${item.id}/edit`)
                    }
                  >
                    {'\u7de8\u96c6'}
                  </Button>
                  <Button
                    variant="link"
                    loading={removingIds.has(item.id)}
                    onClick={() => handleRemove(item.id)}
                  >
                    {'\u524a\u9664'}
                  </Button>
                </SpaceBetween>
              ),
            },
          ]}
        />
      )}

      {/* Add Problem Modal */}
      <Modal
        visible={showAddModal}
        onDismiss={() => setShowAddModal(false)}
        header={'\u554f\u984c\u3092\u9078\u629e'}
        size="large"
      >
        {addModalLoading ? (
          <Box textAlign="center" padding="l">
            <Spinner size="large" />
          </Box>
        ) : allProblems.length === 0 ? (
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <Box>
                {
                  '\u8ffd\u52a0\u53ef\u80fd\u306a\u554f\u984c\u304c\u3042\u308a\u307e\u305b\u3093'
                }
              </Box>
              <Button onClick={() => router.push('/admin/problems/new')}>
                {'\u65b0\u898f\u554f\u984c\u4f5c\u6210'}
              </Button>
            </SpaceBetween>
          </Box>
        ) : (
          <Table
            items={allProblems}
            columnDefinitions={[
              {
                id: 'title',
                header: '\u30bf\u30a4\u30c8\u30eb',
                cell: (item) => item.title,
              },
              {
                id: 'category',
                header: '\u30ab\u30c6\u30b4\u30ea',
                cell: (item) => item.category,
              },
              {
                id: 'difficulty',
                header: '\u96e3\u6613\u5ea6',
                cell: (item) => getDifficultyBadge(item.difficulty),
              },
              {
                id: 'add',
                header: '',
                cell: (item) => (
                  <Button
                    variant="primary"
                    loading={addingId === item.id}
                    onClick={() => handleAddProblem(item.id)}
                  >
                    {'\u8ffd\u52a0'}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </SpaceBetween>
  );
}
